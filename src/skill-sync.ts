import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AcontextGateway, AcontextSkill } from "./contracts.js";

interface ActivePointer {
  path: string;
  learningSpaceId: string;
  skillCount: number;
  updatedAt: string;
}

export interface SkillSyncResult {
  path: string;
  skillCount: number;
  skippedFiles: Array<{ skill: string; path: string; reason: string }>;
}

export interface LearningSpaceFingerprint {
  files: Record<string, string>;
  unavailable: Array<{ skill: string; path: string; reason: string }>;
}

export async function fingerprintLearningSpace(
  client: AcontextGateway,
  learningSpaceId: string,
): Promise<LearningSpaceFingerprint> {
  const files: Record<string, string> = {};
  const unavailable: LearningSpaceFingerprint["unavailable"] = [];
  const skills = await client.learningSpaces.listSkills(learningSpaceId);
  for (const skill of skills) {
    for (const file of skill.file_index) {
      try {
        const result = await client.skills.getFile({ skillId: skill.id, filePath: file.path });
        if (!result.content) {
          unavailable.push({ skill: skill.name, path: file.path, reason: "file is not available as inline text" });
          continue;
        }
        files[`${skill.id}:${file.path.replace(/\\/g, "/")}`] = createHash("sha256").update(result.content.raw).digest("hex");
      } catch (error) {
        unavailable.push({ skill: skill.name, path: file.path, reason: error instanceof Error ? error.message : String(error) });
      }
    }
  }
  return { files, unavailable };
}

export function changedSkillFiles(
  before: LearningSpaceFingerprint,
  after: LearningSpaceFingerprint,
): string[] {
  return Object.entries(after.files)
    .filter(([path, hash]) => before.files[path] !== hash)
    .map(([path]) => path)
    .sort();
}

function safeSegment(value: string): string {
  const normalized = value.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

export function resolveSafeRelativePath(root: string, untrustedPath: string): string {
  const normalized = untrustedPath.replace(/\\/g, "/");
  if (!normalized || normalized.includes("\0") || isAbsolute(normalized) || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`Unsafe skill path: ${untrustedPath}`);
  }
  const destination = resolve(root, normalized);
  const relativePath = relative(resolve(root), destination);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`Skill path escapes cache root: ${untrustedPath}`);
  }
  return destination;
}

function snapshotKey(skills: AcontextSkill[]): string {
  const input = skills
    .map((skill) => `${skill.id}:${skill.updated_at}`)
    .sort()
    .join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

export class SkillSynchronizer {
  constructor(
    private readonly client: AcontextGateway,
    private readonly cacheRoot: string,
    private readonly maxFileBytes = 1_000_000,
    private readonly includeNames?: readonly string[],
  ) {}

  private pointerPath(learningSpaceId: string): string {
    return join(this.cacheRoot, safeSegment(learningSpaceId), "active.json");
  }

  async loadActivePath(learningSpaceId: string): Promise<string | undefined> {
    try {
      const pointer = JSON.parse(await readFile(this.pointerPath(learningSpaceId), "utf8")) as ActivePointer;
      const activePath = resolve(pointer.path);
      resolveSafeRelativePath(this.cacheRoot, relative(this.cacheRoot, activePath));
      if (!(await stat(activePath)).isDirectory()) return undefined;
      return activePath;
    } catch {
      return undefined;
    }
  }

  async sync(learningSpaceId: string): Promise<SkillSyncResult> {
    const allSkills = await this.client.learningSpaces.listSkills(learningSpaceId);
    const included = this.includeNames?.length
      ? new Set(this.includeNames.map((name) => name.trim().toLowerCase()))
      : undefined;
    const skills = included
      ? allSkills.filter((skill) => included.has(skill.name.trim().toLowerCase()))
      : allSkills;
    if (included && skills.length === 0) {
      throw new Error(`No Acontext skills matched ACONTEXT_SKILL_INCLUDE: ${this.includeNames!.join(", ")}`);
    }
    const spaceRoot = join(this.cacheRoot, safeSegment(learningSpaceId));
    const finalPath = join(spaceRoot, `snapshot-${snapshotKey(skills)}`);

    try {
      if ((await stat(finalPath)).isDirectory()) {
        await this.writePointer(learningSpaceId, finalPath, skills.length);
        return { path: finalPath, skillCount: skills.length, skippedFiles: [] };
      }
    } catch {
      // Snapshot does not exist yet.
    }

    const stagingPath = join(spaceRoot, `.staging-${randomUUID()}`);
    await mkdir(stagingPath, { recursive: true });
    const skippedFiles: SkillSyncResult["skippedFiles"] = [];
    let downloadedSkillCount = 0;

    try {
      for (const skill of skills) {
        const skillDir = join(stagingPath, `${safeSegment(skill.name)}-${skill.id.slice(0, 8)}`);
        await mkdir(skillDir, { recursive: true });
        let hasSkillManifest = false;
        const learnedFiles: string[] = [];

        for (const file of skill.file_index) {
          const destination = resolveSafeRelativePath(skillDir, file.path);
          let result;
          try {
            result = await this.client.skills.getFile({ skillId: skill.id, filePath: file.path });
          } catch (error) {
            skippedFiles.push({
              skill: skill.name,
              path: file.path,
              reason: error instanceof Error ? error.message : String(error),
            });
            continue;
          }
          if (!result.content) {
            skippedFiles.push({ skill: skill.name, path: file.path, reason: "file is not available as inline text" });
            continue;
          }
          const bytes = Buffer.byteLength(result.content.raw, "utf8");
          if (bytes > this.maxFileBytes) {
            throw new Error(`Skill file exceeds ${this.maxFileBytes} bytes: ${skill.name}/${file.path}`);
          }
          await mkdir(dirname(destination), { recursive: true });
          await writeFile(destination, result.content.raw, "utf8");
          const normalizedPath = file.path.replace(/\\/g, "/");
          if (normalizedPath === "SKILL.md") {
            hasSkillManifest = true;
          } else if (normalizedPath.toLowerCase().endsWith(".md")) {
            learnedFiles.push(normalizedPath);
          }
        }

        if (!hasSkillManifest) {
          await rm(skillDir, { recursive: true, force: true });
          continue;
        }
        downloadedSkillCount += 1;
        if (learnedFiles.length > 0) {
          const manifestPath = join(skillDir, "SKILL.md");
          const manifest = await readFile(manifestPath, "utf8");
          const index = learnedFiles.sort().map((path) => `- [${path}](./${path})`).join("\n");
          await writeFile(
            manifestPath,
            `${manifest.trimEnd()}\n\n## Learned memory files\n\nRead the relevant files below before applying this skill:\n\n${index}\n`,
            "utf8",
          );
        }
      }

      if (downloadedSkillCount === 0) {
        throw new Error(`Acontext returned ${skills.length} skill records but no downloadable root SKILL.md files`);
      }

      await mkdir(spaceRoot, { recursive: true });
      await rename(stagingPath, finalPath);
      await this.writePointer(learningSpaceId, finalPath, downloadedSkillCount);
      return { path: finalPath, skillCount: downloadedSkillCount, skippedFiles };
    } catch (error) {
      await rm(stagingPath, { recursive: true, force: true });
      throw error;
    }
  }

  private async writePointer(learningSpaceId: string, activePath: string, skillCount: number): Promise<void> {
    const pointerPath = this.pointerPath(learningSpaceId);
    await mkdir(dirname(pointerPath), { recursive: true });
    const temporaryPath = join(dirname(pointerPath), `.${basename(pointerPath)}.${randomUUID()}.tmp`);
    const pointer: ActivePointer = {
      path: activePath,
      learningSpaceId,
      skillCount,
      updatedAt: new Date().toISOString(),
    };
    await writeFile(temporaryPath, `${JSON.stringify(pointer, null, 2)}\n`, "utf8");
    await rm(pointerPath, { force: true });
    await rename(temporaryPath, pointerPath);
  }
}

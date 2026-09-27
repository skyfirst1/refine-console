import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

const MAX_SKILL_FILE_BYTES = 1_000_000;
const EDITABLE_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".json", ".yaml", ".yml"]);

export interface ManagedSkillFile {
  path: string;
  bytes: number;
  updatedAt: string;
}

export interface ManagedSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  manifestPath: string;
  files: ManagedSkillFile[];
}

function skillKey(path: string): string {
  return createHash("sha256").update(resolve(path).toLowerCase()).digest("hex").slice(0, 20);
}

function frontmatterValue(markdown: string, name: string): string | undefined {
  const match = markdown.match(new RegExp(`^${name}:\\s*["']?([^\\r\\n"']+)["']?\\s*$`, "mi"));
  return match?.[1]?.trim();
}

function safeFilePath(directory: string, untrustedPath: string): string {
  if (!untrustedPath || untrustedPath.includes("\0")) throw new Error("Skill 文件路径无效");
  const destination = resolve(directory, untrustedPath.replace(/\\/g, "/"));
  const child = relative(resolve(directory), destination);
  if (child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) {
    throw new Error("Skill 文件路径超出允许范围");
  }
  if (!EDITABLE_EXTENSIONS.has(extname(destination).toLowerCase())) {
    throw new Error("仅允许编辑 Markdown、文本、JSON 和 YAML skill 文件");
  }
  return destination;
}

async function findSkillManifests(root: string): Promise<string[]> {
  const manifests: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (entries.some((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md")) {
      manifests.push(resolve(directory, entries.find((entry) => entry.isFile() && entry.name.toLowerCase() === "skill.md")!.name));
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(resolve(directory, entry.name));
    }
  };
  await visit(resolve(root));
  return manifests;
}

async function activeSnapshotRoots(root: string): Promise<string[]> {
  let entries;
  try {
    entries = await readdir(resolve(root), { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const active: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      const pointer = JSON.parse(await readFile(resolve(root, entry.name, "active.json"), "utf8")) as { path?: unknown };
      if (typeof pointer.path !== "string") continue;
      const path = resolve(pointer.path);
      const child = relative(resolve(root), path);
      if (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child)) active.push(path);
    } catch {
      // Ignore incomplete or stale pointers; a later sync can repair them.
    }
  }
  return active;
}

async function editableFiles(directory: string): Promise<ManagedSkillFile[]> {
  const files: ManagedSkillFile[] = [];
  const visit = async (current: string): Promise<void> => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = resolve(current, entry.name);
      if (entry.isDirectory() && !entry.name.startsWith(".")) await visit(path);
      else if (entry.isFile() && EDITABLE_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        const info = await stat(path);
        if (info.size <= MAX_SKILL_FILE_BYTES) {
          files.push({ path: relative(directory, path).replace(/\\/g, "/"), bytes: info.size, updatedAt: info.mtime.toISOString() });
        }
      }
    }
  };
  await visit(directory);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

export async function listManagedSkills(root: string): Promise<ManagedSkill[]> {
  const activeRoots = await activeSnapshotRoots(root);
  const manifests = activeRoots.length > 0
    ? (await Promise.all(activeRoots.map((path) => findSkillManifests(path)))).flat()
    : await findSkillManifests(root);
  const skills = await Promise.all(manifests.map(async (manifestPath) => {
    const markdown = await readFile(manifestPath, "utf8");
    const directory = dirname(manifestPath);
    return {
      key: skillKey(manifestPath),
      name: frontmatterValue(markdown, "name") ?? basename(directory),
      description: frontmatterValue(markdown, "description") ?? "",
      directory,
      manifestPath,
      files: await editableFiles(directory),
    };
  }));
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

export async function findManagedSkill(root: string, key: string): Promise<ManagedSkill> {
  const skill = (await listManagedSkills(root)).find((item) => item.key === key);
  if (!skill) throw new Error("Skill 不存在或已被新快照替换");
  return skill;
}

export async function readManagedSkillFile(root: string, key: string, file: string): Promise<{ skill: ManagedSkill; file: string; content: string; sha256: string }> {
  const skill = await findManagedSkill(root, key);
  const path = safeFilePath(skill.directory, file);
  const info = await stat(path);
  if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) throw new Error("Skill 文件不存在或超过 1 MB");
  const content = await readFile(path, "utf8");
  return { skill, file: relative(skill.directory, path).replace(/\\/g, "/"), content, sha256: createHash("sha256").update(content).digest("hex") };
}

export async function writeManagedSkillFile(root: string, key: string, file: string, content: string, expectedSha256: string): Promise<{ sha256: string }> {
  if (Buffer.byteLength(content, "utf8") > MAX_SKILL_FILE_BYTES) throw new Error("Skill 文件超过 1 MB");
  const current = await readManagedSkillFile(root, key, file);
  if (expectedSha256 && current.sha256 !== expectedSha256) throw new Error("Skill 文件已被其他操作修改，请刷新后重试");
  const path = safeFilePath(current.skill.directory, file);
  await writeFile(path, content, "utf8");
  return { sha256: createHash("sha256").update(content).digest("hex") };
}

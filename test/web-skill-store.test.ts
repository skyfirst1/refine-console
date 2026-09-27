import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { listManagedSkills, readManagedSkillFile, writeManagedSkillFile } from "../src/web-skill-store.js";

test("managed skill files stay inside the cache and use optimistic writes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skills-"));
  const skillDirectory = join(root, "space", "snapshot", "report-style");
  await mkdir(skillDirectory, { recursive: true });
  await writeFile(join(skillDirectory, "SKILL.md"), "---\nname: report-style\ndescription: concise reports\n---\n\n# Rules\n", "utf8");
  try {
    const skills = await listManagedSkills(root);
    assert.equal(skills.length, 1);
    assert.equal(skills[0]?.name, "report-style");
    const current = await readManagedSkillFile(root, skills[0]!.key, "SKILL.md");
    const saved = await writeManagedSkillFile(root, skills[0]!.key, "SKILL.md", `${current.content}\nUpdated.\n`, current.sha256);
    assert.notEqual(saved.sha256, current.sha256);
    await assert.rejects(
      () => writeManagedSkillFile(root, skills[0]!.key, "SKILL.md", "stale", current.sha256),
      /已被其他操作修改/,
    );
    await assert.rejects(() => readManagedSkillFile(root, skills[0]!.key, "..\\secret.md"), /超出允许范围/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

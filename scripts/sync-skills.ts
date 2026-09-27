import { parseArgs } from "node:util";
import { AcontextClient } from "@acontext/acontext";
import { SkillSynchronizer } from "../src/skill-sync.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    "space-id": { type: "string" },
    output: { type: "string" },
  },
});

const spaceId = values["space-id"] ?? positionals[0];
const output = values.output ?? positionals[1];
if (!spaceId || !output) {
  throw new Error("Usage: tsx scripts/sync-skills.ts --space-id <uuid> --output <directory>");
}

const client = new AcontextClient();
const synchronizer = new SkillSynchronizer(client, output);
const result = await synchronizer.sync(spaceId);
process.stdout.write(`${JSON.stringify({ learningSpaceId: spaceId, ...result }, null, 2)}\n`);

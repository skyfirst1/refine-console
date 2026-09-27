import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { AspectSet, ExpertAgentCallRecord } from "./refine-expert-pipeline.js";

export interface FrozenDocumentAspectSet {
  path: string; sha256: string;
  producerRecordPath: string; producerRecordSha256: string;
  producerInvocationPath: string; producerInvocationSha256: string;
}
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
export async function importDocumentAspectSet(ref: FrozenDocumentAspectSet, documentPath: string, descriptionPath: string, outputPath: string, expected: { provider: string; model: string; card: ExpertAgentCallRecord["card"] }, validate: (value: unknown, documentSha: string, descriptionSha: string) => AspectSet) {
  const checked = async (path: string, sha: string) => { const bytes = await readFile(path); if (digest(bytes) !== sha) throw Error("Frozen Document Aspect producer/artifact digest changed"); return bytes; };
  const bytes = await checked(ref.path, ref.sha256);
  const producer: ExpertAgentCallRecord = JSON.parse((await checked(ref.producerRecordPath, ref.producerRecordSha256)).toString("utf8"));
  const invocation = JSON.parse((await checked(ref.producerInvocationPath, ref.producerInvocationSha256)).toString("utf8"));
  const documentSha = digest(await readFile(documentPath)), descriptionSha = digest(await readFile(descriptionPath));
  const parsed = JSON.parse(bytes.toString("utf8"));
  if (parsed.sourceSha256 !== documentSha || parsed.descriptionSha256 !== descriptionSha) throw Error("Frozen Document Aspect does not match document/Description");
  if (!producer.taskId || !producer.stage.endsWith("document-aspect-extraction") || producer.provider !== expected.provider || producer.model !== expected.model || JSON.stringify(producer.card) !== JSON.stringify(expected.card)) throw Error("Frozen Document Aspect extraction configuration/schema differs");
  if (invocation.provider !== producer.provider || invocation.model !== producer.model || invocation.trace?.stage !== producer.stage || !invocation.prompt || !invocation.systemPrompt) throw Error("Frozen Document Aspect invocation provenance differs");
  if (!producer.attempts?.some(a => a.taskId === invocation.trace?.taskId && a.eventsPath === invocation.rawEventsPath)) throw Error("Frozen Document Aspect invocation is not a recorded producer attempt");
  if (!producer.inputArtifacts.some(a => a.sha256 === documentSha) || !producer.inputArtifacts.some(a => a.sha256 === descriptionSha) || !producer.outputArtifacts.some(a => a.sha256 === ref.sha256)) throw Error("Frozen Document Aspect is not an output of the declared input-bound producer");
  for (const artifact of [...producer.inputArtifacts, ...producer.outputArtifacts]) await checked(artifact.path, artifact.sha256);
  if (!producer.eventProvenance) throw Error("Frozen Document Aspect producer has no recorded public execution");
  await checked(producer.eventsPath, producer.eventProvenance.sha256);
  const set = validate({ aspects: parsed.aspects }, documentSha, descriptionSha);
  try { if (digest(await readFile(outputPath)) !== ref.sha256) throw Error("Local imported Document Aspect changed"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; await writeFile(outputPath, bytes, { flag: "wx" }); }
  return { set, provenance: { mode: "explicit-document-aspect-import" as const, methodVersion: "1", artifactSha256: ref.sha256, producerTaskId: producer.taskId, producerRecordSha256: ref.producerRecordSha256, producerInvocationSha256: ref.producerInvocationSha256, providerCalls: 0 } };
}

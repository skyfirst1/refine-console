# Optional Expert evidence isolation

The default extraction, matcher, alignment schema and score reducer are unchanged. These options support controlled experiments; neither stable reuse nor a larger evidence window proves evaluation correctness.

`runRefineExpertEvaluation.frozenDocumentAspectSet` imports an explicit artifact. It verifies the document and Description bytes, artifact digest, recorded producer call and invocation, extraction card/schema/configuration, original input/output artifacts, and public execution digest. The result reports `documentAspectImport.providerCalls = 0`; it does not invent an extraction call. A changed local import is rejected. Missing import evidence must not trigger regeneration of an existing frozen Gold.

`evidenceWindow` is opt-in. `mode: "quotes"` and `mode: "paragraphs"` use the same supplementary input structure and neutral instruction; the latter locates every existing Evidence quote in its original source. Whitespace normalization preserves original offsets. Matching is not semantic or fuzzy. Multiple Evidence entries are retained, repeated paragraphs are deduplicated, and paragraphs remain in source order.

Paragraph mode defaults to at most two paragraphs per side and 4,000 UTF-8 bytes across both sides. Ambiguous or missing quotes, cross-paragraph spans and exceeded limits make the whole pair unavailable before a model call. No tail, negation or pending condition is truncated to fit. Mapping and offsets are saved locally; model input receives the complete selected paragraph text with Evidence indices.

`matchDirection` can execute explicitly selected source IDs while retaining the full frozen source-set digest and complete target set. `runEvidenceAlignmentMode` evaluates one fixed pair and mode. These entry points permit local tests without running the complete Expert pipeline. A boolean result with an uncertainty rationale is not automatically a verified rejection; independent assessment must preserve unknown and distinguish insufficient evidence from a genuinely erroneous comparison.

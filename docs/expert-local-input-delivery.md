# Expert local input delivery

Matcher now supplies every candidate's `id`, `title` and `description`, plus matching direction. Evidence and set hashes stay in local provenance rather than model input. `matcherInputMode: "full-aspects-v1"` retains the previous input shape for controlled comparisons. Validators still resolve returned IDs against the original full sets; scoring is unchanged.

`localInputDelivery: "inline"` sends the same authorized local input contents directly through the existing Pi runner with `tools: "none"`. It applies to Matcher/Aligner only. Aligner keeps relevant Evidence and excludes Matcher rationale. The default transport remains `files`, and Extractor remains file based. Inline currently requires `maxCorrections: 0`; a failed output is preserved rather than starting a correction loop. It overrides only Card instructions about reading files, not judgment criteria.

Each completed/failed role records its delivery/projection contract. Recovered calls must match it; inline and projected Matcher cannot adopt unbound cached raw output. Callers that maintain outer content caches must also include these options (or `expertLocalInputContract`) in their producer key. Local input files remain hashed provenance; empty `readPaths` on inline calls are not fabricated file reads. Pi separately verifies delivery in the public user message.

The four-case pilot uses the real role entry points, current identical Cards/model, and fresh outputs in both arms. Matcher changes both projection and transport; Aligner changes transport only. Single-run costs are observations, not a prediction or proof of quality equivalence. The pilot does not resume the stopped historical evaluation.

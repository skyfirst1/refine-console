# Expert expression and evidence compatibility

The current Expert keeps its local 12-Aspect limit, directional matching, content/style rules and deterministic reducer. Three changes follow the relevant interfaces in `validation/expert-source/expert_score/aspects/extraction.py` and `matching/match.py`: an Aspect may carry multiple relevant original sentences; Matcher/Aligner reasons have no fixed 80-character or quotation prohibition; Aligner does not receive the Matcher's rationale.

The optional `evidence_citation` field accepts a non-empty string or array of non-empty strings. Legacy outputs without it remain valid. JSON escaping remains necessary. This optional extension is local; it is not claimed to be an official upstream field. No boolean is derived from rationale, and no citation is required to pass validation. Original output files retain citations without affecting score reduction.

Both Card and stage prompts use the updated expression contract. A final contract notice takes precedence over conflicting historical Profile expression restrictions; it does not remove unrelated Profile behavior or change task scoring criteria. Matcher rationale remains in Matcher output and call provenance, but is omitted from the generated Aligner pair file.

The rerun uses a new producer binding and per-node checkpoints. Old documents, Description and Gold bytes are reusable inputs; old model-produced AspectSets and judgments are not new-version results. Equivalent current-version extraction inputs may share a result, and completed match/pair nodes may be reused only under the frozen producer/configuration binding. Original runs stay intact. Scores across historical configurations are observations, not a controlled estimate of these three changes.

The local adaptation does not copy upstream input truncation, quote stripping or its retry budget. Evidence still comes from the evaluated document, not the Description. Neither relaxed reason length nor more evidence guarantees semantic correctness.

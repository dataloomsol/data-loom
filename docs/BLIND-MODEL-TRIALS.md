# Blind Model Trials

Marketplace → Blind Model Trials supports private JSON benchmarks with 5–20 cases. Each case contains `prompt`, `expectedAnswer`, and optional `category`. Every category needs at least five cases. Use the dedicated upload form, keep public metadata free of test cases, and authorize evaluation separately from file sales. Disabling the benchmark stops new preparations; previously prepared purchases remain payable.

Two distinct allowlisted Phala models run the same prompts. The inference adapter receives no reference answers. The protected evaluator applies NFKC Unicode normalization, case folding and collapsed whitespace before exact string comparison. This is intentionally not semantic grading. Aggregate category scores, totals, latency including verification, and per-response verification receipts form the scorecard. Raw cases and model responses are omitted. Statistical disclosure is still possible; no differential privacy or formal non-extraction guarantee is claimed.

The scorecard is encrypted before an atomic mainnet USDC payment is prepared. Only its authenticated buyer can unlock it after exact-message finalized settlement. 70% goes directly to the contributor and 30% to the platform. Failed inference/verification produces no payment. Preparations run asynchronously and survive browser navigation; a VM restart marks interrupted jobs failed. Persistent limits permit one preparation per buyer/day and twenty per benchmark/day, including failed attempts.

Payment recovery verifies a supplied signature. Before refreshing an expired transaction, finalized wallet history must establish that it was not paid; otherwise recovery fails closed. Never submit a second payment if the wallet already returned a signature.

`blindModelTrials` in `/api/status` requires approved protected host readiness and fresh startup inference receipts from both advertised models. Ordinary confidential queries remain independently gated. No conventional inference fallback is used.

Tests cover scoring, no reference-key transmission, failed verification, private scorecard access, ownership, settlement rejection, payouts and offer disabling. Live wallet payment has not been executed by the agent.

## Verified live release

Release v15 is live on https://dataloom.live/#marketplace. Advertised models are `qwen/qwen3.8-27b` and `qwen/qwen-2.5-7b-instruct`. Both passed fresh inference receipt checks; the five-case synthetic comparison produced ten verified receipts. No real payment was sent. All 21 automated tests passed. Desktop/mobile browser checks found no page errors or horizontal overflow.

Approved compose: `1e5b894a11f99d9603a87e6b00c28d98df14a276683ad29b24ecbfb73e5947fd`. Fresh host and OS verification passed before approval. Status confirmed `blindModelTrials=true`, `confidentialQueries=true`, and no blockers.

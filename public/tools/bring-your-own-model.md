# Bring Your Own Model

Run a JSON linear text classifier against a contributor-approved private benchmark. Model execution and scoring take place in the attested Data Loom runtime. Only the buyer receives the aggregate scorecard and host quote. Data Loom discards the uploaded weights after the request and stores the resulting scorecard in encrypted storage.

## Contributor and buyer workflow

1. The contributor saves a private benchmark with 10–20 distinct prompts and reference answers, then grants a specific wallet access to one scorecard for that version.
2. The buyer signs in, opens **Account → Manage tools and grants → Bring Your Own Model**, and submits a classifier JSON file with the benchmark dataset ID.
3. Data Loom reports an accuracy band in 20-percentage-point increments. The scorecard contains no prompts, answer keys, individual predictions, category breakdowns, or weights. One run per wallet and five overall per benchmark version limit repeated probing.
4. The buyer can retrieve a completed scorecard using the same wallet. Revoking a grant stops a new run. A previously issued scorecard stays available to the buyer.

Select a benchmark whose reference answers match the classifier's output labels. The first version supports bounded linear classifiers only. There is no payment step.

## Classifier format

```json
{
  "format": "linear-text-v1",
  "vocabulary": ["valid", "expired"],
  "classes": [
    {"label": "allow", "bias": 0, "weights": [2, -2]},
    {"label": "deny", "bias": 0, "weights": [-2, 2]}
  ]
}
```

Data Loom normalizes the prompt, counts ASCII alphanumeric vocabulary tokens, and evaluates the dot product plus bias for each class. The first highest-scoring label wins ties. Expected answers are used only in exact-match scoring after normalization.

## API and quote verification

Wallet-authenticated write requests must use the application origin.

- `GET /api/byom/status` reports runtime readiness and supported formats.
- `POST /api/byom/grants` takes `{dataset, buyer, enabled, consent:true}`.
- `GET /api/byom/benchmarks` lists the buyer's approved benchmark versions.
- `POST /api/byom/runs` takes `{dataset, model, nonce, consent:true}`. Use a fresh 32-byte nonce encoded as lowercase hex. A retry with the same model returns the saved scorecard and its original nonce.
- `GET /api/byom/scorecards/{dataset}` retrieves the buyer's stored scorecard.

Download the scorecard and quote. Compute SHA-256 over the UTF-8 bytes of `JSON.stringify(scorecard)` in the returned field order and compare it with `attestation.reportData`. Independently verify the quote against the expected Data Loom app and approved host measurement. The report data must begin with the computed digest followed by zero padding. Compare the scorecard nonce with the one you supplied. The quote binds the scorecard to the host, while the scorecard binds the result to the submitted model digest and benchmark commitment.

# Private Data Validation

Check a private JSON dataset in Data Loom's attested runtime. The owner can download and share a report that contains the validation rule, pass/fail result, dataset version commitment, time and nonce. The report contains no source rows, field values, failing row references or failure counts.

## Run a check

Open **Account → Manage tools and grants → Private Data Validation** and use an owned, unpaused private dataset with 1–10,000 JSON objects. Select one check.

- **Required field** passes when every row has the named field with a nonblank string, a finite number or a boolean. Objects, arrays, null and missing fields fail.
- **Date range** passes when every row has a valid date in `YYYY-MM-DD` format within the inclusive range.

The report attests to the specified check on one version. The required-field rule checks presence and value type. It does not verify whether a value is authentic or accurate.

The status endpoint is `GET /api/private-validation/status`. The wallet-authenticated endpoint is `POST /api/my/private-validation`. Use a same-origin session and send `{dataset, rule, nonce, consent:true}`, with a fresh 32-byte nonce encoded as lowercase hex. For example, `rule` could be `{"type":"required-field","field":"purchaseOrder"}` or `{"type":"date-range","field":"invoiceDate","from":"2026-01-01","to":"2026-12-31"}`.

## Verify a report

Compute SHA-256 over the UTF-8 bytes of `JSON.stringify(report)` in the returned field order and compare it with `attestation.reportData`. Independently verify the quote in `attestation.quote` against the expected Data Loom app and approved host measurement. The quote report data must contain the digest followed by zero padding. For a freshness challenge, ask the contributor to use a nonce you generated and verify that nonce in the report. Confirm that the version commitment and rule match the ones you agreed to check.

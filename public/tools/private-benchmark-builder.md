# Private Benchmark Builder

Prepare a private evaluation set from a contributor-owned JSON dataset without deploying a Solana program, creating a vault or moving funds. It uses Data Loom's existing backend and encrypted storage. Normal storage and hosting costs still apply.

## Contributor workflow

Account → Manage tools and grants → Private Benchmark Builder.

1. Choose an active private dataset containing a JSON array (up to 10,000 records, subject to the existing dataset upload limit).
2. Map the prompt, expected-answer and category fields. Choose text, numeric, boolean or choice answer validation. Choice format requires 2–20 distinct choices. Missing category values default to General.
3. Optionally select up to four categories. Each selected category must have at least five distinct valid prompts. Select a maximum of 5–20 cases.
4. Analyze the source. Review row-level validation issues, normalized duplicate prompts, conflicting reference answers and available/selected category counts. The report omits prompt and reference-answer text.
5. Choose equal category counts or retain additional available cases within the limit. Sampling follows source order deterministically; it is not random sampling and does not establish representativeness. Exact duplicates retain their first occurrence; conflicting answers block saving. Invalid rows in included categories must be corrected before saving.
6. Explicitly authorize saving a separate private evaluation dataset. Data Loom recomputes the report, checks the reviewed source commitment and configuration, and preserves the source license. The source dataset remains unchanged.
7. Refresh Account and enable the saved dataset's blind trial policy separately if desired. Saving never opts a dataset into paid access. Paid trials still require their existing verified-inference and payment readiness checks.

Checks validate structure and answer format, not the factual correctness of prompts or answer keys. Trials use the existing normalized exact-match scoring; numeric answers are canonicalized to strings (for example 1.0 becomes 1), and boolean answers use true/false strings.

## Private API

Wallet session authentication required:

- POST `/api/my/benchmark-builder/analyze`: `{dataset,config}` → source commitment, private aggregate report and review hash.
- POST `/api/my/benchmark-builder/save`: same dataset/config plus `{title,reportHash,consent:true}` → new private dataset ID and commitment. Source/configuration changes require fresh analysis. A matching version already stored by the owner is reported as a conflict for policy review.
- GET `/api/my/benchmark-builder/:id/report`: owner-only saved preparation report and source-version reference.

Config fields: `promptField`, `answerField`, `categoryField`, `answerFormat` (text/number/boolean/choice), `choices`, `categories`, `balance`, `maxCases`. Every build stays compatible with the current blind-trial parser: 5–20 cases and at least five per category. Tool-input mappings for Data Impact Trials are not added by this builder.

GET `/api/benchmark-builder/status` reports builder availability. It does not certify that paid benchmark execution is available.

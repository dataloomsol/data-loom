# Data Loom

Data Loom is a marketplace for licensing datasets, running confidential AI queries, and evaluating models on private data. Contributors can prepare and license their datasets. Buyers and agents can use eligible data through scoped access grants, paid queries, and model evaluations.

[Open Data Loom](https://dataloom.live/) · [Production status](https://dataloom.live/api/status) · [Release history](RELEASE-HISTORY.md)

The public Git history starts with a retrospective import on November 22, 2026. The release history records earlier deployment evidence and recovered source dates. The [GitHub commit history](https://github.com/dataloomsol/data-loom/commits/main/) shows the current source revisions.

## What you can do

| Workflow | Capabilities |
| --- | --- |
| **Prepare and license data** | Import and review data, redact sensitive content, and save encrypted dataset versions. Publish eligible versions under a research or commercial license. Use Private Dataset Diff to compare two owned JSON datasets by aggregate record, field, and category counts. |
| **Run confidential queries** | Submit questions against eligible datasets through the attested Phala inference path. The paid query market uses USDC on Solana mainnet. Use the [query market status](https://dataloom.live/api/query-market) to check readiness. |
| **Give agents scoped access** | Create [private inference tools](public/tools/private-inference-api.md) and grant access for a defined purpose and spend limit. Use [Private Data Rooms](public/tools/private-data-rooms.md) to group tools for a project, [Private Memory](public/tools/agent-memory.md) for permitted carry-forward context, and [Private Data Requests](public/tools/private-data-requests.md) to ask contributors for missing information. |
| **Build and run evaluations** | Use the [Private Benchmark Builder](public/tools/private-benchmark-builder.md) to validate JSON answer formats, flag duplicates, and balance categories. Run [blind model trials](docs/BLIND-MODEL-TRIALS.md), compare models in bake-offs, and track regressions with [release gates and regression watch](docs/MODEL-REGRESSION-WATCH.md). Saving a benchmark creates a private dataset. Paid trial access requires a separate opt-in. |
| **Package evidence** | Use [Private Evidence Packs](public/tools/private-evidence-packs.md) to group evidence from eligible verified paid decisions. |
| **Request new data** | Use [Private Data Escrow](public/tools/private-data-escrow.md) to specify delivery and acceptance criteria. Funding and settlement depend on a verified on-chain program. Check the [escrow status](https://dataloom.live/api/data-escrow/status) before relying on those steps. |

## Privacy and production readiness

- The browser reviews and redacts imports before saving. Review the redaction results before consenting to upload.
- The protected runtime derives its storage encryption key inside a Phala confidential VM. The Data Loom host and the inference gateway have separate attestation checks. Startup requires a verified receipt before confidential queries become available, and inference responses on the protected path are checked before delivery.
- Paid blind trials run separate readiness checks for their supported models. See [blind trial status](https://dataloom.live/api/blind-trials) and [Agent Tools status](https://dataloom.live/api/agent-tools/status) for the current production state.
- Dataset Diff is owner-scoped. It verifies both stored dataset commitments and returns counts without returning record contents, field names, or category labels.

See the [confidential deployment guide](docs/CONFIDENTIAL-DEPLOYMENT.md), [release packaging guide](deploy/README.md), and [mainnet readiness notes](docs/MAINNET-READINESS.md) for implementation and operational details.

## Run locally

Requires **Node.js 24 or newer** and npm.

```sh
npm ci
npm run dev
```

Open [http://127.0.0.1:9200](http://127.0.0.1:9200). With the default configuration, development uses local SQLite and encrypted file storage under `.data/`. Keep local data and keys out of Git. A wallet that supports the Solana Wallet Standard is needed to sign in and try account workflows. Local development runs without production credentials. Mainnet payments and attested inference require their production configuration.

```sh
npm test
npm run build
```

The build writes static assets to `dist/`. Express serves those assets with the API in production.

## Repository layout

| Path | Purpose |
| --- | --- |
| [`index.html`](index.html), [`app.js`](app.js), [`production.js`](production.js) | Web UI and production client integration |
| [`server.mjs`](server.mjs), [`backend/`](backend/) | Express API, wallet authentication, storage, access policies, payments, agent tools, and evaluation workflows |
| [`deploy/`](deploy/) | Confidential VM bootstrap, encrypted release packaging, and inference startup checks |
| [`programs/private-data-escrow/`](programs/private-data-escrow/) | Solana escrow program and program tests |
| [`public/tools/`](public/tools/), [`docs/`](docs/) | Tool reference and deployment documentation |
| [`tests/`](tests/) | Node.js test suite |

# Data Loom protected backend

Deployment application: 8565ca2295dfaf2802876459a03ddff65194b4eb
VM: 013ffb69-cef2-40fa-bc36-81f663547124

Architecture: the full web application and API execute on the confidential VM. Do not proxy plaintext upload/query requests through Vercel. Authentication, consent, and license records use SQLite on the VM's encrypted persistent volume; R2 holds AES-GCM encrypted objects. The new storage key is derived through the app-bound dstack KMS interface, not supplied by Vercel. Existing externally accessible keys are not represented as protected retroactively.

Inference uses loopback Private AI Proxy with reviewed gateway compose/app identity and an independently fetched KMS public key. Model requests require hardware-attested TEE and TCB plus verifier-derived GPU/OS evidence. Answers are buffered until receipt and upstream-session checks pass. There is no fallback to DeepSeek. This does not prove exact model weights, prevent all output inference, or eliminate trust in the app administrator's upgrade authority.

Host verification completed on 2026-11-02: fresh nonce, Intel TDX signature, semantic event-log replay, OS image and ACPI measurements passed independently through dstack-verifier. Production OS 0.5.12 reported UpToDate with no advisories. Evidence is saved in docs/verification/host-2026-11-02.json. Approved compose: c6207aa818634b4a5638baf3a7d7ba3c18d797b209cb1ecbf6994dfcdb0c95d5. A live gateway synthetic request also passed 12 checks with zero skips. Any release change requires a new host verification before approval.

Code artifacts are encrypted before public hosting. The measured compose pins the artifact's SHA256 and runtime image digest. Dependencies are installed from integrity-locked package-lock files. Never publish deploy/generated/*.env; these contain sealed-environment input secrets. No shell login or development OS is enabled.

The Vercel public root now redirects directly to the protected application. The former Vercel API returns410 and does not initialize storage or inference. Encrypted release artifacts remain hosted on Vercel. The old local preview is not the protected application.

Startup now performs a synthetic inference request and requires a verified receipt before serving HTTP. /api/status exposes its receipt ID only after release approval. No customer data is used in this check. Payments use Solana mainnet USDC, split 70% contributor / 30% platform. Buyback and burn are disabled. Wallets must approve actual transfers; deployment testing does not imply a funded purchase was executed.

Live entry: https://data-loom-vert.vercel.app/
Protected origin: https://8565ca2295dfaf2802876459a03ddff65194b4eb-9200.dstack-pha-prod5.phala.network/
Final startup receipt: rcpt-344eb3062d724a72a8980bb0
Final API status: listings=true, payments=true, confidentialQueries=true, blockers=[].
Provider routing failures were observed during a separate local test; affected requests fail closed before payment preparation. No real-money test transaction was sent.

Proof Pipeline UI release v6 deployed and re-attested; desktop navigation and mobile overflow checks passed.

Release v7: footer X link added, host reverified, paid confidential queries active.

## Recovery after footer deployment (2026-11-03)

The v10 deployment initially retained v9's approved compose hash. This was a deployment regression: a successful startup inference receipt would still leave the current host unapproved. Fresh host and OS verification passed for v10 (`1f08c470ea91fe64ef0442d617ce21771f153cea8499f825f41d18e1e1471649`), and the sealed approved-compose value was corrected.

Inference availability is a separate gate. Local strict proxy requests returned HTTP 412 (`session_not_accepted`) while an ordinary synthetic API request returned 200. Do not interpret a configured API key or host approval as proof of a verified inference response. No attestation requirements were removed. Model-specific session-audit experiments were not deployed.

Recovery confirmed: live startup verification passed with receipt `rcpt-2b20b62bf12dc7feed7eef33`; public status reports `confidentialQueries=true`, `payments=true`, and `blockers=[]`. This is a synthetic inference/startup check, not proof of a real paid customer transaction.

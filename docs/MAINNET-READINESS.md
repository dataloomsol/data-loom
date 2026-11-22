# Data Loom mainnet readiness

Platform fee recipient: GKFXhctEm8VQpejF7QK8hQptQmhS4rkj1hTehrXofoH5

Implemented: signed wallet sessions; local import/redaction/review; encrypted dataset storage; version commitments; dataset licenses; publication controls; atomic 70/30 mainnet USDC purchase preparation and simulation; exact finalized-transaction verification; authenticated licensed downloads; purchase recovery and earnings records; optional owner-consented AI queries.

No deployment transaction or purchase has been sent. Settlement uses existing Solana Token, Associated Token Account and Memo programs, not a newly deployed custom program. Eight automated tests pass; production frontend builds successfully. These checks are not an independent security audit.

## Remaining production dependencies

Deploy the supplied Docker service with managed PostgreSQL and private S3-compatible storage. Set variables from .env.example through hosting secrets. Generate and back up a 32-byte STORAGE_MASTER_KEY; losing it loses access to encrypted datasets. Configure APP_ORIGIN to the final HTTPS origin. A dedicated mainnet RPC is recommended. Configure an AI provider only if the optional external processing feature is wanted. No wallet private key is required.

Run scripts/preflight.mjs with production environment variables. Verify encrypted upload/download, backup restoration, wallet sign-in and a low-value end-to-end purchase before enabling public payments. ENABLE_LISTINGS and ENABLE_PAYMENTS default false.

Confidential paid queries remain unimplemented and disabled: this needs an attested protected-compute service, output-leakage controls and verified payout accounting. Existing server-side encryption does not conceal content from the server operator. Optional conventional AI requires explicit consent and is not confidential computing. No buyback or burn token is configured.

Managed-service integrations are included. Provider accounts, service credentials and billing have not been provisioned or purchased.

## November 2 query implementation update

Answer-only purchases are now implemented for a single explicitly opted-in dataset per query. The provider generates an answer before payment, output checks reject identifiers/long verbatim source passages, and the answer is encrypted until exact finalized payment is verified. Query purchases never create a raw-dataset download license. Contributor policies, prices, payment recovery, answer retrieval and separate earnings are included. Ten per-wallet/dataset/day preparation attempts are enforced using database quota slots; this is not Sybil resistance or a formal privacy guarantee.

Enable only after deployment/testing with ENABLE_QUERY_PAYMENTS=true and ENABLE_CONVENTIONAL_QUERY_PROCESSING=true, plus AI credentials. This mode permits server decryption and external AI processing, with explicit owner and buyer consent. It is not confidential processing.

Optional BUYBACK_WALLET changes query payments to70% contributor,15% platform,15% reserve. The transaction and terms snapshot disclose all recipients. Funds in that reserve are USDC, not proof of token repurchase or burning. Without this setting query payments are70/30.

Still requires engineering, not just secrets: a selected confidential-compute architecture with remotely verified measurements and key-release policy, encrypted source ingestion directly into protected compute, verifiable query receipts; a specified project-token mint, liquidity venue and bounded buyback/burn executor. No such system is represented as deployed. Do not enable confidential advertising before these are implemented and verified.

Required user inputs: production database/storage/RPC/hosting configuration; conventional AI account/model if desired; project-token mint and reserve public wallet if buybacks are wanted. Never provide wallet seed phrases or private keys in chat.

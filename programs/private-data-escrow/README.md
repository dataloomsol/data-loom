# Data Loom USDC escrow

The adapter is in `backend/escrow-chain.mjs`; HTTP workflow is in `backend/data-escrow.mjs`; Wallet Standard review/signing UI is in `data-escrow.js`. See `public/tools/private-data-escrow.md` for deployment requirements, verifier trust and custody rules.

Not deployed to mainnet. Do not send funds to the development program address.

Build: `cargo build-sbf --manifest-path programs/private-data-escrow/Cargo.toml -- --offline`

Contract tests: `python3 programs/private-data-escrow/tests/vault.py`

Complete HTTP/adapter/SBF test: `LOOM_ESCROW_SVM=1 npm test`

The verifier is fixed per request and signs through its wallet. Its signature is not cryptographic proof that quality criteria were evaluated. Production additionally requires an immutable, byte-pinned deployment. Finalizing immutability is permanent and requires deployment wallet approval.

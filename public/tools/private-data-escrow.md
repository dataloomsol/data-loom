# Private Data Escrow

The website adapter, wallet flows, deterministic evaluator and Solana USDC vault contract are implemented and tested together. Real funding requires the reviewed contract to be deployed on mainnet, made immutable, and configured with an independently checked binary pin and named verifier wallet. Check `/api/data-escrow/status`; `fundingEnabled:false` means no funding transactions are available. Local tests do not imply mainnet deployment.

## Workflow

1. The buyer names a contributor and fixes a price, license, deadline and measurable acceptance criteria. The terms include the program, verifier and platform identities. These cannot be changed later. Requests drafted before deployment must be recreated once a verified program is configured.
2. The contributor accepts the exact terms. The buyer initializes the USDC vault; the contributor then accepts it onchain. The buyer reviews and signs funding. All transactions are simulated before wallet approval; SOL fees and account rent are additional.
3. The contributor submits an owned, unpaused private JSON dataset after finalized funding. Data Loom evaluates row count, field types, completeness, exact duplicates and category counts. A failing dataset cannot produce a release transaction.
4. A passing submission is copied to an immutable encrypted snapshot with a report hash bound to its source version, accepted terms and request. Changing the original dataset cannot replace this snapshot.
5. The named verifier wallet requests a fresh evaluation of that snapshot, reviews the release transaction and signs. The contract splits 70% to the contributor and 30% to the platform. This is verifier-mediated escrow: the program checks the verifier's signature, not dataset quality or factual accuracy.
6. The buyer can download the licensed snapshot only after the finalized program state is released with the exact expected report hash. Source inputs are delivered only under this explicitly selected dataset license, unlike answer-only purchases. Contributor ownership remains unchanged; previously granted license rights cannot be recalled after delivery.
7. If release has not occurred by the deadline, the buyer can sign a refund without verifier approval. Before release no dataset is delivered. Use **Check finalized state** to reconcile interrupted transactions before taking another action; submitted signatures are saved in the browser.

## Permissions and checks

Only buyer, named contributor and configured verifier can access the request. Only the contributor can preflight or submit; only the buyer can fund, refund or download. Every onchain read validates account ownership, discriminator, request nonce, buyer, contributor, verifier, platform, amount, accepted terms, deadline and state. Funded vaults must have the correct mint, token program, authority and sufficient balance.

The runtime verifies mainnet genesis, USDC mint, the reviewed executable byte hash and size, and immutable upgrade authority before preparing transactions. Missing configuration, replaced binaries, changed terms or invalid vaults fail closed. Standard direct checkout is never substituted.

Quality checks measure structure and coverage, not factual accuracy, originality or fitness. The agreed verifier can authorize release onchain, so its trust is disclosed before acceptance. No backend verifier key or autonomous payout signer is stored; the verifier signs through Wallet Standard.

## Configuration and deployment

`DATA_ESCROW_PROGRAM`, `DATA_ESCROW_PROGRAM_HASH`, `DATA_ESCROW_PROGRAM_SIZE`, `DATA_ESCROW_VERIFIER`, existing `PLATFORM_WALLET` and `SOLANA_RPC_URL`. A production funding flag alone cannot bypass verification. Making a program immutable permanently removes upgrade capability; review the deployed binary and obtain the deployment wallet's approval first.

The current compiled contract's rent quote is saved locally in `/tmp/loom-escrow-deployment-quote.json`. No deployment wallet is configured and no deployment funds have been moved.

## Verification

`LOOM_ESCROW_SVM=1 npm test` runs the full application suite plus an HTTP → real adapter → compiled SBF integration test using a local LiteSVM JSON bridge. The bridge uses synthetic mainnet metadata and local test wallets; it never contacts mainnet or moves real funds.

`cargo build-sbf --manifest-path programs/private-data-escrow/Cargo.toml -- --offline`

`python3 programs/private-data-escrow/tests/vault.py` tests successful funding/release/refund, custody, signer and recipient constraints, deadlines and replay rejection. Requires Python solders with LiteSVM support.

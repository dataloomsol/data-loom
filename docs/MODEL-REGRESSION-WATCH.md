# Model Regression Watch

A buyer opens a paid Blind Model Trials scorecard and chooses **Watch this benchmark**. The watch stores that immutable dataset commitment, the original pair of model IDs, a daily or weekly cadence, a per-run price cap, and an accuracy-drop alert threshold in percentage points.

The confidential VM checks due watches every minute. It claims each scheduled interval persistently before preparing inference. Existing limits remain in force: one preparation per buyer per UTC day, twenty preparations per benchmark per UTC day, and no second prepared purchase for the same buyer/benchmark. A wallet can save at most three watches. If a run cannot start, its private notice explains the issue and the next interval is retained. There are no catch-up runs or automatic wallet transfers.

New runs require an enabled contributor policy, unpaused consent, the original dataset commitment and a price within the buyer's cap. Both the scheduler and trial preparation enforce the version and price guard. Failed inference never prepares checkout. Every response requires the existing Phala receipt checks.

A completed preparation appears in trial history and the watch. The buyer separately approves each USDC payment. Aggregate results and baseline comparisons remain inaccessible until finalized payment verification. Existing 70% contributor / 30% platform settlement applies without a new escrow or subscription contract.

Paid comparisons show model accuracy changes, category changes and an in-app regression alert if a model's accuracy drops by at least the chosen threshold. The baseline remains fixed; this is not a rolling comparison. Only matching scoring methods, model IDs, case counts, category counts and dataset commitments can be compared. No case prompts, reference answers or individual outputs are returned.

Buyers can pause, resume or remove a watch. Removing it preserves trial purchases and receipts. Contributor consent pauses prevent future preparations, while already prepared purchases and in-progress trials retain the existing consent semantics. Resume starts a fresh full cadence. Alerts appear in the application, with no email or push notifications.

Model IDs are provider routes, not independently proven weight-version identifiers. A later run can reflect stochastic variation or provider changes. The small exact-match benchmarks do not establish statistical significance or guarantee general model quality.

Validation includes access isolation, paid-baseline enforcement, hidden unpaid comparisons, scheduler claim idempotence, contributor pauses, price caps, buyer pauses, deletion and score deltas. Browser checks cover 1440px and 390px widths. No real-money purchase was performed during development.

Production verification passed on 2026-11-07. Trusted HTTPS served frontend `index-CgJmxnp2.js`. Fresh independent host/OS verification passed for compose `027aecf689fa71a7d6c00bf2358cfad661e22374cb0c67477e62b42f560e52b4`. The public watch endpoint reported enabled, with payments, conventional AI, confidential queries and Blind Model Trials all enabled. Fresh startup receipt: `rcpt-f16dba7805ecdb806cea9c66`. This verifies readiness, not a completed customer purchase.

# Proof of Exclusivity

Go to **Account → Manage tools and grants → Proof of Exclusivity**. The contributor selects an active draft with no prior purchase orders or licenses, enters a designated buyer's wallet, and chooses a permitted use, market, and time window. The saved dataset price is used. Reservation is permanent for that version and blocks ordinary marketplace sales and auctions, including after the license ends.

Share the offer ID privately with the buyer. They sign in, review the scope and price, and use the existing USDC checkout. Prepare checkout when ready to pay. Each offer supports one prepared checkout, with recovery for a submitted transaction through **Purchases & recovery**. Prepare it before the license starts. The licensed buyer can download during the agreed window. A downloaded copy cannot be recalled.

Once the license is recorded, the owner or buyer can open the attested proof JSON from the offer. Compare the report's dataset commitment, use, market, and window against the offer. Hash the UTF-8 bytes of `JSON.stringify(report)` in the returned field order with SHA-256 and compare to `attestation.reportData`. Verify the Phala quote against the approved Data Loom workload and confirm its report data contains that digest followed by zero padding. Buyers can also hash their license terms to match `termsDigest`.

The proof covers Data Loom's dataset download licenses for the exact committed version. It attests that exactly one such license appears in the ledger at the check time. It does not cover off-platform deals, other versions, controlled query access, or a buyer's conduct after download.

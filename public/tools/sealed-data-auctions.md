# Sealed Data Auctions

Open **Account → Manage tools and grants → Sealed Data Auctions**. A contributor can open an auction for an active draft version without existing purchase orders or licenses. Creation permanently reserves that version for the auction and publishes its preview, commitment, license type, reserve, license count and deadline to anyone with its auction ID.

Buyers can submit one final bid per wallet at or above the reserve through the protected runtime. Bid values are encrypted before database storage. Keep the receipt tag private if you want to keep your connection to a winning tag private. Bids do not move funds.

After the deadline, a signed-in user can finalize the result. The highest bids win up to the published license count. Earlier accepted bids break ties. The public result reports winning receipt tags in alphabetical order. Wallets, amounts and bid rankings stay out of the public result. Each winner can review and pay their own bid using the existing USDC checkout. A license is granted after payment verification. Unclaimed slots are not reassigned.

To verify the result, open the auction JSON, match the dataset commitment and rules, and hash the UTF-8 bytes of `JSON.stringify(result.report)` in the returned field order with SHA-256. Compare with `result.attestation.reportData`. Verify the Phala quote against the approved Data Loom app and host measurement, and check that its report data contains the digest followed by zero padding. Verification establishes which workload attested to the result. It does not give a public view of the bid set or independently expose the calculations.

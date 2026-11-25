# Proof of Data Coverage

Open **Account → Manage tools and grants → Proof of Data Coverage**. Choose an owned, unpaused private dataset version containing a JSON array of up to 10,000 objects. Enter the category field and minimums, then authorize publication and share the proof link with your buyer.

For example, select `region`, **10,000 categorized records** and **6 distinct categories**. Records count when their region is a nonblank string. Data Loom trims the value, normalizes Unicode to NFC and lowercases it when counting distinct categories. Repeated records count as records. The proof establishes that both minimums were met for the checked dataset version. It makes no claim about the accuracy of labels, unique records or balance across categories.

The link returns JSON containing the declared thresholds, category field, dataset version ID and commitment, evaluation time and attestation. It excludes exact observed totals, category values, salt and source records. Publishing again replaces the previous link for that version. Unpublishing or pausing the dataset makes the link unavailable. Copies already shared can still be read.

## Verify before buying

1. Match `report.datasetVersion` and `report.sourceCommitment` with the dataset version and commitment you intend to license. Confirm that the field and minimums match your agreement.
2. Compute SHA-256 over the UTF-8 bytes of `JSON.stringify(report)` in the returned field order and compare it with `attestation.reportData`.
3. Independently verify the Phala quote in `attestation.quote` against the expected Data Loom workload and approved host measurements. Its report data must contain the digest followed by zero padding. Check the live link for current availability.

The status endpoint is `GET /api/data-coverage/status`. To publish programmatically, send `{dataset,minRecords,categoryField,minCategories,consent:true}` to `POST /api/my/data-coverage` with an authenticated same-origin wallet session. To unpublish, use `DELETE /api/my/data-coverage/:dataset`.

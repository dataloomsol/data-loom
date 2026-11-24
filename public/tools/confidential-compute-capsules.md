# Confidential Compute Capsules

A contributor gives a named buyer permission to load a particular private dataset version inside an approved Phala dstack workload. The workload generates a fresh X25519 key pair. Data Loom verifies that the quote binds the public key to the grant, challenge, dataset commitment and approved measurements. The buyer relays the resulting ciphertext to the workload.

## Preparation

The contributor needs independently reviewed measurements for the buyer's workload: dstack app ID, compose hash and production OS image hash. Review the actual measured code and immutable image digests before granting access. The workload must generate and retain its private key inside the VM, control what results can leave the VM, and avoid accepting arbitrary code or logging plaintext. Attestation authenticates the measured workload. Its code determines how it uses the data.

An operator must configure an authenticated and approved local verifier inside Data Loom's protected runtime using `CAPSULE_VERIFIER_URL=http://127.0.0.1:<port>/verify`. Restrict access to that listener to the Data Loom workload. It accepts the dstack SDK quote response as JSON and verifies the quote, measured boot event log, production OS, ACPI tables and TCB. The API also requires Data Loom's own approved confidential runtime. `GET /api/compute-capsules/status` reports readiness.

## Transfer workflow

All writes use a Data Loom wallet session and the application origin.

1. The contributor calls `POST /api/compute-capsules/grants` with `{dataset, buyer, workload:{appId,composeHash,osImageHash},consent:true}` and shares the resulting grant ID with the buyer.
2. The buyer calls `POST /api/compute-capsules/grants/{id}/challenge` with an empty JSON object and relays the returned challenge into the approved VM.
3. In the reviewed workload, call `prepareCapsuleRecipient(challenge, new DstackClient('/var/run/dstack.sock'))` from [the Node.js recipient helper](compute-capsule-client.mjs). Keep the returned object in the VM. Relay only its `submission` object to the authenticated buyer.
4. The buyer posts that object to `POST /api/compute-capsules/release` and relays the encrypted capsule back into the same workload. Call `recipient.open(capsule)` inside the VM to authenticate and decrypt the payload, verify the original dataset commitment, and pass the data to the approved job. The helper has no plaintext download endpoint.
5. The contributor can revoke future releases with `POST /api/compute-capsules/grants/{id}/revoke`. A pause or version mismatch also prevents new releases. Revocation cannot recall a capsule already delivered to the approved workload.

Challenges expire after five minutes and are single-use. After a failed submission, get a fresh challenge and generate a new recipient key. This workflow uses scoped grants and has no payment step.

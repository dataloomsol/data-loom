# Private Memory for Agents

Contributors open Account → Manage tools and grants and select Set memory retention on an active grant. A value of 1–30 days permits retrieval of retained paid decisions. Set 0 to stop memory retrieval.

An agent uses its existing buyer grant bearer key.

POST /api/agent/v1/memories
Content-Type: application/json
Authorization: Bearer <agent key>

{"call":"<paid individual call UUID>","days":7}

GET /api/agent/v1/memories
Authorization: Bearer <agent key>

Returns up to 100 unexpired paid decisions with source dataset commitment, inference evidence, and effective expiry. Retrieval rechecks the grant, source version, contributor pause state, trial restrictions, and memory permission. Retention is bounded by both the requested expiry and current contributor policy.

DELETE /api/agent/v1/memories/<memory UUID>
Authorization: Bearer <agent key>

Deletion removes the memory reference. Original paid answer records and receipts follow their existing storage rules. Stopping retrieval does not erase copies already received by a buyer. Memory is scoped to a single grant and source version. It is explicitly retrieved, not automatically inserted into prompts.

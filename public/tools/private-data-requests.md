# Private Data Requests

An agent with an existing buyer grant can request missing information from that grant's contributor. Only the contributor and buyer can read the question. Contributor response content is withheld from the buyer until checkout is verified.

POST /api/agent/v1/data-requests
Authorization: Bearer <buyer agent key>
Content-Type: application/json

{"requestId":"<UUID>","question":"What additional evidence is required?","task":"Review this particular refund case."}

Requests expire after seven days. Maximum ten requests per grant per day. Reusing requestId with changed question or task is rejected. The request uses the tool's current USDC price.

Contributors open Account → Manage tools and grants → Private Data Requests. Submit a response and explicitly authorize use only for the stated task. Responses carry no training, publication or resale rights.

GET /api/agent/v1/data-requests/<request UUID>
Authorization: Bearer <buyer agent key>

POST /api/agent/v1/data-requests/<request UUID>/accept
Authorization: Bearer <buyer agent key>
Content-Type: application/json

{"accept":true,"version":0}

Returns a simulated Solana USDC checkout or the existing paymentPath on retry. The checkout reserves the tool price against the grant's shared spending cap. Buyer signs in its own wallet. Payment splits 70% to the contributor and 30% to the platform.

POST /api/agent/v1/calls/<request UUID>/confirm
Authorization: Bearer <buyer agent key>
Content-Type: application/json

{"signature":"<finalized Solana signature>"}

GET /api/agent/v1/calls/<request UUID> retrieves the result after verification. The output contains response and task. Provenance identifies a contributor response and its source commitment. Human replies have no inference receipt.

Expired checkout recovery uses POST /api/agent/v1/calls/<request UUID>/recover with an empty JSON object. An expired checkout requires a new request. Paid answers remain available through existing buyer history even if a grant is subsequently revoked. Consumers must enforce the task restriction on their own use of delivered information.

Question and response objects use Data Loom's encrypted storage. This feature sends no question or response to an AI provider and works independently of inference startup verification.

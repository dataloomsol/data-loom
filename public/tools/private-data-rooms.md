# Private Data Rooms for Agents

Rooms combine existing buyer grants for 2–10 distinct private datasets. A room does not create new contributor permissions. Each tool retains its contributor-approved purpose, input schema, dataset commitment, price, and grant cap.

Open Account → Manage tools and grants → Private Data Rooms for Agents. Choose your grants, project name, shared USDC cap, and expiry (1–30 days). The selected tool purposes become permitted tasks. Create or rotate a room key. Keep this key private.

POST /api/my/agent-rooms requires a signed-in buyer wallet:
{"name":"Support project","grants":["<grant UUID>","<grant UUID>"],"tasks":["<exact contributor-approved tool purpose>"],"cap":1000000,"days":7}
cap is integer micro-USDC.

GET /api/agent/v1/rooms
Authorization: Bearer loom_room_<key>

Returns the room and currently authorized tools. Source files remain unavailable through this interface.

POST /api/agent/v1/rooms/calls
Authorization: Bearer loom_room_<key>
Content-Type: application/json

{"grant":"<member grant UUID>","task":"<exact approved tool purpose>","requestId":"<new globally unique UUID>","input":{"age":14},"version":0}

Each call uses one member tool. Its price is reserved atomically against the shared room budget and against the existing grant budget. Different room keys cannot exceed the room cap through concurrent requests. New calls require verified confidential inference and payments. A successful preparation returns the existing simulated checkout and call ID, withholding the answer until payment verification.

The buyer signs the Solana USDC transaction in their wallet.

POST /api/agent/v1/rooms/calls/<call UUID>/confirm
Authorization: Bearer loom_room_<key>
Content-Type: application/json

{"signature":"<finalized Solana signature>"}

GET /api/agent/v1/rooms/calls/<call UUID>
Authorization: Bearer loom_room_<key>

Returns the paid decision and receipt after rechecking room expiry and contributor permissions. Each source retains its own receipt and version. Rooms do not merge raw datasets or run cross-source inference.

An expired unpaid checkout can be recovered through the existing POST /api/agent/v1/calls/<call UUID>/recover route with the buyer wallet session or underlying grant key. Then GET the room call to release its room reservation. The underlying grant's spending cap continues to apply to calls outside the room.

Room expiry or revocation blocks room-key access. Contributor revocation, a source pause, or a version change blocks use of that tool through the room. Buyer purchase history and previously delivered copies follow existing paid-answer rules.

GET /api/agent-rooms/status advertises room management separately from paid-call availability.

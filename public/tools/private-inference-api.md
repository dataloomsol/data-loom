# Data Loom Private Inference API for Agents

Create a tool in Account using a private dataset version. Choose a narrow purpose, input names and types, and the allowed decisions. Include an uncertainty decision such as `unknown`. Grant the buyer's Solana wallet access with a total USDC cap. The buyer signs in and creates an agent API key for that grant. Keep the key in the agent's secret store.

Each key authorizes one grant for one tool and dataset version. A call returns a decision, a short reason, and a Phala receipt after finalized payment. Avoid personal information in inputs. Keep prompts, payment signatures, and keys out of public logs.

Use `https://dataloom.live/api/agent/v1` as the base. Send `Authorization: Bearer $DATALOOM_AGENT_KEY`.

1. **GET /tool** returns the input and output JSON schemas, price in micro-USDC, and dataset commitment.
2. **POST /calls** accepts a client-generated UUID `requestId` and typed `input`. For example:

   ```json
   {"requestId":"56c2df86-4c7e-4c77-b24a-86a1bc482533","input":{"country":"US","order_age":14,"digital":false}}
   ```

   After audited inference, Data Loom returns the call ID, simulated transaction encoded in base64, payment summary and last valid block height. Reuse the same request ID when retrying the same input. One checkout at a time is allowed per grant.

3. Review the amounts and sign the transaction with the granted buyer wallet on Solana mainnet. Submit it and keep the signature. The wallet also pays network fees and any token account rent.
4. **POST /calls/{id}/confirm** with `{"signature":"..."}` verifies the exact finalized transaction and returns the paid result. **GET /calls/{id}** retrieves the same receipt later.
5. **POST /calls/{id}/recover** checks an unresolved checkout against finalized chain history. It either finds the payment, returns the still-valid checkout, or releases its reserved USDC allowance after proving expiry. Use a new request ID only for a new checkout.

Rotating a key invalidates the previous key. Revocation stops agent access, and pausing a dataset stops new inference. The buyer can still verify an existing payment or retrieve a paid result in Account after revocation.

## Private Batch Inference

A contributor can opt a grant into batch access. A batch accepts 2–200 JSON case objects for a single tool, with one order at the tool's unit price times the number of cases. The grant cap covers the full amount, and each buyer can prepare one batch per dataset per day. In Account, the buyer can upload a JSON array under **Private Batch Inference**, refresh its status, then review the wallet checkout and download the results.

For an API client, submit `POST /batches` with the same bearer key used for the tool.

```json
{"requestId":"b09f92b1-6966-4a97-bfc5-695a70670fb0","cases":[{"country":"US","order_age":14,"digital":false},{"country":"CA","order_age":40,"digital":false}]}
```

- **GET /batches/{id}** returns `running`, `failed`, `ready`, `prepared`, `paid`, or `cancelled`. Reuse the request ID when retrying the same submission.
- **POST /batches/{id}/checkout** prepares one simulated USDC transaction after every case has a verified receipt. Sign and submit it with the granted wallet, then send its signature to **POST /calls/{id}/confirm**.
- Retrieve the paid JSON via **GET /batches/{id}**. Each result includes its input row number, decision, reason, and evidence. The export omits the case inputs.
- Use **POST /calls/{id}/recover** to check an unresolved payment. Once a quote expires without a payment, you can prepare another quote for the same batch. **POST /batches/{id}/cancel** releases the reserved grant allowance for a ready batch without an active quote.

## Agent-to-Agent Delegation

Give the parent agent a buyer grant for the specialist’s private inference tool. Fetch the specialist’s manifest with `GET /api/agent/v1/tool` and construct the task input using only its declared fields. The server rejects undeclared fields.

Send `POST /api/agent/v1/delegations` with the specialist grant’s bearer key and a JSON body containing `requestId` (a UUID), `input` (the typed task fields), and `maxSpendMicros` (the maximum USDC in millionths, for example 250000 for 0.25 USDC). The specialist price must fit both the per-task cap and the remaining grant budget. Reuse the same request ID and body for retries.

The response includes the call ID and a simulated Solana checkout. The buyer wallet signs and submits the transaction. Submit its signature to `POST /api/agent/v1/calls/{id}/confirm`. After finalized payment verification, the parent receives the specialist’s typed decision, brief reason, and verified Phala inference evidence. Use the existing call status and recovery endpoints for interrupted checkouts.

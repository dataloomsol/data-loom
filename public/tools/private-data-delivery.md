# Private Data Delivery Webhooks

In **Account → Manage tools and grants → Private Data Delivery Webhooks**, a buyer subscribes using a licensed parent version ID, a minimum number of JSON object rows, and an optional field required in every row. Missing, null, and blank string values fail the required-field check. These checks cover structure and presence.

The contributor stores an update with the licensed version selected as its direct parent, then authorizes its release in the webhook tool. Each update can be released once. Set up subscriptions before release. Data Loom checks the source commitment and evaluates the buyer’s requirements inside the protected runtime. Passing events contain version and parent identifiers, commitments, license type, creation time and the passed criteria. They omit records, field values and exact observed counts. Licensing the update is a separate step.

## Configure a receiver

The deployment operator sets the sealed `DATA_DELIVERY_DESTINATIONS` JSON mapping from buyer wallet addresses to `{"url":"https://receiver.example/webhook","secret":"<random shared secret, at least 32 characters>"}`. Approve only trusted receivers controlled by the associated buyer. Data Loom accepts exact operator-configured HTTPS destinations and rejects redirects. Exchange each signing secret privately. The feature requires the approved confidential runtime.

Verify `X-Data-Loom-Signature` using HMAC-SHA256 over `X-Data-Loom-Timestamp + "." + raw request body`. Compare the full `sha256=<hex>` signature in constant time and reject stale timestamps. Use `Idempotency-Key` as the durable event ID and return a 2xx response after accepting it. Data Loom may send the same event again after timeouts or interrupted delivery. Retries use the original event ID and a fresh signature, with up to six attempts. Pausing either dataset, removing the subscription, or losing the parent license stops further attempts while the event is ineligible.

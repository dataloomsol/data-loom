# Private Aggregate API

Contributors can sell a fixed aggregate computed from one private JSON dataset version. Buyers browse and purchase approved offers through the API. The result gives access to the statistic under the stated terms. Source rows stay in the protected runtime.

## Contributor workflow

Save a private dataset containing a JSON array of up to 10,000 objects. Choose a statistic, specify its scope, and set its price in USDC millionths. Create the offer using `POST /api/private-aggregates/offers`.

```json
{
  "dataset": "<owned dataset version UUID>",
  "title": "Median delivery time",
  "price": 1000000,
  "consent": true,
  "specification": {
    "statistic": "median",
    "column": "deliveryDays",
    "lower": 0,
    "upper": 32,
    "filter": {"column": "region", "equals": "west"}
  }
}
```

- **Count** uses `{"statistic":"count"}` with an optional string equality filter.
- **Median** uses a numeric column, fixed lower and upper bounds, and an optional string equality filter. Numeric values are clamped to the bounds. The approximate median is the midpoint of one of 16 noisy histogram bins.
- **Trend** uses `{"statistic":"trend","column":"period","earlier":"2026-Q1","later":"2026-Q2"}`. The result compares noisy counts for two distinct groups in the same version.

Use `GET /api/private-aggregates/my-offers` to list your offers and `POST /api/private-aggregates/offers/{id}/retire` with an empty JSON object to stop new checkout quotes.

## Buyer workflow

1. Read `GET /api/private-aggregates/status` to see whether the protected runtime and checkout are enabled.
2. Sign in with a Data Loom wallet session and call `GET /api/private-aggregates/offers`. Review the fixed statistic, price and terms. A suppressed result may still be charged.
3. Send `{"requestId":"<unique UUID>","accept":true,"version":0}` to `POST /api/private-aggregates/offers/{id}/checkout`. Keep the request ID and returned order ID. Retry the same request ID to retrieve the same quote. Check the simulated transaction before signing and submitting it in your wallet.
4. Once finalized, send `{"signature":"<transaction signature>"}` to `POST /api/private-aggregates/orders/{id}/confirm`. A retry with the same signature can recover the order. If you submitted a transaction, confirm it before requesting another quote.
5. Fetch `GET /api/private-aggregates/orders/{id}/result` with the same wallet session. An available result is approximate. A suppressed result has only `{"status":"suppressed"}`.

Use same-origin requests for wallet-authenticated writes. Already prepared quotes can still settle when valid. Paid results remain retrievable after an offer retires.

## Privacy controls

- Buyers choose among contributor-defined offers. They cannot submit arbitrary filters, columns, or ranges.
- Each reported cohort must have at least 30 contributing rows and pass a second threshold of 60 after noise. Median eligibility counts numeric values only. Both groups in a trend must pass.
- The service stores one noisy result per dataset commitment and statistic configuration. Retries, relisting and different buyers receive that same result.
- Distinct configurations draw from a shared lifetime budget across buyers and dataset versions. Private SQL Exchange draws from the same budget. The current initial budget is 4,000 integer units, with 250 units charged for a new count or trend and 500 for a new median. Once exhausted, distinct configurations are unavailable.
- The hard threshold and repeated individuals in source data limit the privacy claims. These controls reduce repeated-query and small-cohort disclosure risks. They do not provide a formal person-level differential privacy guarantee.

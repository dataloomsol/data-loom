# Private Model Router

Open Marketplace → Blind Model Trials → Private Model Router. Choose a contributor-authorized benchmark, set a minimum exact-match accuracy for each category, and enter estimated USD per 1,000 requests for the three models. A category recommends the lowest-cost passing model, breaking price ties by accuracy and then model name. Categories with no passing model return no recommendation.

Each model gets the same prompts through the verified Phala inference adapter. The evaluator keeps reference answers inside the protected runtime. After finalized Solana USDC settlement, the authenticated buyer can see aggregate scores, verified receipts, and recommendations. The existing benchmark checkout pays the contributor 70%. Cost inputs rank models and do not affect checkout. Recommendations are based on this benchmark and do not change production traffic.

Set PRIVATE_ROUTER_THIRD_MODEL in the protected CVM environment to a distinct model supported by the approved Phala gateway. The startup verifier checks it with synthetic input after the two existing trial models pass. The API advertises three router models only after verification succeeds. Ordinary trials remain available if third-model verification is pending.

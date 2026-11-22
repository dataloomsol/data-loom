# Data Loom — UI review build

Selected monochrome archive concept, implemented as a standalone local application.

Run: `python3 -m http.server 9200 --bind 127.0.0.1`

Implemented: searchable sample directory, category filters, interactive message graph, local ChatGPT/Claude JSON and text imports, editable redaction review, explicit confirmation, reviewed JSON export, session-only archive, explicit injected Solana wallet picker.

No files are uploaded or persisted. Imported content is lost on reload. Automated redaction is heuristic and must be reviewed manually. Samples are illustrative. Wallet connection requests only a public address.

Not implemented in this UI milestone: persistent encrypted storage, buyer access delivery, Solana settlement program, USDC purchases, contributor payouts, license enforcement, AI quality scoring. The UI does not claim these are live or request money.

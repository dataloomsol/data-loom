# Private Evidence Packs

Create private reports linking buyer-written claims to previously paid, verified individual agent decisions. Packs contain dataset IDs and version commitments, contributor identity, payment signatures, inference receipts and contributor-approved decision/reason disclosure. They omit submitted inputs and raw dataset content. Claims and their relationship to evidence are buyer assertions; no automatic fact checking is performed. The manifest SHA-256 detects content changes when compared with a trusted original; it is not a signature or hardware attestation.

## Contributor permission

Account → Manage tools and grants → Set evidence disclosure. Set days (0–30; 0 blocks downloads) and maximum reason characters (0–2000; 0 means decision only). Disclosure is private inspection only, with no training, resale or publication rights. Downloaded copies cannot be recalled.

## Buyer report

In the same panel, enter a title, expiry and one `paid call UUID | claim` per line, up to 20. Create and download JSON. Save the pack ID to download again. Wallet-authenticated buyers can combine calls across their licensed sources; an individual agent key can only use calls from its own grant.

POST `/api/agent/v1/evidence-packs` with `{title,days,claims:[{claim,call}]}`. GET `/api/agent/v1/evidence-packs/:id`. Use an authenticated wallet session or `Authorization: Bearer loom_agent_…`.

Contributor policy: POST `/api/my/agent-grants/:id/evidence-policy` with `{days,maxReasonChars}` using the contributor wallet session.

Every download rechecks buyer ownership, grant scope and revocation, source availability and version, contributor disclosure permission and expiry. If any source fails, the entire download is denied. Shortening retention below a pack's original expiry invalidates that pack. Human data responses, batch calls and unpaid calls are excluded. Existing paid decisions can be packaged without running new inference. New paid decisions still require the confidential inference startup gate to be ready.

GET `/api/evidence-packs/status` reports deployment availability. No new payment or public sharing is introduced by packaging existing purchases.

# dataloom.live direct confidential ingress

Prepared 2026-11-02. The apex must resolve directly to the Phala gateway, not Vercel. Vercel continues hosting encrypted release artifacts and redirects www to the apex.

Namecheap records:
- ALIAS @ → gateway.dstack-pha-prod5.phala.network
- TXT _dstack-app-address → d694e0bd281d06f0cc6f5ce71726f3251b59b9c5:443
- Remove old apex A records 216.150.1.1 and 216.150.16.1.
- Keep www's Vercel CNAME for its canonical redirect.

Ingress: dstacktee/dstack-ingress:2.3@sha256:527c53523b9226782a11dbd800a3ff55e8a1f0b88e6224e8f7e4db7419769fbe. Uses tls-alpn-01, domain dataloom.live, target data-loom:9200, persistent certificate/evidence volumes. No DNS credentials supplied. TLS terminates within the same confidential VM. Published 2.3 image digest was checked against Docker Hub; upstream main README currently references an unavailable 2.8 image and was not used.

Compose 1b7fcc7a0c48c4346aab73984ae41aac436a8b2835099c0a4e8997c98c565952 passed nonce-bound quote verification and independent dstack-verifier OS/event-log/TCB checks. Sealed environment updated with this approval and APP_ORIGIN=https://dataloom.live.

Pending: remove conflicting DNS A records, certificate issuance, final browser and origin/auth verification. Do not claim custom-domain cutover complete until those checks pass. Existing Phala URL may load but mutations now require the canonical origin. Instance-specific TXT must be updated if the VM is replaced.

Diagnostic update 2026-11-02 15:55 UTC:
- Both TXT names now have the complete instance:443 value; apex only 66.220.6.105.
- www's Vercel project domain redirect explicitly set to dataloom.live (307).
- Added an ingress-only startup diagnostic log at /evidences/ingress-diagnostics.log, accessible via the Phala TLS passthrough hostname with diagnostic-only certificate bypass. This is not evidence of trusted custom-domain TLS. No app/customer query logs enabled.
- Registry-pinned ingress verifies DNS records, including ALIAS address matching and TXT, successfully. Let's Encrypt TLS-ALPN-01 fails with connection error: 66.220.6.105 Error getting validation data. Direct custom SNI resets while the Phala -443s hostname reaches the running ingress with a self-signed placeholder. Do not treat this as fixed.
- New compose 379b0aa53d86c6768663cdd7781325652b6f798140314646e70774453c810bc5 passed fresh host and independent OS verification. Sealed approval updated; app restarts to run its synthetic inference test.
- Active automation check-data-loom-https checks every 10 minutes and should notify only on readiness or actionable change. No additional DNS edits currently indicated. If custom routing continues failing after the negative TTL expires, investigate provider routing rather than repeat DNS edits or weaken confidential transport.

Resolved 2026-11-02 16:39 UTC: Let's Encrypt validation and certificate issuance succeeded at 16:33:53 UTC. Both apex and www verified over trusted HTTPS, final URL https://dataloom.live/, actual Data Loom Proof Pipeline content returned. Canonical /api/status reports payments=true, confidentialQueries=true, blockers=[]. Readiness monitoring removed after success. Earlier gateway failure cleared; failed authorizations had temporarily caused ACME rate limiting before successful issuance.

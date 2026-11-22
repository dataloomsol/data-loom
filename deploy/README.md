# Confidential runtime packaging

This packaging is preparatory, not evidence of a live or verified confidential deployment.

1. Build the current frontend with `npm run build`.
2. Select/review the Phala gateway compose measurement. Do not copy an unverified live measurement into the allowlist merely to bypass a failure.
3. Run `node deploy/pack-release.mjs https://IMMUTABLE_HOST/releases/loom.bin`.
4. Upload only `deploy/generated/loom.bin` to that HTTPS location. It contains an authenticated encrypted source archive; the decryption key is in `deploy/generated/release.env` and MUST NOT be published.
5. Deploy the generated Compose document with the release key and application credentials as sealed Phala environment variables. Use production/non-debug OS and private logs. Set APP_ORIGIN to the direct CVM HTTPS URL.
6. Verify the CVM measurements, provider policy, inference receipt audits and synthetic upload/query test before public activation.

Generated artifacts are ignored within deploy/. Regenerate after final code changes. A fresh build changes the encrypted artifact and pinned digest. Packaging pins the Node image by digest and npm dependencies by lockfile integrity; runtime installation must succeed, never silently fall back.

The full app is served directly from the CVM so Vercel does not handle plaintext uploads or answers. Moving an unchanged server key into a CVM does not remove prior operator knowledge: migrate to a newly protected key and remove obsolete Vercel decryptor credentials after validation. Enclave-derived key policy and deployment-update authority remain separate security requirements.

No GPU needs to be rented by this packaging: inference uses the verified Phala gateway through PAP. The proxy is loopback-only and requires a reviewed compose measurement plus hardware-proven TEE claim. Answer delivery must still wait for receipt audit in the backend adapter.

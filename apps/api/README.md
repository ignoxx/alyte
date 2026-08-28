# Alyte API foundation

This is the local development shell for the HTTP admission API and job-runner entrypoint. The
hosted backend environment is `production` only; there is no persistent staging service. Local
development binds to `127.0.0.1` and stores no health payloads.

The identity slice is available under `/v2` for Apple exchange and `/v1` for the remaining
session routes: exchange an Apple identity token plus its one-time raw nonce at
`POST /v2/auth/apple/exchange`, rotate at `POST /v1/auth/refresh`, sign out at
`POST /v1/auth/sign-out`, export app-controlled account metadata at `GET /v1/account/export`,
and delete the cloud account at `DELETE /v1/account`. Every mutating endpoint requires an
operation-scoped `Idempotency-Key` header (the JSON `idempotencyKey` fallback is intended for
trusted internal callers). Access tokens use `Authorization: Bearer`; refresh secrets are opaque
and never returned by export. Apple exchange requires the disclosed `consentPolicyVersion` and a
fresh 32-character raw nonce. Apple receives only its SHA-256 digest; Alyte retains only keyed
digests for bounded replay prevention and never stores the raw nonce or identity token. The
backend-only Cloud Request admission frontier accepts bounded non-health metadata at
`POST /v1/cloud-requests`, exposes owner-only status at `GET /v1/cloud-requests/{requestId}`, and
supports pre-upload cancellation at `POST /v1/cloud-requests/{requestId}/cancel`. Cloud requests retain only keyed idempotency/fingerprint digests and
canonical device-key metadata; no media, filenames, OCR, Measurements, intake content, prompts,
or model output enter this path. The former
`/v1/auth/apple` routes reject with `auth_contract_version_unsupported`.

For local development, SQLite defaults to `$TMPDIR/alyte-api/alyte.sqlite`; its stable session-hash
secret is created as `.alyte-session-hash-secret` in that same runtime directory. Set
`ALYTE_RUNTIME_PATH` to choose another runtime directory. Production requires an explicit persistent
`ALYTE_RUNTIME_PATH`, `APPLE_AUDIENCE` (or `APPLE_BUNDLE_ID`), and a 32-byte-or-longer
`ALYTE_SESSION_HASH_SECRET`.

# Alyte API foundation

This is the local development shell for the HTTP admission API and job-runner entrypoint. The
hosted backend environment is `production` only; there is no persistent staging service. Local
development binds to `127.0.0.1` and stores no health payloads.

The identity slice is available under `/v1`: exchange an Apple identity token at
`POST /v1/auth/apple/exchange`, rotate at `POST /v1/auth/refresh`, sign out at
`POST /v1/auth/sign-out`, export app-controlled account metadata at `GET /v1/account/export`,
and delete the cloud account at `DELETE /v1/account`. Every mutating endpoint requires an
operation-scoped `Idempotency-Key` header (the JSON `idempotencyKey` fallback is intended for
trusted internal callers). Access tokens use `Authorization: Bearer`; refresh secrets are opaque
and never returned by export. Apple exchange also requires the disclosed `consentPolicyVersion`.

For local development, SQLite defaults to `$TMPDIR/alyte-api/alyte.sqlite`; its stable session-hash
secret is created as `.alyte-session-hash-secret` in that same runtime directory. Set
`ALYTE_RUNTIME_PATH` to choose another runtime directory. Production requires an explicit persistent
`ALYTE_RUNTIME_PATH`, `APPLE_AUDIENCE` (or `APPLE_BUNDLE_ID`), and a 32-byte-or-longer
`ALYTE_SESSION_HASH_SECRET`.

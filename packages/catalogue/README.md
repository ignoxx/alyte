# Catalogue artifact workflow

The source modules under `src/` are reviewed-data build inputs. `src/generated/catalogue-artifact.ts`
is emitted by the deterministic build and is the only catalogue entry list consumed by the package
exports. The generated file is intentionally checked in so an offline/mobile build has one typed,
build-verified input; regenerate it when source content changes:

```sh
npm run catalogue:build --workspace=@alyte/catalogue
```

The default development artifact may be unsigned and review-pending. That state is explicit in its
manifest. Production/release consumers must call
`validateCatalogueArtifact` with `environment: 'production'` or `'release'` and configured trusted
public keys; those policies require both a trusted signature and an approved publication manifest.
They never silently fall back to the development artifact.

## Offline signing

Signing is integrity provenance only. It does not change `review`, `reviewedAt`, reviewer identity,
or publication status. The signer reads private material once from a protected CI secret environment,
stdin, or an already-open file descriptor; it never logs or writes the private key. Use a synthetic
ephemeral key for tests and do not create a production key in this repository.

```sh
cat "$KEY_FILE" | npm run catalogue:sign --workspace=@alyte/catalogue -- \
  --in dist/catalogue.artifact.json \
  --out /tmp/catalogue.signed.json \
  --key-id release-key-1 \
  --algorithm ECDSA-P256-SHA256 \
  --private-key-stdin
```

The CLI also accepts `--private-key-env NAME` for a CI secret or `--private-key-fd N` for a protected
descriptor. With an npm package command, use descriptor `0` (or the tested stdin form) so npm does
not close a higher-numbered descriptor:

```sh
npm run catalogue:sign --workspace=@alyte/catalogue -- \
  --in dist/catalogue.artifact.json --out /tmp/catalogue.signed.json \
  --key-id release-key-1 --algorithm ECDSA-P256-SHA256 --private-key-fd 0 < "$KEY_FILE"
```

It accepts JWK JSON or PEM and converts PEM only in memory to a Web Crypto JWK. The public-key
verification CLI accepts a non-secret JSON key list from `--trusted-keys PATH` or the
`ALYTE_CATALOGUE_TRUSTED_KEYS` environment variable:

```sh
npm run catalogue:verify --workspace=@alyte/catalogue -- \
  --in /tmp/catalogue.signed.json --environment production --trusted-keys trusted.json
```

Key rotation is an operator concern: publish a new trusted key set containing the old key during an
overlap window, sign a new artifact with the replacement key, then remove the old key after all
supported releases have moved. A lost or compromised private key is revoked by removing its public
key from the configured trusted set; no app health data or private key is stored in the catalogue.

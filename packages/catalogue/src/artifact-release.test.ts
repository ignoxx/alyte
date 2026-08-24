import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE_VERSION,
  bundledCatalogueArtifact,
  canonicalCataloguePayload,
  canonicalJson,
  compareCodeUnits,
  comparableBiomarkers,
  createCatalogueArtifact,
  signCatalogueArtifact,
  validateCatalogueArtifact,
  verifyCatalogueForConsumption,
  type CatalogueArtifact,
} from './index';

describe('catalogue release artifact boundary', () => {
  it('serializes equal source content to byte-identical canonical payloads', async () => {
    const first = await createCatalogueArtifact(comparableBiomarkers);
    const second = await createCatalogueArtifact(
      [...comparableBiomarkers].reverse(),
      first.manifest,
      [...first.sourceSet].reverse(),
    );
    assert.equal(canonicalJson({ b: 2, a: 1 }), canonicalJson({ a: 1, b: 2 }));
    assert.equal(canonicalCataloguePayload(first), canonicalCataloguePayload(second));
    assert.equal(first.integrity.digest, second.integrity.digest);
  });

  it('orders canonical identifiers by locale-independent UTF-16 code units', () => {
    assert.ok(compareCodeUnits('z', 'ä') < 0);
    assert.ok(compareCodeUnits('biomarker.a', 'biomarker.z') < 0);
    assert.ok(compareCodeUnits('same', 'same') === 0);
  });

  it('signs in memory and verifies only with the caller trusted public key', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const privateKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.privateKey);
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const signed = await signCatalogueArtifact(bundledCatalogueArtifact, {
      keyId: 'synthetic-release-key',
      algorithm: 'ECDSA-P256-SHA256',
      privateKeyJwk: privateKeyJwk as Record<string, unknown>,
    });
    assert.equal(signed.manifest.status, bundledCatalogueArtifact.manifest.status);
    assert.equal(signed.entries[0]?.review?.status, 'pending-human-publication');
    assert.deepEqual(
      await validateCatalogueArtifact(signed, {
        requireSignature: true,
        trustedKeys: [
          {
            keyId: 'synthetic-release-key',
            algorithm: 'ECDSA-P256-SHA256',
            publicKeyJwk: publicKeyJwk as Record<string, unknown>,
          },
        ],
      }),
      { ok: true, signed: true },
    );
  });

  it('fails closed for missing signatures, wrong keys, tampering, stale versions, and malformed data', async () => {
    const missingSignature = await validateCatalogueArtifact(bundledCatalogueArtifact, {
      requireSignature: true,
    });
    assert.equal(missingSignature.ok, false);
    assert.match(missingSignature.reason, /signature required/i);

    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const wrongPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const signed = await signCatalogueArtifact(bundledCatalogueArtifact, {
      keyId: 'synthetic-release-key',
      algorithm: 'ECDSA-P256-SHA256',
      privateKeyJwk: (await crypto.subtle.exportKey('jwk', keyPair.privateKey)) as Record<
        string,
        unknown
      >,
    });
    const wrongKey = await validateCatalogueArtifact(signed, {
      requireSignature: true,
      trustedKeys: [
        {
          keyId: 'synthetic-release-key',
          algorithm: 'ECDSA-P256-SHA256',
          publicKeyJwk: (await crypto.subtle.exportKey('jwk', wrongPair.publicKey)) as Record<
            string,
            unknown
          >,
        },
      ],
    });
    assert.equal(wrongKey.ok, false);
    assert.match(wrongKey.reason, /signature mismatch/i);

    const tampered = await validateCatalogueArtifact(
      {
        ...signed,
        entries: signed.entries.map((entry) =>
          entry.id === 'biomarker.ldl_c'
            ? { ...entry, explanation: `${entry.explanation} Extra untrusted text.` }
            : entry,
        ),
      },
      { requireSignature: true, trustedKeys: [] },
    );
    assert.equal(tampered.ok, false);
    assert.match(tampered.reason, /integrity/i);

    const stale = await validateCatalogueArtifact(bundledCatalogueArtifact, {
      expectedVersion: '9.9.9',
    });
    assert.equal(stale.ok, false);
    assert.match(stale.reason, /expected release/i);

    const malformed = await validateCatalogueArtifact({
      entries: [],
    } as unknown as CatalogueArtifact);
    assert.equal(malformed.ok, false);
    assert.match(malformed.reason, /malformed|schema/i);
  });

  it('rejects forbidden content and unresolved source references at the artifact boundary', async () => {
    const forbidden = await createCatalogueArtifact(
      comparableBiomarkers.map((entry) =>
        entry.id === 'biomarker.ldl_c'
          ? { ...entry, explanation: 'This result predicts disease.' }
          : entry,
      ),
    ).catch((error: unknown) => error as Error);
    assert.ok(forbidden instanceof Error);
    assert.match(forbidden.message, /forbidden/i);

    const unresolved = await createCatalogueArtifact(
      comparableBiomarkers,
      bundledCatalogueArtifact.manifest,
      bundledCatalogueArtifact.sourceSet.slice(1),
    ).catch((error: unknown) => error as Error);
    assert.ok(unresolved instanceof Error === false);
    const validation = await validateCatalogueArtifact(unresolved as CatalogueArtifact);
    assert.equal(validation.ok, false);
    assert.match(validation.reason, /source/i);
  });

  it('rejects unreviewed extra entries and malformed guidance review metadata', async () => {
    const firstEntry = bundledCatalogueArtifact.entries[0]!;
    const extraEntry = {
      ...firstEntry,
      id: 'biomarker.extra_probe',
      aliases: ['extra probe'],
      review: undefined,
    } as unknown as typeof firstEntry;
    const extraResult = await validateCatalogueArtifact({
      ...bundledCatalogueArtifact,
      entries: [...bundledCatalogueArtifact.entries, extraEntry],
    });
    assert.equal(extraResult.ok, false);
    assert.match(extraResult.reason, /review/i);

    const guidedEntry = bundledCatalogueArtifact.entries.find(
      (entry) => (entry.generalGuidance?.length ?? 0) > 0,
    )!;
    const malformedGuidance = {
      ...guidedEntry,
      generalGuidance: guidedEntry.generalGuidance!.map((guidance, index) =>
        index === 0 ? { ...guidance, review: {} } : guidance,
      ),
    } as unknown as typeof guidedEntry;
    const guidanceResult = await validateCatalogueArtifact({
      ...bundledCatalogueArtifact,
      entries: bundledCatalogueArtifact.entries.map((entry) =>
        entry.id === guidedEntry.id ? malformedGuidance : entry,
      ),
    });
    assert.equal(guidanceResult.ok, false);
    assert.match(guidanceResult.reason, /review/i);
  });

  it('makes review-pending development explicit and release policy fail closed', async () => {
    const development = await verifyCatalogueForConsumption(bundledCatalogueArtifact, {
      environment: 'development',
    });
    assert.deepEqual(
      development.ok && {
        signed: development.signed,
        version: development.artifact.manifest.version,
      },
      { signed: false, version: CATALOGUE_VERSION },
    );

    const production = await verifyCatalogueForConsumption(bundledCatalogueArtifact, {
      environment: 'production',
      trustedKeys: [],
    });
    assert.equal(production.ok, false);
    assert.match(production.reason, /publication review|signature required/i);
  });

  it('exposes entries from the emitted artifact rather than source-module aggregation', () => {
    assert.strictEqual(comparableBiomarkers, bundledCatalogueArtifact.entries);
    assert.equal(comparableBiomarkers.length, 15);
    assert.equal(
      comparableBiomarkers.some((entry) => entry.id === 'biomarker.ldl_c'),
      true,
    );
  });
});

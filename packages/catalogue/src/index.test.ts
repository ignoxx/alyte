import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE_VERSION,
  bloodLiverSources,
  canonicalJson,
  catalogueManifest,
  comparableBiomarkers,
  createCatalogueArtifact,
  findCatalogueBiomarker,
  lipidSources,
  metabolicSources,
  resolveBiomarkerAlias,
  validateCatalogue,
  validateCatalogueArtifact,
  type CatalogueArtifact,
} from './index';

describe('catalogue boundary', () => {
  it('ships a versioned, reviewable manifest', () => {
    assert.equal(catalogueManifest.status, 'review-pending');
    assert.match(catalogueManifest.version, /^\d+\.\d+\.\d+$/);
  });

  it('allocates four stable lipid IDs with reviewed-shape metadata and source provenance', () => {
    const ids = [
      'biomarker.total_cholesterol',
      'biomarker.ldl_c',
      'biomarker.hdl_c',
      'biomarker.triglycerides',
    ];
    for (const id of ids) {
      const entry = findCatalogueBiomarker(id);
      assert.ok(entry, id);
      assert.ok(entry.aliases.length > 1);
      assert.ok(entry.canonicalLabel);
      assert.ok(entry.specimens.includes('serum'));
      assert.deepEqual(entry.units, ['mg/dL', 'mmol/L']);
      assert.equal(entry.canonicalUnit, 'mg/dL');
      assert.ok(entry.unitConversions?.some((conversion) => conversion.from === 'mmol/L'));
      assert.ok(entry.explanation!.length > 20);
      assert.ok(entry.sources!.length > 0);
      assert.equal(entry.review!.status, 'pending-human-publication');
      assert.ok(entry.generalGuidance!.length > 0);
      assert.equal(entry.catalogueVersion, CATALOGUE_VERSION);
      for (const conversion of entry.unitConversions!) {
        assert.ok(entry.sources!.some((source) => source.id === conversion.sourceId));
      }
      for (const guidance of entry.generalGuidance!) {
        assert.ok(
          guidance.sources.every((sourceId) =>
            entry.sources!.some((source) => source.id === sourceId),
          ),
        );
      }
    }
    const hdl = findCatalogueBiomarker('biomarker.hdl_c')!;
    assert.deepEqual(
      hdl.generalGuidance!.map((guidance) => [
        guidance.applicability.sex,
        guidance.thresholds[0]?.value,
      ]),
      [
        ['female', 50],
        ['male', 40],
      ],
    );
    assert.equal(resolveBiomarkerAlias('  LDL-Cholesterin '), 'biomarker.ldl_c');
    assert.equal(resolveBiomarkerAlias('not a biomarker'), null);
  });

  it('rejects forbidden health wording and malformed catalogue references', () => {
    assert.deepEqual(validateCatalogue(comparableBiomarkers), []);
    assert.ok(
      validateCatalogue([
        {
          ...findCatalogueBiomarker('biomarker.ldl_c')!,
          explanation: 'This result predicts disease and is a good zone.',
        },
      ]).some((issue) => /forbidden wording/i.test(issue.message)),
    );
  });

  it('enforces lipid completeness while leaving non-lipid extension entries permissive', () => {
    const lipid = findCatalogueBiomarker('biomarker.ldl_c')!;
    const issues = validateCatalogue([
      {
        id: lipid.id,
        canonicalLabel: '',
        aliases: [],
        specimens: [],
        units: [],
        unitConversions: [],
        explanation: '',
        sources: [],
      },
      {
        id: 'biomarker.future_family',
        aliases: ['future marker'],
        specimens: ['blood'],
        units: ['unit'],
      },
    ]);
    assert.ok(issues.some((issue) => /canonical label/i.test(issue.message)));
    assert.ok(issues.some((issue) => /lipid explanation/i.test(issue.message)));
    assert.ok(issues.some((issue) => /lipid source/i.test(issue.message)));
    assert.ok(issues.some((issue) => /lipid review/i.test(issue.message)));
    assert.ok(issues.some((issue) => /lipid guidance/i.test(issue.message)));
    assert.equal(
      issues.some((issue) => issue.path.includes('future_family')),
      false,
    );
  });

  it('rejects an artifact with altered payload or an invalid required signature', async () => {
    const artifact: CatalogueArtifact = {
      schemaVersion: 'alyte.catalogue.artifact.v1',
      manifest: { ...catalogueManifest, version: CATALOGUE_VERSION },
      entries: comparableBiomarkers,
      sourceSet: [...lipidSources, ...metabolicSources, ...bloodLiverSources],
      integrity: { algorithm: 'SHA-256', digest: 'not-the-digest' },
      signature: null,
    };
    const result = await validateCatalogueArtifact(artifact, { requireSignature: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /integrity/i);
  });

  it('requires every serialized conversion and guidance reference to resolve in the artifact source set', async () => {
    const artifact = await createCatalogueArtifact(
      comparableBiomarkers,
      catalogueManifest,
      lipidSources.slice(1),
    );
    const result = await validateCatalogueArtifact(artifact);
    assert.equal(result.ok, false);
    assert.match(result.reason, /source/i);
  });

  it('verifies only with caller-trusted key material and rejects unsigned, wrong-key, and tampered artifacts', async () => {
    const keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const attackerPair = await crypto.subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify'],
    );
    const publicKeyJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
    const attackerPublicKeyJwk = await crypto.subtle.exportKey('jwk', attackerPair.publicKey);
    const artifact = await createCatalogueArtifact(comparableBiomarkers, {
      ...catalogueManifest,
      signatureRequired: true,
    });
    const payload = canonicalJson({
      schemaVersion: artifact.schemaVersion,
      manifest: artifact.manifest,
      entries: artifact.entries,
      sourceSet: artifact.sourceSet,
    });
    const signature = await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      keyPair.privateKey,
      new TextEncoder().encode(payload),
    );
    const signed: CatalogueArtifact = {
      ...artifact,
      signature: {
        keyId: 'release-key-1',
        algorithm: 'ECDSA-P256-SHA256',
        value: toBase64(new Uint8Array(signature)),
      },
    };
    const trusted = {
      keyId: 'release-key-1',
      algorithm: 'ECDSA-P256-SHA256' as const,
      publicKeyJwk: publicKeyJwk as unknown as Record<string, unknown>,
    };
    assert.deepEqual(
      await validateCatalogueArtifact(signed, { requireSignature: true, trustedKeys: [trusted] }),
      {
        ok: true,
        signed: true,
      },
    );
    assert.equal(
      (
        await validateCatalogueArtifact(artifact, {
          requireSignature: true,
          trustedKeys: [trusted],
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await validateCatalogueArtifact(signed, {
          requireSignature: true,
          trustedKeys: [
            {
              ...trusted,
              publicKeyJwk: attackerPublicKeyJwk as unknown as Record<string, unknown>,
            },
          ],
        })
      ).ok,
      false,
    );
    assert.equal(
      (
        await validateCatalogueArtifact(
          { ...signed, signature: { ...signed.signature!, keyId: 'unknown-key' } },
          { requireSignature: true, trustedKeys: [trusted] },
        )
      ).ok,
      false,
    );
    assert.equal(
      (
        await validateCatalogueArtifact(
          { ...signed, entries: [...signed.entries, findCatalogueBiomarker('biomarker.glucose')!] },
          { requireSignature: true, trustedKeys: [trusted] },
        )
      ).ok,
      false,
    );
  });
});

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

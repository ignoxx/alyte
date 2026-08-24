import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOGUE_VERSION,
  catalogueManifest,
  comparableBiomarkers,
  findCatalogueBiomarker,
  resolveBiomarkerAlias,
  validateCatalogue,
  validateCatalogueArtifact,
  type CatalogueArtifact,
} from './index.js';

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
      assert.ok(entry.specimens.includes('serum'));
      assert.deepEqual(entry.units, ['mg/dL', 'mmol/L']);
      assert.equal(entry.canonicalUnit, 'mg/dL');
      assert.ok(entry.unitConversions?.some((conversion) => conversion.from === 'mmol/L'));
      assert.ok(entry.explanation!.length > 20);
      assert.ok(entry.sources!.length > 0);
      assert.equal(entry.review!.status, 'pending-human-publication');
      assert.ok(entry.generalGuidance!.length > 0);
    }
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

  it('rejects an artifact with altered payload or an invalid required signature', async () => {
    const artifact: CatalogueArtifact = {
      schemaVersion: 'alyte.catalogue.artifact.v1',
      manifest: { ...catalogueManifest, version: CATALOGUE_VERSION },
      entries: comparableBiomarkers,
      integrity: { algorithm: 'SHA-256', digest: 'not-the-digest' },
      signature: null,
    };
    const result = await validateCatalogueArtifact(artifact, { requireSignature: false });
    assert.equal(result.ok, false);
    assert.match(result.reason, /integrity/i);
  });
});

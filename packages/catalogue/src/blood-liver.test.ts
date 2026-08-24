import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BLOOD_LIVER_BIOMARKER_IDS,
  bloodLiverBiomarkers,
  bloodLiverSources,
  findForbiddenWording,
  resolveBiomarkerAlias,
  validateCatalogue,
} from './index.js';

const familyIds = Object.values(BLOOD_LIVER_BIOMARKER_IDS);

describe('blood-count and liver catalogue family', () => {
  it('ships six stable entries with reviewed-shape metadata and pending publication status', () => {
    assert.deepEqual(
      bloodLiverBiomarkers.map((entry) => entry.id),
      familyIds,
    );
    assert.deepEqual(validateCatalogue(bloodLiverBiomarkers), []);

    for (const entry of bloodLiverBiomarkers) {
      assert.ok(entry.canonicalLabel);
      assert.equal(entry.valueType, 'numeric');
      assert.ok(entry.aliases.length >= 4, entry.id);
      assert.ok(entry.specimens.length > 0, entry.id);
      assert.ok(entry.units.length > 0, entry.id);
      assert.ok(entry.canonicalUnit, entry.id);
      assert.ok(entry.specimenCompatibility?.length, entry.id);
      assert.ok(entry.explanation && entry.explanation.length > 40, entry.id);
      assert.ok(entry.sources && entry.sources.length > 0, entry.id);
      assert.ok(entry.review, entry.id);
      assert.equal(entry.review?.status, 'pending-human-publication');
      assert.equal(entry.review?.reviewedAt, null);
      assert.equal(entry.review?.reviewer, null);
      assert.equal(entry.generalGuidance?.length, 0, entry.id);
      assert.ok(entry.methodPolicy, entry.id);
      for (const source of entry.sources ?? []) {
        assert.ok(
          bloodLiverSources.some((candidate) => candidate.id === source.id),
          source.id,
        );
        assert.match(source.url, /^https:\/\//u);
      }
      for (const conversion of entry.unitConversions ?? []) {
        assert.ok(entry.sources?.some((source) => source.id === conversion.sourceId));
      }
    }
  });

  it('maps representative English, German, US, and EU labels without collapsing identities', () => {
    const aliases: readonly (readonly [string, string])[] = [
      ['Hemoglobin', 'biomarker.hemoglobin'],
      ['Hämoglobin', 'biomarker.hemoglobin'],
      ['HGB', 'biomarker.hemoglobin'],
      ['Hematocrit', 'biomarker.hematocrit'],
      ['PCV', 'biomarker.hematocrit'],
      ['Hämatokrit', 'biomarker.hematocrit'],
      ['Mean Cell Volume', 'biomarker.mcv'],
      ['Mittleres korpuskuläres Volumen', 'biomarker.mcv'],
      ['ALT', 'biomarker.alt'],
      ['ALAT', 'biomarker.alt'],
      ['Alanina aminotransferasi', 'biomarker.alt'],
      ['AST', 'biomarker.ast'],
      ['ASAT', 'biomarker.ast'],
      ['Aspartato aminotransferasa', 'biomarker.ast'],
      ['GGT', 'biomarker.ggt'],
      ['Gamma-GT', 'biomarker.ggt'],
      ['Gamma-glutamyltransferase', 'biomarker.ggt'],
    ];
    for (const [label, id] of aliases) assert.equal(resolveBiomarkerAlias(label), id, label);

    // Related CBC, liver-panel, and hemoglobin-derivative labels must not map to these entries.
    for (const label of [
      'carboxyhemoglobin',
      'MCH',
      'MCHC',
      'alkaline phosphatase',
      'bilirubin',
      '1,25-dihydroxyvitamin D',
    ]) {
      assert.equal(resolveBiomarkerAlias(label), null, label);
    }
    assert.notEqual(resolveBiomarkerAlias('HbA1c'), 'biomarker.hemoglobin');
  });

  it('keeps only exact, source-linked Hb/Hct conversions and no guessed enzyme conversion', () => {
    const hemoglobin = bloodLiverBiomarkers.find((entry) => entry.id === 'biomarker.hemoglobin')!;
    const hematocrit = bloodLiverBiomarkers.find((entry) => entry.id === 'biomarker.hematocrit')!;
    const mcv = bloodLiverBiomarkers.find((entry) => entry.id === 'biomarker.mcv')!;
    const alt = bloodLiverBiomarkers.find((entry) => entry.id === 'biomarker.alt')!;

    assert.deepEqual(hemoglobin.units, ['g/dL', 'g/L']);
    assert.deepEqual(
      hemoglobin.unitConversions?.map(({ from, to, factor }) => [from, to, factor]),
      [
        ['g/L', 'g/dL', 0.1],
        ['g/dL', 'g/L', 10],
      ],
    );
    assert.deepEqual(
      hematocrit.unitConversions?.map(({ from, to, factor }) => [from, to, factor]),
      [
        ['L/L', '%', 100],
        ['%', 'L/L', 0.01],
      ],
    );
    assert.deepEqual(mcv.unitConversions, []);
    assert.deepEqual(alt.unitConversions, []);
    assert.equal(
      hemoglobin.unitConversions?.every((conversion) =>
        hemoglobin.sources?.some((source) => source.id === conversion.sourceId),
      ),
      true,
    );
  });

  it('requires explicit supported enzyme method identity and rejects malformed family contracts', () => {
    for (const id of ['biomarker.alt', 'biomarker.ast', 'biomarker.ggt']) {
      const entry = bloodLiverBiomarkers.find((candidate) => candidate.id === id)!;
      assert.equal(entry.methodPolicy?.kind, 'requires-explicit-method', id);
      assert.ok(entry.methodPolicy?.allowedMethods.length, id);
    }
    const alt = bloodLiverBiomarkers.find((entry) => entry.id === 'biomarker.alt')!;
    assert.ok(
      validateCatalogue([{ ...alt, specimenCompatibility: [['serum']] }]).some((issue) =>
        /does not cover every listed specimen/i.test(issue.message),
      ),
    );
    assert.ok(
      validateCatalogue([{ ...alt, explanation: 'This result predicts disease.' }]).some((issue) =>
        /forbidden wording/i.test(issue.message),
      ),
    );
  });

  it('keeps every draft explanation outside the forbidden wording set', () => {
    assert.equal(
      bloodLiverBiomarkers.some((entry) => findForbiddenWording(entry.explanation ?? '') !== null),
      false,
    );
  });
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  METABOLIC_MICRONUTRIENT_BIOMARKER_IDS,
  bloodLiverBiomarkers,
  metabolicMicronutrientBiomarkers,
  metabolicSources,
  resolveBiomarkerAlias,
  validateCatalogue,
  findForbiddenWording,
} from './index';

const familyIds = Object.values(METABOLIC_MICRONUTRIENT_BIOMARKER_IDS);

describe('metabolic and micronutrient catalogue family', () => {
  it('keeps five stable, source-backed entries separate from the blood/liver family', () => {
    assert.deepEqual(
      metabolicMicronutrientBiomarkers.map((entry) => entry.id),
      familyIds,
    );
    assert.deepEqual(
      bloodLiverBiomarkers.map((entry) => entry.id),
      [
        'biomarker.hemoglobin',
        'biomarker.hematocrit',
        'biomarker.mcv',
        'biomarker.alt',
        'biomarker.ast',
        'biomarker.ggt',
      ],
    );
    assert.ok(metabolicSources.length >= 5);

    for (const entry of metabolicMicronutrientBiomarkers) {
      assert.ok(entry.canonicalLabel);
      assert.equal(entry.valueType, 'numeric');
      assert.ok(entry.aliases.length >= 4);
      assert.ok(entry.specimens.length > 0);
      assert.ok(entry.units.length > 0);
      assert.ok(entry.canonicalUnit);
      assert.ok(entry.unitConversions && entry.unitConversions.length > 0);
      assert.ok(entry.explanation && entry.explanation.length > 40);
      assert.ok(entry.sources && entry.sources.length > 0);
      assert.equal(entry.review?.status, 'pending-human-publication');
      assert.equal(entry.review?.reviewedAt, null);
      assert.equal(entry.review?.reviewer, null);
      assert.ok(entry.methodPolicy);
      for (const source of entry.sources ?? []) {
        assert.ok(/^https:\/\//.test(source.url));
        assert.ok(metabolicSources.some((candidate) => candidate.id === source.id));
      }
      for (const conversion of entry.unitConversions ?? []) {
        assert.ok(entry.sources?.some((source) => source.id === conversion.sourceId));
      }
      for (const guidance of entry.generalGuidance ?? []) {
        assert.equal(guidance.applicability.population, 'adults');
        assert.equal(guidance.applicability.jurisdiction, 'US');
        assert.equal(guidance.review.status, 'pending-human-publication');
        assert.ok(
          guidance.sources.every((sourceId) =>
            entry.sources?.some((source) => source.id === sourceId),
          ),
        );
      }
    }
    assert.deepEqual(validateCatalogue(metabolicMicronutrientBiomarkers), []);
  });

  it('rejects incomplete, overlapping, or unlisted specimen compatibility groups', () => {
    const glucose = metabolicMicronutrientBiomarkers.find(
      (entry) => entry.id === 'biomarker.glucose',
    )!;
    assert.ok(
      validateCatalogue([{ ...glucose, specimenCompatibility: [['serum']] }]).some((issue) =>
        /does not cover every listed specimen/i.test(issue.message),
      ),
    );
    assert.ok(
      validateCatalogue([
        {
          ...glucose,
          specimenCompatibility: [
            ['blood', 'serum'],
            ['serum', 'plasma'],
          ],
        },
      ]).some((issue) => /overlap/i.test(issue.message)),
    );
    assert.ok(
      validateCatalogue([
        { ...glucose, specimenCompatibility: [['blood', 'serum', 'plasma', 'urine'] as const] },
      ]).some((issue) => /unlisted specimen/i.test(issue.message)),
    );
  });

  it('maps representative English, German, US, and EU labels without collapsing identities', () => {
    const aliases: readonly (readonly [string, string])[] = [
      ['Fasting blood glucose', 'biomarker.glucose'],
      ['Nüchternblutzucker', 'biomarker.glucose'],
      ['HbA1c', 'biomarker.hba1c'],
      ['Glykiertes Hämoglobin', 'biomarker.hba1c'],
      ['Ferritin', 'biomarker.ferritin'],
      ['Ferritine', 'biomarker.ferritin'],
      ['25-OH Vitamin D', 'biomarker.vitamin_d_total'],
      ['25(OH)D', 'biomarker.vitamin_d_total'],
      ['Vitamin B12', 'biomarker.vitamin_b12_total'],
      ['Kobalamina', 'biomarker.vitamin_b12_total'],
    ];
    for (const [label, id] of aliases) assert.equal(resolveBiomarkerAlias(label), id, label);

    // These labels do not identify a safe comparable assay or form.
    for (const label of [
      'Vitamin D',
      '1,25-dihydroxyvitamin D',
      'Vitamin D2',
      'active B12',
      'holotranscobalamin',
      'B12',
      'glucose tolerance test',
      'hemoglobin',
    ]) {
      assert.notEqual(resolveBiomarkerAlias(label), 'biomarker.vitamin_d_total', label);
    }
    assert.equal(resolveBiomarkerAlias('Vitamin D'), null);
    assert.equal(resolveBiomarkerAlias('active B12'), null);
    assert.equal(resolveBiomarkerAlias('B12'), null);
    assert.equal(resolveBiomarkerAlias('glucose tolerance test'), null);
    assert.equal(resolveBiomarkerAlias('hemoglobin'), 'biomarker.hemoglobin');
  });

  it('exposes only deterministic, source-linked conversions and no unsupported unit path', () => {
    const expectedUnits: readonly (readonly [string, string[]])[] = [
      ['biomarker.glucose', ['mg/dL', 'mmol/L']],
      ['biomarker.hba1c', ['%', 'mmol/mol']],
      ['biomarker.ferritin', ['ng/mL', 'µg/L', 'ug/L']],
      ['biomarker.vitamin_d_total', ['ng/mL', 'nmol/L']],
      ['biomarker.vitamin_b12_total', ['pg/mL', 'pmol/L']],
    ];
    for (const [id, units] of expectedUnits) {
      const entry = metabolicMicronutrientBiomarkers.find((candidate) => candidate.id === id);
      assert.ok(entry);
      assert.deepEqual(entry.units, units);
      for (const unit of units) {
        if (unit === entry.canonicalUnit) continue;
        assert.ok(
          entry.unitConversions?.some(
            (candidate) => candidate.from === unit && candidate.to === entry.canonicalUnit,
          ),
          `${id} has no path from ${unit}`,
        );
      }
    }
    assert.equal(
      metabolicMicronutrientBiomarkers
        .flatMap((entry) => entry.explanation ?? [])
        .some((text) => findForbiddenWording(text) !== null),
      false,
    );
    assert.ok(
      validateCatalogue([
        {
          ...metabolicMicronutrientBiomarkers[0]!,
          explanation: 'This is a good zone and predicts disease.',
        },
      ]).some((issue) => /forbidden wording/i.test(issue.message)),
    );
  });
});

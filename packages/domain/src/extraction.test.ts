import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { metabolicMicronutrientBiomarkers } from '@alyte/catalogue';
import {
  buildExtractionConfirmationPlan,
  classifyExtractionPipelineFingerprint,
  createExtractionPipelineFingerprint,
  decodeVisionOCRResult,
  EXTRACTION_PARSER_VERSION,
  extractionReviewBlocksConfirmation,
  extractionReviewRequiresAttention,
  groupObservationsIntoRows,
  normalizeUnit,
  parseComparatorValue,
  parseLabDate,
  reparseExtractionRowFromSemanticFields,
  revalidateExtractionRow,
  validateSemanticProposals,
  type ExtractionAliasEntry,
} from './extraction.js';

const aliases: readonly ExtractionAliasEntry[] = [
  {
    id: 'biomarker.ldl_c',
    aliases: ['LDL-C', 'LDL-Cholesterin'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mmol/L', 'mg/dL'],
  },
];

it('fingerprints classify complete extraction inputs without treating a revision as a pipeline change', () => {
  const input = {
    sourceHash: 'synthetic-source-hash',
    ocrContractVersion: 'ocr.v2',
    rowSegmentationVersion: 'rows.v1',
    parserVersion: 'parser.v5',
    semanticAdapterVersion: null,
    semanticSchemaVersion: null,
    semanticChunkVersion: null,
    semanticPromptVersion: null,
    modelVersion: null,
    runtimeVersion: null,
    catalogueVersion: 'catalogue.v1',
  } as const;
  const first = createExtractionPipelineFingerprint(input, 1);
  const laterRevision = createExtractionPipelineFingerprint(input, 2);
  const changedParser = createExtractionPipelineFingerprint(
    { ...input, parserVersion: 'parser.v6' },
    1,
  );
  assert.equal(classifyExtractionPipelineFingerprint(first, laterRevision), 'current');
  assert.equal(classifyExtractionPipelineFingerprint(first, changedParser), 'older');
  assert.equal(first.hash.length, 32);
});

const tableAliases: readonly ExtractionAliasEntry[] = [
  {
    id: 'biomarker.vitamin_d_total',
    aliases: ['Vitamin D', '25-OH vitamin D'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['ng/mL', 'nmol/L'],
  },
  {
    id: 'biomarker.ldl_c',
    aliases: ['LDL cholesterol', 'LDL-C'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.hdl_c',
    aliases: ['HDL cholesterol', 'HDL-C'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.triglycerides',
    aliases: ['Triglycerides'],
    specimens: ['blood', 'serum', 'plasma', 'unknown'],
    units: ['mg/dL', 'mmol/L'],
  },
  {
    id: 'biomarker.hba1c',
    aliases: ['HbA1c'],
    specimens: ['blood', 'unknown'],
    units: ['%', 'mmol/mol'],
  },
];

describe('local extraction domain', () => {
  it('fails closed for source-specific assays in the production catalogue extraction path', () => {
    const productionAliases: readonly ExtractionAliasEntry[] = metabolicMicronutrientBiomarkers.map(
      (entry) => ({
        id: entry.id,
        aliases: entry.aliases,
        specimens: entry.specimens,
        units: entry.units,
        ...(entry.unsafeAliases === undefined ? {} : { unsafeAliases: entry.unsafeAliases }),
        ...(entry.methodPolicy === undefined
          ? {}
          : {
              methodPolicy: {
                version: entry.methodPolicy.version,
                kind: entry.methodPolicy.kind,
                allowedMethods: entry.methodPolicy.allowedMethods,
                unsafePatterns: entry.methodPolicy.unsafePatterns,
                ...(entry.methodPolicy.profiles === undefined
                  ? {}
                  : { profiles: entry.methodPolicy.profiles }),
              },
            }),
      }),
    );
    const observation = (id: string, text: string, index: number) => ({
      id,
      text,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x: 0.1, y: 0.1 + index * 0.12, width: 0.8, height: 0.04 },
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    });
    const rows = groupObservationsIntoRows(
      [
        observation('glucose', 'Glucose 126 mg/dL', 0),
        observation('vitamin-d', '25-OH Vitamin D LC-MS/MS 20 ng/mL', 1),
        observation('vitamin-d-unknown-method', '25-OH Vitamin D 20 ng/mL', 2),
        observation('vitamin-d2', 'Vitamin D2 20 ng/mL', 3),
        observation('vitamin-d3', 'Vitamin D3 20 ng/mL', 4),
        observation('vitamin-d1-25', '1,25-dihydroxyvitamin D 20 pg/mL', 5),
        observation('glucose-ogtt', 'Oral glucose tolerance 126 mg/dL', 6),
      ],
      {
        aliases: productionAliases,
        collectionDate: { kind: 'known', value: '2026-08-20' },
        specimenType: 'serum',
      },
    );
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.equal(byId.get('glucose')?.proposedBiomarkerId, 'biomarker.glucose');
    assert.equal(byId.get('vitamin-d')?.proposedBiomarkerId, 'biomarker.vitamin_d_total');
    assert.equal(byId.get('vitamin-d')?.reviewState, 'ready');
    assert.equal(
      byId.get('vitamin-d-unknown-method')?.proposedBiomarkerId,
      'biomarker.vitamin_d_total',
    );
    assert.equal(byId.get('vitamin-d-unknown-method')?.reviewState, 'needs-review');
    assert.ok(byId.get('vitamin-d-unknown-method')?.reviewReasons.includes('incompatible-method'));
    for (const id of ['vitamin-d2', 'vitamin-d3', 'vitamin-d1-25', 'glucose-ogtt']) {
      const row = byId.get(id);
      assert.equal(row?.proposedBiomarkerId, null, id);
      assert.ok(row?.reviewReasons.includes('ambiguous-assay'), id);
      assert.equal(row?.decision, 'preserve', id);
      assert.ok(
        row?.source.observations?.some((item) => item.text.includes(row.sourceText)),
        id,
      );
    }
  });

  it('rejects untrusted OCR contract data outside normalized bounds', () => {
    assert.throws(
      () =>
        decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [{ text: 'LDL-C', boundingBox: { x: 0.9, y: 0, width: 0.2, height: 0.1 } }],
        }),
      /bounding box/,
    );
  });

  it('parses German decimal/comparator/date formats and keeps unsupported rows reviewable', () => {
    assert.deepEqual(parseComparatorValue('< 3,8'), {
      kind: 'bounded',
      comparator: '<',
      value: 3.8,
    });
    assert.deepEqual(parseLabDate('22.08.2026', 'de-DE'), { kind: 'known', value: '2026-08-22' });
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'label',
          text: 'LDL-Cholesterin',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.25, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: 0.99 },
        },
        {
          id: 'value',
          text: '3,8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.5, y: 0.2, width: 0.2, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: 0.99 },
        },
        {
          id: 'unknown',
          text: 'Mystery Marker 2,1 mg/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.3, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-22' }, specimenType: 'blood' },
    );
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(rows[1]?.proposedBiomarkerId, null);
    assert.equal(rows[1]?.reviewState, 'needs-review');
    assert.equal(rows[0]?.source.pageIndex, 0);
  });

  it('preserves complete known and unfamiliar unit tokens without suffix matching', () => {
    const units = [
      'mg/L',
      'mIU/L',
      'µmol/L',
      'μmol/L',
      'nmol/L',
      'mmol/L',
      'IU/L',
      'U/L',
      'g/L',
      'L/L',
      '%',
      'fL',
    ] as const;
    const observations = units.map((unit, index) => ({
      id: `unit-${index}`,
      text: `Unfamiliar marker ${index + 1} ${unit}`,
      alternatives: [],
      boundingBox: { x: 0.1, y: 0.05 + index * 0.07, width: 0.8, height: 0.03 },
      pageIndex: 0,
      orientation: 0,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    }));
    const rows = groupObservationsIntoRows(observations, {
      collectionDate: { kind: 'known', value: '2026-08-22' },
    });

    assert.equal(rows.length, units.length);
    for (const [index, unit] of units.entries()) {
      const row = rows[index];
      assert.ok(row, unit);
      const expectedUnit = normalizeUnit(unit);
      assert.equal(row?.source.raw?.unit, unit);
      assert.equal(row?.sourceUnit, expectedUnit, unit);
      assert.equal(row?.proposedUnit, expectedUnit, unit);
      assert.equal(row?.reviewState, 'needs-review', unit);
      assert.ok(row?.reviewReasons.includes('unsupported-alias'), unit);
    }

    const rowsWithFooter = groupObservationsIntoRows(
      [
        ...observations,
        {
          id: 'footer',
          text: 'Synthetic laboratory footer 2026-08-22',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.94, width: 0.8, height: 0.03 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      { collectionDate: { kind: 'known', value: '2026-08-22' } },
    );
    assert.equal(rowsWithFooter.length, units.length);
    assert.equal(
      rowsWithFooter.some((row) => row.source.observationIds.includes('footer')),
      false,
    );
  });

  it('keeps canonical incompatibility strict for a complete unfamiliar unit', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'ldl-unfamiliar-unit',
          text: 'LDL-C 3.8 mg/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-22' } },
    );
    assert.ok(row);
    assert.equal(row?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(row?.source.raw?.unit, 'mg/L');
    assert.equal(row?.proposedUnit, 'mg/L');
    assert.ok(row?.reviewReasons.includes('incompatible-unit'));
    assert.equal(row?.decision, 'skip');
    assert.equal(extractionReviewBlocksConfirmation(row!), false);
  });

  it('rejects URLs and slash paths as units on numeric footer text', () => {
    for (const text of [
      'Synthetic footer 2026 https://www.example.test/g/L',
      'Synthetic footer 2026 archive/g/L',
      'Synthetic footer 2026 archive/results',
      'Synthetic footer 2026 08/22',
    ]) {
      const rows = groupObservationsIntoRows(
        [
          {
            id: 'footer',
            text,
            alternatives: [],
            boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
            pageIndex: 0,
            orientation: 0,
            recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
          },
        ],
        { collectionDate: { kind: 'known', value: '2026-08-22' } },
      );
      assert.equal(rows.length, 0, text);
    }
  });

  it('rejects prose slash phrases as units on numeric footer text', () => {
    for (const text of ['Synthetic footer 2026 Final/Verified', 'Synthetic footer 2026 Mon/Fri']) {
      const rows = groupObservationsIntoRows(
        [
          {
            id: 'footer',
            text,
            alternatives: [],
            boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
            pageIndex: 0,
            orientation: 0,
            recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
          },
        ],
        { collectionDate: { kind: 'known', value: '2026-08-22' } },
      );
      assert.equal(rows.length, 0, text);
    }
  });

  it('does not parse an assay method token as a laboratory unit', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'method-only',
          text: 'LDL-C 3.8 CHOD/PAP',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-22' } },
    );
    assert.ok(row);
    assert.equal(row?.sourceUnit, null);
    assert.equal(row?.proposedUnit, null);
    assert.ok(!row?.reviewReasons.includes('incompatible-unit'));
  });

  it('prefers a unit before the value over a later assay method token', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'unit-before-value',
          text: 'mg/L LDL-C 3.8 CHOD/PAP',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-22' } },
    );
    assert.ok(row);
    assert.equal(row?.source.raw?.unit, 'mg/L');
    assert.equal(row?.sourceUnit, 'mg/L');
    assert.equal(row?.proposedUnit, 'mg/L');
    assert.ok(row?.reviewReasons.includes('incompatible-unit'));
  });

  it('excludes terminal sentence punctuation from a parsed unit', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'terminal-punctuation',
          text: 'LDL-C 3.8 mg/L.',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-22' } },
    );
    assert.ok(row);
    assert.equal(row?.source.raw?.unit, 'mg/L');
    assert.equal(row?.proposedUnit, 'mg/L');
  });

  it('preserves Lithuanian and Polish decimal-comma source tokens byte-for-byte', () => {
    for (const [language, text, value] of [
      ['lt', 'MTL cholesterolis 3,8 mmol/L', '3,8'],
      ['pl', 'LDL-C 3,8 mmol/L 1,2-3,4', '3,8'],
    ] as const) {
      const row = groupObservationsIntoRows(
        [
          {
            id: `raw-${language}`,
            text,
            alternatives: [],
            boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.04 },
            pageIndex: 0,
            orientation: 0,
            recognition: { level: 'accurate', language, internalConfidence: null },
          },
        ],
        {
          aliases,
          locale: `${language}-${language === 'lt' ? 'LT' : 'PL'}`,
          collectionDate: { kind: 'known', value: '2026-08-22' },
          specimenType: 'serum',
        },
      )[0];
      assert.equal(row?.source.raw?.value, value);
      assert.equal(row?.source.raw?.unit, 'mmol/L');
      assert.equal(row?.source.observations?.[0]?.text, text);
      assert.equal(row?.sourceValue.kind, 'numeric');
      assert.equal(row?.sourceValue.value, 3.8);
    }
  });

  it('selects the numeric token from split OCR columns and unions only observed regions', () => {
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'split-label',
          text: 'LDL-C',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
        {
          id: 'split-value',
          text: '3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.5, y: 0.2, width: 0.2, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-22' }, specimenType: 'blood' },
    );
    assert.equal(rows[0]?.proposedValue.kind, 'numeric');
    assert.equal(rows[0]?.proposedValue.value, 3.8);
    assert.equal(rows[0]?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(rows[0]?.source.observationIds, ['split-label', 'split-value']);
    assert.equal(rows[0]?.source.boundingBox.x, 0.1);
    assert.equal(rows[0]?.source.boundingBox.y, 0.2);
    assert.equal(rows[0]?.source.boundingBox.width, 0.6);
    assert.ok(Math.abs((rows[0]?.source.boundingBox.height ?? 0) - 0.04) < 0.000001);
  });

  it('includes credible unmapped rows by default while preserving them as needs-review', () => {
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'unknown-row',
          text: 'Mystery Marker positive',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: null, internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'missing' }, specimenType: 'unknown' },
    );
    const base = {
      id: 'draft-decision',
      reportId: 'report-decision',
      state: 'draft' as const,
      ocrContractVersion: 'alyte.vision.document.v2' as const,
      parserVersion: EXTRACTION_PARSER_VERSION,
      collectionDate: { kind: 'missing' as const },
      rows,
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      confirmedAt: null,
      pipelineFingerprint: null,
      pipelineStatus: 'older' as const,
      revision: 1,
      hasUserEdits: false,
    };
    assert.equal(rows[0]?.decision, 'preserve');
    const defaultPlan = buildExtractionConfirmationPlan(base, {
      record: () => 'r',
      measurement: () => 'm',
    });
    assert.equal(defaultPlan.records[0]?.measurements[0]?.reviewState, 'needs-review');
    const plan = buildExtractionConfirmationPlan(
      { ...base, rows: rows.map((row) => ({ ...row, decision: 'preserve' as const })) },
      { record: () => 'r', measurement: () => 'm' },
    );
    assert.equal(plan.records[0]?.measurements[0]?.reviewState, 'needs-review');
    assert.equal(plan.records[0]?.measurements[0]?.provenance, 'extracted');
  });

  it('supports the launch locale date and decimal boundaries without fallback guessing', () => {
    for (const [locale, date] of [
      ['en-US', '08/22/2026'],
      ['de-DE', '22.08.2026'],
      ['fr-FR', '22/08/2026'],
      ['es-ES', '22/08/2026'],
      ['it-IT', '22/08/2026'],
      ['pt-PT', '22/08/2026'],
      ['nl-NL', '22/08/2026'],
      ['pl-PL', '22.08.2026'],
    ] as const) {
      assert.deepEqual(parseLabDate(date, locale), { kind: 'known', value: '2026-08-22' });
    }
    assert.equal(parseComparatorValue('1.234,56')?.kind, 'numeric');
    assert.equal(parseComparatorValue('1.234,56')?.value, 1234.56);
  });

  it('infers unambiguous numeric date order before device locale', () => {
    assert.deepEqual(parseLabDate('20.08.2026', 'en-US'), {
      kind: 'known',
      value: '2026-08-20',
    });
    assert.deepEqual(parseLabDate('08/22/2026', 'de-DE'), {
      kind: 'known',
      value: '2026-08-22',
    });
  });

  it('maps aliases anywhere in table rows while selecting only an unambiguous result token', () => {
    const texts = [
      ['ng/mL  31  30 - 100  Vitamin D(25-OH)', 'biomarker.vitamin_d_total', 31, 'ng/mL'],
      ['mg/dL  LDL cholesterol  H  <115  118', 'biomarker.ldl_c', 118, 'mg/dL'],
      ['62  mg/dL  > 40  HDL cholesterol', 'biomarker.hdl_c', 62, 'mg/dL'],
      ['mg/dL  < 150  92  Triglycerides', 'biomarker.triglycerides', 92, 'mg/dL'],
      ['4.0 - 5.6  5.2  %  HbA1c', 'biomarker.hba1c', 5.2, '%'],
    ] as const;
    const rows = groupObservationsIntoRows(
      texts.map(([text], index) => ({
        id: `table-${index}`,
        text,
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.1 + index * 0.1, width: 0.8, height: 0.04 },
        pageIndex: 0,
        orientation: 0,
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      })),
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-20' } },
    );
    assert.equal(rows.length, texts.length);
    for (const [index, [, biomarkerId, value, unit]] of texts.entries()) {
      const row = rows[index];
      assert.equal(row?.proposedBiomarkerId, biomarkerId);
      assert.equal(row?.proposedValue.kind, 'numeric');
      assert.equal(row?.proposedValue.value, value);
      assert.equal(row?.proposedUnit, unit);
      assert.ok(!row?.reviewReasons.includes('unsupported-alias'));
    }
    assert.equal(rows[0]?.sourceLabel, 'Vitamin D(25-OH)');
    assert.equal(rows[1]?.sourceReferenceInterval, '<115');
    assert.equal(rows[2]?.sourceReferenceInterval, '> 40');
    assert.equal(rows[3]?.sourceReferenceInterval, '< 150');
    assert.equal(rows[4]?.sourceReferenceInterval, '4.0 - 5.6');
  });

  it('maps a known alias but flags multiple scalar tokens instead of guessing', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'ambiguous-table',
          text: 'mg/dL LDL cholesterol 100 118',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-20' } },
    );
    assert.equal(row?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.ok(row?.reviewReasons.includes('unsupported-layout'));
    assert.equal(row?.proposedValue.kind, 'free_text');
    assert.equal(row?.decision, 'skip');
    assert.equal(extractionReviewRequiresAttention(row!), true);
    assert.equal(extractionReviewBlocksConfirmation(row!), false);
    const edited = revalidateExtractionRow(
      row!,
      { proposedValue: { kind: 'numeric', value: 118 }, decision: 'preserve' },
      tableAliases,
    );
    assert.ok(edited.reviewReasons.includes('unsupported-layout'));
    assert.equal(edited.decision, 'preserve');
    assert.equal(
      buildExtractionConfirmationPlan(
        {
          id: 'ambiguous-draft',
          reportId: 'synthetic-report',
          state: 'draft',
          ocrContractVersion: 'alyte.vision.document.v2',
          parserVersion: EXTRACTION_PARSER_VERSION,
          collectionDate: { kind: 'known', value: '2026-08-20' },
          rows: row === undefined ? [] : [row],
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
          confirmedAt: null,
          pipelineFingerprint: null,
          pipelineStatus: 'older' as const,
          revision: 1,
          hasUserEdits: false,
        },
        { record: () => 'record', measurement: () => 'measurement' },
      ).records.length,
      0,
    );
  });

  it('keeps incompatible units review-only and blocks confirmation', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'incompatible-unit',
          text: 'LDL-C 3.8 g/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.8, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases: tableAliases, collectionDate: { kind: 'known', value: '2026-08-20' } },
    );
    assert.equal(row?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.ok(row?.reviewReasons.includes('incompatible-unit'));
    assert.equal(row?.reviewState, 'needs-review');
    assert.equal(row?.decision, 'skip');
    assert.equal(
      buildExtractionConfirmationPlan(
        {
          id: 'incompatible-unit-draft',
          reportId: 'synthetic-report',
          state: 'draft',
          ocrContractVersion: 'alyte.vision.document.v2',
          parserVersion: EXTRACTION_PARSER_VERSION,
          collectionDate: { kind: 'known', value: '2026-08-20' },
          rows: row === undefined ? [] : [row],
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
          confirmedAt: null,
          pipelineFingerprint: null,
          pipelineStatus: 'older' as const,
          revision: 1,
          hasUserEdits: false,
        },
        { record: () => 'record', measurement: () => 'measurement' },
      ).records.length,
      0,
    );
  });

  it('keeps a malformed multi-row OCR scalar review-only when its unit is missing', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'vision-multi-row-block',
          text: 'Triglycerides ReFEFeRCE 9.839 leference 0.0-1.7',
          alternatives: [],
          boundingBox: { x: 0.12, y: 0.42, width: 0.69, height: 0.03 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      {
        aliases: tableAliases,
        collectionDate: { kind: 'known', value: '2026-08-20' },
        specimenType: 'serum',
      },
    );
    assert.equal(row?.proposedBiomarkerId, 'biomarker.triglycerides');
    assert.deepEqual(row?.proposedValue, { kind: 'numeric', value: 9.839 });
    assert.equal(row?.proposedUnit, null);
    assert.ok(row?.reviewReasons.includes('missing-unit'));
    assert.equal(row?.reviewState, 'needs-review');
    assert.equal(row?.decision, 'skip');
    assert.equal(row === undefined ? false : extractionReviewRequiresAttention(row), true);
    assert.equal(row === undefined ? false : extractionReviewBlocksConfirmation(row), false);
    assert.equal(
      buildExtractionConfirmationPlan(
        {
          id: 'multi-row-draft',
          reportId: 'synthetic-report',
          state: 'draft',
          ocrContractVersion: 'alyte.vision.document.v2',
          parserVersion: EXTRACTION_PARSER_VERSION,
          collectionDate: { kind: 'known', value: '2026-08-20' },
          rows: row === undefined ? [] : [row],
          createdAt: '2026-08-20T00:00:00.000Z',
          updatedAt: '2026-08-20T00:00:00.000Z',
          confirmedAt: null,
          pipelineFingerprint: null,
          pipelineStatus: 'older' as const,
          revision: 1,
          hasUserEdits: false,
        },
        { record: () => 'record', measurement: () => 'measurement' },
      ).records.length,
      0,
    );
  });

  it('keeps separated three-row table observations distinct with exact source provenance', () => {
    const rows = groupObservationsIntoRows(
      [
        ['ldl-row', 'LDL-C 3,8 mmol/L', 0.2, 3.8, 'biomarker.ldl_c'],
        ['hdl-row', 'HDL-C 1,4 mmol/L', 0.3, 1.4, 'biomarker.hdl_c'],
        ['triglycerides-row', 'Triglycerides 1,2 mmol/L', 0.4, 1.2, 'biomarker.triglycerides'],
      ].map(([id, text, y]) => ({
        id: id as string,
        text: text as string,
        alternatives: [],
        boundingBox: { x: 0.12, y: y as number, width: 0.69, height: 0.03 },
        pageIndex: 0,
        orientation: 0,
        structure: {
          kind: 'table-cell' as const,
          tableId: 'synthetic-lipids',
          rowIndex: Math.round(((y as number) - 0.2) * 10),
          columnIndex: 0,
        },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      })),
      {
        aliases: tableAliases,
        locale: 'de-DE',
        collectionDate: { kind: 'known', value: '2026-08-20' },
        specimenType: 'serum',
      },
    );
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => [row.id, row.proposedBiomarkerId, row.proposedValue, row.proposedUnit]),
      [
        ['ldl-row', 'biomarker.ldl_c', { kind: 'numeric', value: 3.8 }, 'mmol/L'],
        ['hdl-row', 'biomarker.hdl_c', { kind: 'numeric', value: 1.4 }, 'mmol/L'],
        ['triglycerides-row', 'biomarker.triglycerides', { kind: 'numeric', value: 1.2 }, 'mmol/L'],
      ],
    );
    assert.deepEqual(
      rows.map((row) => ({ ids: row.source.observationIds, box: row.source.boundingBox })),
      [
        {
          ids: ['ldl-row'],
          box: { x: 0.12, y: 0.2, width: 0.69, height: 0.03 },
        },
        {
          ids: ['hdl-row'],
          box: { x: 0.12, y: 0.3, width: 0.69, height: 0.03 },
        },
        {
          ids: ['triglycerides-row'],
          box: { x: 0.12, y: 0.4, width: 0.69, height: 0.03 },
        },
      ],
    );
    assert.deepEqual(
      rows.map((row) => [
        row.sourceValueString,
        row.sourceUnit,
        row.source.observations?.[0]?.text,
      ]),
      [
        ['3,8', 'mmol/L', 'LDL-C 3,8 mmol/L'],
        ['1,4', 'mmol/L', 'HDL-C 1,4 mmol/L'],
        ['1,2', 'mmol/L', 'Triglycerides 1,2 mmol/L'],
      ],
    );
  });

  it('keeps a bounded result when no separate scalar result is present', () => {
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'bounded-result',
          text: 'LDL-C <3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-20' } },
    );
    assert.deepEqual(row?.proposedValue, { kind: 'bounded', comparator: '<', value: 3.8 });
    assert.equal(row?.proposedReferenceInterval, null);
  });

  it('preserves a laboratory reference interval and flag separately from the measured value', () => {
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'r',
          text: 'LDL-C 3,8 mmol/L 0-3,0 H',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.04 },
          pageIndex: 1,
          orientation: 90,
          recognition: { level: 'accurate', language: 'de', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-22' }, specimenType: 'blood' },
    );
    assert.equal(rows[0]?.sourceValueString, '3,8');
    assert.equal(rows[0]?.sourceReferenceInterval, '0-3,0');
    assert.equal(rows[0]?.sourceFlag, 'H');
    assert.equal(rows[0]?.proposedUnit, 'mmol/L');
  });

  it('builds stable grouped confirmation plans without interpolating source rows', () => {
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'r1',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: null, internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'missing' }, specimenType: 'blood' },
    );
    const draft = {
      id: 'draft-1',
      reportId: 'report-1',
      state: 'draft' as const,
      ocrContractVersion: 'alyte.vision.document.v2' as const,
      parserVersion: EXTRACTION_PARSER_VERSION,
      collectionDate: { kind: 'missing' as const },
      rows: rows.map((row) => ({ ...row, decision: 'preserve' as const })),
      createdAt: '2026-08-22T00:00:00.000Z',
      updatedAt: '2026-08-22T00:00:00.000Z',
      confirmedAt: null,
      pipelineFingerprint: null,
      pipelineStatus: 'older' as const,
      revision: 1,
      hasUserEdits: false,
    };
    const plan = buildExtractionConfirmationPlan(draft, {
      record: () => 'record-1',
      measurement: () => 'measurement-1',
    });
    assert.equal(plan.records.length, 1);
    assert.equal(plan.records[0]?.collectionDate.kind, 'missing');
    assert.equal(plan.records[0]?.measurements[0]?.source.pageIndex, 0);
  });

  it('keeps only measurement-shaped Lithuanian table rows with exact cell provenance', () => {
    const ltAliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.ldl_c',
        aliases: ['Mažo tankio lipoproteinų cholesterolis'],
        specimens: ['serum', 'unknown'],
        units: ['mmol/L'],
      },
    ];
    const texts = [
      ['header', 'Sintetinė laboratorija  Įmonės kodas 000000000'],
      ['ldl-label', 'Mažo tankio lipoproteinų cholesterolis'],
      ['ldl-value', '3,8'],
      ['ldl-unit', 'mmol/L'],
      ['ldl-range', '<3,0'],
      ['ldl-flag', 'H'],
      ['unknown-label', 'Nežinomas žymuo'],
      ['unknown-value', '<0,5'],
      ['unknown-unit', 'µg/L'],
      ['footer', 'Licencija Nr. 0000 synthetic.example'],
    ] as const;
    const observations = texts.map(([id, text], index) => ({
      id,
      text,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: {
        x: (index % 6) * 0.14,
        y: index < 1 ? 0.05 : index < 6 ? 0.3 : index < 9 ? 0.4 : 0.9,
        width: 0.13,
        height: 0.03,
      },
      structure: {
        kind: 'table-cell' as const,
        tableId: 'results',
        rowIndex: index < 1 ? 0 : index < 6 ? 1 : index < 9 ? 2 : 3,
        columnIndex: index % 6,
      },
      recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
    }));
    const rows = groupObservationsIntoRows(observations, {
      aliases: ltAliases,
      specimenType: 'serum',
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.sourceLabel, 'Mažo tankio lipoproteinų cholesterolis');
    assert.equal(rows[0]?.sourceValueString, '3,8');
    assert.deepEqual(rows[0]?.source.observationIds, [
      'ldl-label',
      'ldl-value',
      'ldl-unit',
      'ldl-range',
      'ldl-flag',
    ]);
    assert.equal(rows[1]?.proposedBiomarkerId, null);
  });

  it('rejects semantic proposals that invent source IDs or catalogue mappings', () => {
    const observation = {
      id: 'source-1',
      text: 'LDL 3.8 mmol/L',
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    };
    const valid = validateSemanticProposals(
      [
        { sourceObservationIds: ['source-1'], proposedBiomarkerId: 'biomarker.ldl_c' as never },
        { sourceObservationIds: ['invented'], proposedBiomarkerId: 'biomarker.ldl_c' as never },
        { sourceObservationIds: ['source-1'], proposedBiomarkerId: 'biomarker.invented' as never },
        {
          sourceObservationIds: ['source-1'],
          proposedBiomarkerId: 'biomarker.ldl_c',
          value: '4.2',
          unit: 'mg/dL',
          medicalCopy: 'invented explanation',
        },
      ],
      [observation],
      aliases,
    );
    assert.deepEqual(valid, [
      { sourceObservationIds: ['source-1'], proposedBiomarkerId: 'biomarker.ldl_c' },
    ]);
  });

  it('keeps a loose multi-cell row eligible while rejecting cross-row proposals', () => {
    const observations = [
      {
        id: 'loose-label',
        text: 'LDL-C',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.1, y: 0.2, width: 0.2, height: 0.04 },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
      {
        id: 'loose-value',
        text: '3.8 mmol/L',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.5, y: 0.202, width: 0.2, height: 0.04 },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
      {
        id: 'other-row',
        text: '4.1 mmol/L',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.5, y: 0.35, width: 0.2, height: 0.04 },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
    ];
    const looseRow = validateSemanticProposals(
      {
        schemaVersion: 'alyte.semantic-mapper.v1',
        proposals: [
          {
            sourceObservationIds: ['loose-label', 'loose-value'],
            proposedBiomarkerId: 'biomarker.ldl_c',
            role: 'measurement',
          },
        ],
      },
      observations,
      aliases,
    );
    assert.equal(looseRow.length, 1);
    const crossRow = validateSemanticProposals(
      {
        schemaVersion: 'alyte.semantic-mapper.v1',
        proposals: [
          {
            sourceObservationIds: ['loose-label', 'other-row'],
            proposedBiomarkerId: 'biomarker.ldl_c',
            role: 'measurement',
          },
        ],
      },
      observations,
      aliases,
    );
    assert.deepEqual(crossRow, []);
  });

  it('rejects ambiguous duplicate semantic field aliases', () => {
    const observation = {
      id: 'source-2',
      text: 'LDL-C 3.8 mmol/L',
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    };
    assert.deepEqual(
      validateSemanticProposals(
        {
          schemaVersion: 'alyte.semantic-mapper.v1',
          proposals: [
            {
              sourceObservationIds: ['source-2'],
              proposedBiomarkerId: 'biomarker.ldl_c',
              biomarkerId: 'biomarker.ldl_c',
            },
          ],
        },
        [observation],
        aliases,
      ),
      [],
    );
  });

  it('reparses noisy Lithuanian multi-column rows from selected source cells', () => {
    const observations = [
      ['lt-label', 'mažo tankio lipoproteinų cholesterolis', 0.05],
      ['lt-value', '3,8', 0.25],
      ['lt-unit', 'mmol/L', 0.42],
      ['lt-range', '<3,0', 0.56],
      ['lt-flag', 'H', 0.7],
      ['lt-method', 'IFCC', 0.8],
      ['lt-noisy-value', '1,2', 0.88],
      ['lt-accession', 'KRA-2026-AB', 0.96],
    ].map(([id, text, x]) => ({
      id: id as string,
      text: text as string,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x: x as number, y: 0.2, width: 0.08, height: 0.03 },
      structure: {
        kind: 'table-cell' as const,
        tableId: 'lt-results',
        rowIndex: 4,
        columnIndex: Math.round((x as number) * 10),
      },
      recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
    }));
    const aliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.ldl_c',
        aliases: ['mažo tankio lipoproteinų cholesterolis'],
        specimens: ['serum'],
        units: ['mmol/L'],
      },
    ];
    const row = groupObservationsIntoRows(observations, {
      aliases,
      locale: 'lt-LT',
      specimenType: 'serum',
      collectionDate: { kind: 'known', value: '2026-08-22' },
    })[0];
    assert.ok(row);
    assert.ok(row.reviewReasons.includes('unsupported-layout'));
    const sourceText = row.sourceText;
    const sourceRaw = row.source.raw;
    const reparsed = reparseExtractionRowFromSemanticFields(
      row,
      {
        label: 'lt-label',
        value: 'lt-value',
        unit: 'lt-unit',
        referenceInterval: 'lt-range',
        flag: 'lt-flag',
      },
      aliases,
    );
    assert.equal(reparsed.sourceText, sourceText);
    assert.deepEqual(reparsed.source.raw, sourceRaw);
    assert.deepEqual(
      reparsed.source.observations?.map((observation) => observation.id),
      observations.map((observation) => observation.id),
    );
    assert.deepEqual(reparsed.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.equal(reparsed.proposedUnit, 'mmol/L');
    assert.equal(reparsed.proposedReferenceInterval, '<3,0');
    assert.equal(reparsed.proposedFlag, 'H');
    assert.equal(reparsed.reviewReasons.includes('unsupported-layout'), false);
    const semanticRow = {
      ...reparsed,
      source: {
        ...reparsed.source,
        semantic: {
          adapterVersion: 'synthetic.mapper.v2',
          schemaVersion: 'alyte.semantic-mapper.v2' as const,
          sourceObservationIds: observations.map((observation) => observation.id),
          sourceFieldObservationIds: {
            label: 'lt-label',
            value: 'lt-value',
            unit: 'lt-unit',
            referenceInterval: 'lt-range',
            flag: 'lt-flag',
          },
        },
      },
    };
    const confirmation = buildExtractionConfirmationPlan(
      {
        id: 'semantic-confirmation',
        reportId: 'synthetic-report',
        state: 'draft',
        ocrContractVersion: 'alyte.vision.document.v2',
        parserVersion: EXTRACTION_PARSER_VERSION,
        collectionDate: { kind: 'known', value: '2026-08-22' },
        rows: [semanticRow],
        createdAt: '2026-08-22T00:00:00.000Z',
        updatedAt: '2026-08-22T00:00:00.000Z',
        confirmedAt: null,
        pipelineFingerprint: null,
        pipelineStatus: 'older' as const,
        revision: 1,
        hasUserEdits: false,
      },
      { record: () => 'record', measurement: () => 'measurement' },
    );
    const confirmedMeasurement = confirmation.records[0]?.measurements[0];
    assert.equal(confirmedMeasurement?.original.valueString, '3,8');
    assert.equal(confirmedMeasurement?.provenance, 'extracted');
    assert.equal(confirmedMeasurement?.source.observations?.length, observations.length);
    assert.throws(
      () =>
        reparseExtractionRowFromSemanticFields(
          row,
          {
            label: 'lt-label',
            value: 'lt-unit',
            unit: null,
            referenceInterval: null,
            flag: null,
          },
          aliases,
        ),
      /semantic-source-value-unparseable/,
    );
    const resultFirst = reparseExtractionRowFromSemanticFields(
      row,
      {
        // Semantic roles are intentionally independent of their physical column order.
        label: 'lt-label',
        value: 'lt-noisy-value',
        unit: 'lt-unit',
        referenceInterval: 'lt-range',
        flag: null,
      },
      aliases,
    );
    assert.deepEqual(resultFirst.proposedValue, { kind: 'numeric', value: 1.2 });
  });

  it('cleans locale-formatted noisy labels only when the remaining alias is unique', () => {
    const observations = [
      ['de-label', 'LDL-Cholesterin 3,8 mmol/L', 0.05],
      ['de-value', '3,8', 0.42],
      ['de-unit', 'mmol/L', 0.56],
      ['de-range', '1,0–4,0', 0.7],
    ].map(([id, text, x]) => ({
      id: id as string,
      text: text as string,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x: x as number, y: 0.2, width: 0.1, height: 0.03 },
      structure: {
        kind: 'table-cell' as const,
        tableId: 'de-results',
        rowIndex: 2,
        columnIndex: Math.round((x as number) * 10),
      },
      recognition: { level: 'accurate' as const, language: 'de', internalConfidence: null },
    }));
    const aliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.ldl_c',
        aliases: ['LDL-Cholesterin'],
        specimens: ['serum'],
        units: ['mmol/L'],
      },
    ];
    const row = groupObservationsIntoRows(observations, {
      aliases,
      locale: 'de-DE',
      specimenType: 'serum',
      collectionDate: { kind: 'known', value: '2026-08-22' },
    })[0];
    assert.ok(row);
    const sourceText = row.sourceText;
    const sourceRaw = row.source.raw;
    const cleaned = reparseExtractionRowFromSemanticFields(
      row,
      {
        label: 'de-label',
        value: 'de-value',
        unit: 'de-unit',
        referenceInterval: 'de-range',
        flag: null,
      },
      aliases,
    );
    assert.equal(cleaned.proposedLabel, 'LDL-Cholesterin');
    assert.equal(cleaned.sourceText, sourceText);
    assert.deepEqual(cleaned.source.raw, sourceRaw);

    const ambiguous = reparseExtractionRowFromSemanticFields(
      row,
      {
        label: 'de-label',
        value: 'de-value',
        unit: 'de-unit',
        referenceInterval: 'de-range',
        flag: null,
      },
      [
        ...aliases,
        {
          id: 'biomarker.hdl_c',
          aliases: ['LDL-Cholesterin'],
          specimens: ['serum'],
          units: ['mmol/L'],
        },
      ],
    );
    assert.equal(ambiguous.proposedLabel, 'LDL-Cholesterin 3,8 mmol/L');
  });
});

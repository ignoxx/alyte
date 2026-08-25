import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { metabolicMicronutrientBiomarkers } from '@alyte/catalogue';
import {
  buildExtractionConfirmationPlan,
  decodeVisionOCRResult,
  EXTRACTION_PARSER_VERSION,
  extractionReviewBlocksConfirmation,
  extractionReviewRequiresAttention,
  groupObservationsIntoRows,
  parseComparatorValue,
  parseLabDate,
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
});

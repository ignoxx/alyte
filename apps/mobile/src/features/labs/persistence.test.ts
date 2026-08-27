import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { comparableBiomarkers } from '@alyte/catalogue';
import {
  buildMeasuredTrend,
  canonicalId,
  createSanitizationRecipe,
  EXTRACTION_PARSER_VERSION,
  groupObservationsIntoRows,
  type ExtractionAliasEntry,
} from '@alyte/domain';
import { CURRENT_SCHEMA_VERSION, createLabRepository, type SqliteDatabase } from './persistence';
import { ProtectionError, type DatabaseProtection, type ProtectionOptions } from './protection';
import { createLabsService } from './service';

class NodeSqliteDatabase implements SqliteDatabase {
  readonly databasePath: string;
  private readonly database: DatabaseSync;

  constructor(databasePath: string) {
    this.databasePath = databasePath;
    this.database = new DatabaseSync(databasePath);
  }

  async execAsync(source: string): Promise<void> {
    this.database.exec(source);
  }

  async runAsync(source: string, ...params: any[]) {
    const result = this.database.prepare(source).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowId: Number(result.lastInsertRowid),
    };
  }

  async getAllAsync<T>(source: string, ...params: any[]): Promise<readonly T[]> {
    return this.database.prepare(source).all(...params) as T[];
  }

  async withTransactionAsync(task: () => Promise<void>): Promise<void> {
    this.database.exec('BEGIN');
    try {
      await task();
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async closeAsync(): Promise<void> {
    this.database.close();
  }
}

const protectedPaths: string[] = [];
const protection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath, options: ProtectionOptions = {}) {
    protectedPaths.push(databasePath);
    return {
      protectedPaths:
        options.requireSidecars === true
          ? [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
          : [databasePath],
      missingSidecarPaths:
        options.requireSidecars === true ? [] : [`${databasePath}-wal`, `${databasePath}-shm`],
    };
  },
};

const temporaryPaths: string[] = [];

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) {
    rmSync(path, { recursive: true, force: true });
  }
  protectedPaths.length = 0;
});

function temporaryDatabase(): string {
  const directory = mkdtempSync(join(tmpdir(), 'alyte-labs-'));
  temporaryPaths.push(directory);
  return join(directory, 'alyte.sqlite');
}

function createRepository(databasePath = temporaryDatabase(), databaseProtection = protection) {
  const database = new NodeSqliteDatabase(databasePath);
  const repository = createLabRepository(database, {
    protection: databaseProtection,
    now: () => '2026-08-22T10:00:00.000Z',
    idGenerator: (prefix) => `${prefix}-fixed-${Math.random().toString(36).slice(2)}`,
  });
  return { database, repository, databasePath };
}

describe('protected manual Lab Record persistence', () => {
  test('sanitization draft survives relaunch without becoming a verified artifact', async () => {
    const path = temporaryDatabase();
    const first = createRepository(path);
    const recipe = createSanitizationRecipe('report-draft', [
      {
        pageIndex: 0,
        selected: true,
        crop: { x: 0.1, y: 0.1, width: 0.8, height: 0.8 },
        rotation: 270,
        redactions: [
          {
            id: 'redaction-1',
            rect: { x: 0.2, y: 0.3, width: 0.2, height: 0.1 },
            origin: 'user',
            label: null,
          },
        ],
      },
    ]);
    await first.repository.saveSanitizationDraft('report-draft', recipe);
    await first.repository.close();
    const second = createRepository(path);
    assert.deepEqual(await second.repository.getSanitizationDraft('report-draft'), recipe);
    assert.equal(await second.repository.getSanitizedReport('report-draft'), null);
    await second.repository.clearSanitizationDraft('report-draft');
    assert.equal(await second.repository.getSanitizationDraft('report-draft'), null);
    await second.repository.close();
  });
  test('Extraction Draft preserves source locations and confirms atomically/idempotently', async () => {
    const { repository, database, databasePath } = createRepository();
    await repository.createReport({
      id: 'report-extraction',
      sourceType: 'image',
      originalFilename: 'synthetic-en.png',
      mimeType: 'image/png',
      importState: 'imported',
      originalPath: 'protected://original/synthetic-en.png',
      sourceHash: 'synthetic-hash',
      pageCount: 1,
    });
    const aliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.ldl_c',
        aliases: ['LDL-C'],
        specimens: ['blood', 'unknown'],
        units: ['mmol/L'],
      },
    ];
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'source-row-1',
          text: ' LDL-C 3,8 mmol/L ',
          alternatives: ['LDL-C 3.6 mmol/L'],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
          structure: { kind: 'table-cell', tableId: 'table-0', rowIndex: 1, columnIndex: 0 },
        },
      ],
      { aliases, collectionDate: { kind: 'missing' }, specimenType: 'blood' },
    );
    const draft = await repository.createExtractionDraft({
      id: 'draft-extraction',
      reportId: 'report-extraction',
      collectionDate: { kind: 'missing' },
      rows: [
        ...rows.map((row) => ({
          ...row,
          panelLabel: 'Synthetic lipid panel',
          decision: 'preserve' as const,
        })),
        ...rows.map((row) => ({
          ...row,
          id: `${row.id}-skipped`,
          order: row.order + 1,
          decision: 'skip' as const,
        })),
      ],
    });
    assert.equal(draft.rows[0]?.source.pageIndex, 0);
    assert.equal(draft.rows[0]?.source.observations?.[0]?.text, ' LDL-C 3,8 mmol/L ');
    assert.equal(draft.rows[0]?.source.raw?.value, '3,8');
    assert.equal(draft.rows[0]?.source.raw?.unit, 'mmol/L');
    assert.equal(draft.rows[0]?.source.observations?.[0]?.structure?.tableId, 'table-0');
    await database.closeAsync();
    const relaunched = createRepository(databasePath);
    const reopened = await relaunched.repository.getExtractionDraft(draft.id);
    assert.equal(reopened?.rows[0]?.source.observations?.[0]?.text, ' LDL-C 3,8 mmol/L ');
    assert.equal(reopened?.rows[0]?.source.raw?.value, '3,8');
    const records = await relaunched.repository.confirmExtractionDraft(draft.id);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.collectionDate.kind, 'missing');
    assert.equal(records[0]?.specimenType, 'blood');
    assert.equal(records[0]?.measurements[0]?.source?.boundingBox.x, 0.1);
    assert.deepEqual(records[0]?.measurements[0]?.source?.observationIds, ['source-row-1']);
    assert.equal(
      records[0]?.measurements[0]?.source?.observations?.[0]?.text,
      ' LDL-C 3,8 mmol/L ',
    );
    assert.equal(records[0]?.measurements[0]?.original.valueString, '3,8');
    assert.equal(records[0]?.measurements[0]?.original.value.kind, 'numeric');
    assert.equal(records[0]?.measurements[0]?.current.valueString, '3.8');
    assert.equal(records[0]?.measurements[0]?.panelLabel, 'Synthetic lipid panel');
    const repeated = await relaunched.repository.confirmExtractionDraft(draft.id);
    assert.deepEqual(
      repeated.map((record) => record.id),
      records.map((record) => record.id),
    );
    assert.equal(
      (
        await relaunched.database.getAllAsync(
          'SELECT id FROM lab_records WHERE lab_report_id = ?',
          'report-extraction',
        )
      ).length,
      1,
    );
    assert.equal(
      (
        await relaunched.database.getAllAsync(
          'SELECT id FROM measurements WHERE lab_record_id = ?',
          records[0]?.id,
        )
      ).length,
      1,
    );
    const preservedDraft = await relaunched.repository.getExtractionDraft(draft.id);
    assert.equal(preservedDraft?.rows[0]?.sourceText, 'LDL-C 3,8 mmol/L');
    assert.equal(preservedDraft?.rows[1]?.decision, 'skip');
    assert.equal(preservedDraft?.rows[1]?.sourceText, 'LDL-C 3,8 mmol/L');
    assert.equal(
      (await relaunched.repository.getRecord(records[0]!.id))?.measurements[0]?.panelLabel,
      'Synthetic lipid panel',
    );
    await relaunched.repository.close();
  });

  test('allocates distinct persisted row identities for drafts with repeated OCR observation IDs', async () => {
    const { repository } = createRepository();
    const reportInput = (id: string) => ({
      id,
      sourceType: 'image' as const,
      originalFilename: `${id}.png`,
      mimeType: 'image/png',
      importState: 'imported' as const,
      originalPath: `protected://original/${id}.png`,
      sourceHash: `${id}-hash`,
      pageCount: 1,
    });
    await repository.createReport(reportInput('report-repeated-a'));
    await repository.createReport(reportInput('report-repeated-b'));

    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'document-0-0-table-0-r1-c0',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
          structure: { kind: 'table-cell', tableId: 'table-0', rowIndex: 1, columnIndex: 0 },
        },
      ],
      {
        aliases: [
          {
            id: 'biomarker.ldl_c',
            aliases: ['LDL-C'],
            specimens: ['blood', 'unknown'],
            units: ['mmol/L'],
          },
        ],
        collectionDate: { kind: 'known', value: '2026-08-22' },
        specimenType: 'blood',
      },
    );
    assert.ok(row);

    const first = await repository.createExtractionDraft({
      id: 'draft-repeated-a',
      reportId: 'report-repeated-a',
      collectionDate: { kind: 'known', value: '2026-08-22' },
      rows: [row],
    });
    const second = await repository.createExtractionDraft({
      id: 'draft-repeated-b',
      reportId: 'report-repeated-b',
      collectionDate: { kind: 'known', value: '2026-08-23' },
      rows: [row],
    });

    assert.notEqual(first.rows[0]?.id, row.id);
    assert.notEqual(second.rows[0]?.id, row.id);
    assert.notEqual(first.rows[0]?.id, second.rows[0]?.id);
    assert.deepEqual(first.rows[0]?.source.observationIds, [row.source.observationIds[0]]);
    assert.deepEqual(second.rows[0]?.source.observationIds, [row.source.observationIds[0]]);
    await repository.close();
  });

  test('fails closed when stored extraction artifact provenance is malformed or inconsistent', async () => {
    const { repository, database } = createRepository();
    await repository.createReport({
      id: 'report-artifact-provenance',
      sourceType: 'image',
      originalFilename: 'synthetic-provenance.png',
      mimeType: 'image/png',
      importState: 'imported',
      originalPath: 'protected://original/synthetic-provenance.png',
      sourceHash: 'original-artifact-hash',
      pageCount: 1,
    });
    const artifact = { kind: 'original' as const, id: null, hash: 'original-artifact-hash' };
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'provenance-row',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases: [], artifact },
    );
    assert.ok(row);
    await assert.rejects(
      repository.createExtractionDraft({
        id: 'provenance-mismatch-before-write',
        reportId: 'report-artifact-provenance',
        collectionDate: { kind: 'missing' },
        rows: [
          {
            ...row,
            source: {
              ...row.source,
              artifact: { kind: 'sanitized', id: 'derivative-id', hash: 'derivative-hash' },
            },
          },
        ],
        sourceArtifact: artifact,
      }),
      /source artifact provenance does not match its rows/,
    );
    assert.equal(
      (
        await database.getAllAsync<{ count: number }>(
          'SELECT COUNT(*) AS count FROM extraction_drafts WHERE id = ?;',
          'provenance-mismatch-before-write',
        )
      )[0]?.count,
      0,
    );
    const draft = await repository.createExtractionDraft({
      id: 'provenance-draft',
      reportId: 'report-artifact-provenance',
      collectionDate: { kind: 'missing' },
      rows: [row],
      sourceArtifact: artifact,
    });

    await database.runAsync(
      `UPDATE extraction_drafts
       SET source_artifact_id = 'must-be-null-for-original'
       WHERE id = ?;`,
      draft.id,
    );
    await assert.rejects(
      repository.getExtractionDraft(draft.id),
      /Invalid Original source artifact provenance/,
    );

    await database.runAsync(
      `UPDATE extraction_drafts
       SET source_artifact_id = NULL
       WHERE id = ?;`,
      draft.id,
    );
    const stored = (
      await database.getAllAsync<{ source_bbox_json: string }>(
        'SELECT source_bbox_json FROM extraction_draft_rows WHERE draft_id = ?;',
        draft.id,
      )
    )[0];
    assert.ok(stored);
    const sourceBox = JSON.parse(stored.source_bbox_json) as Record<string, unknown>;
    sourceBox.artifact = { kind: 'sanitized', id: 'derivative-id', hash: 'derivative-hash' };
    await database.runAsync(
      'UPDATE extraction_draft_rows SET source_bbox_json = ? WHERE draft_id = ?;',
      JSON.stringify(sourceBox),
      draft.id,
    );
    await assert.rejects(
      repository.getExtractionDraft(draft.id),
      /source artifact provenance does not match/,
    );
    await repository.close();
  });

  test('relaunch reconciles an active extraction operation without touching the Original report', async () => {
    const path = temporaryDatabase();
    const first = createRepository(path);
    await first.repository.createReport({
      id: 'report-interrupted-extraction',
      sourceType: 'image',
      originalFilename: 'synthetic-interrupted.png',
      mimeType: 'image/png',
      importState: 'imported',
      originalPath: 'protected://original/synthetic-interrupted.png',
      sourceHash: 'interrupted-original-hash',
      pageCount: 1,
    });
    await first.repository.upsertExtractionOperation({
      reportId: 'report-interrupted-extraction',
      state: 'active',
      stage: 'ocr',
      completed: 1,
      total: 2,
      error: null,
      createdAt: '2026-08-22T09:00:00.000Z',
      updatedAt: '2026-08-22T09:00:01.000Z',
    });
    await first.repository.close();

    const second = createRepository(path);
    const operation = await second.repository.getExtractionOperation(
      'report-interrupted-extraction',
    );
    assert.equal(operation?.state, 'interrupted');
    assert.equal(operation?.error, 'interrupted-after-relaunch');
    assert.equal(
      (await second.repository.getReport('report-interrupted-extraction'))?.sourceHash,
      'interrupted-original-hash',
    );
    await second.repository.close();
  });

  test('revalidates open drafts created by the previous parser policy before confirmation', async () => {
    const { repository, database } = createRepository();
    await repository.createReport({
      id: 'report-stale-parser',
      sourceType: 'image',
      originalFilename: 'synthetic-stale-parser.png',
      mimeType: 'image/png',
      importState: 'imported',
      originalPath: 'protected://original/synthetic-stale-parser.png',
      sourceHash: 'synthetic-stale-parser-hash',
      pageCount: 1,
    });
    const aliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.triglycerides',
        aliases: ['Triglycerides'],
        specimens: ['blood', 'unknown'],
        units: ['mmol/L'],
      },
    ];
    const [row] = groupObservationsIntoRows(
      [
        {
          id: 'stale-source',
          text: 'Triglycerides 9.839 8.3 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      { aliases, collectionDate: { kind: 'known', value: '2026-08-20' }, specimenType: 'blood' },
    );
    assert.ok(row);
    const draft = await repository.createExtractionDraft({
      id: 'stale-parser-draft',
      reportId: 'report-stale-parser',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      rows: [{ ...row, reviewReasons: [], reviewState: 'ready', decision: 'resolve' }],
    });
    await database.runAsync(
      'UPDATE extraction_drafts SET parser_version = ? WHERE id = ?;',
      'alyte.local-parser.v2',
      draft.id,
    );

    await assert.rejects(
      repository.confirmExtractionDraft(draft.id, aliases),
      /At least one extraction row must be included/,
    );
    const reopened = await repository.getExtractionDraft(draft.id, aliases);
    assert.equal(reopened?.parserVersion, EXTRACTION_PARSER_VERSION);
    assert.ok(reopened?.rows[0]?.reviewReasons.includes('unsupported-layout'));
    assert.equal(reopened?.rows[0]?.decision, 'skip');
    assert.equal(
      (
        await database.getAllAsync<{ parser_version: string }>(
          'SELECT parser_version FROM extraction_drafts WHERE id = ?;',
          draft.id,
        )
      )[0]?.parser_version,
      EXTRACTION_PARSER_VERSION,
    );
  });

  test('includes valid extraction by default and keeps source provenance through correction', async () => {
    const { repository } = createRepository();
    await repository.createReport({
      id: 'report-decision',
      sourceType: 'image',
      originalFilename: 'synthetic-decision.png',
      mimeType: 'image/png',
      importState: 'imported',
      originalPath: 'protected://original/synthetic-decision.png',
      sourceHash: 'decision-hash',
      pageCount: 1,
    });
    const aliases: readonly ExtractionAliasEntry[] = [
      {
        id: 'biomarker.ldl_c',
        aliases: ['LDL-C'],
        specimens: ['blood'],
        units: ['mmol/L'],
      },
    ];
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'decision-source',
          text: 'LDL-C 3,8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.2, y: 0.3, width: 0.4, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'de', internalConfidence: null },
        },
      ],
      {
        aliases,
        collectionDate: { kind: 'known', value: '2026-08-22' },
        specimenType: 'blood',
      },
    );
    const draft = await repository.createExtractionDraft({
      id: 'draft-decision',
      reportId: 'report-decision',
      collectionDate: { kind: 'known', value: '2026-08-22' },
      rows,
    });
    assert.equal(draft.rows[0]?.decision, 'resolve');
    const invalidReference = await repository.updateExtractionDraftRow(
      rows[0]!.id,
      { proposedReferenceInterval: 'not-a-range' },
      aliases,
    );
    assert.ok(invalidReference.reviewReasons.includes('unparseable-reference-interval'));
    const corrected = await repository.updateExtractionDraftRow(
      rows[0]!.id,
      {
        proposedValue: { kind: 'numeric', value: 4.2 },
        proposedReferenceInterval: null,
        decision: 'resolve',
      },
      aliases,
    );
    assert.equal(corrected.decision, 'resolve');
    const records = await repository.confirmExtractionDraft(draft.id);
    const measurement = records[0]!.measurements[0]!;
    assert.equal(measurement.original.valueString, '3,8');
    assert.equal(measurement.original.value.value, 3.8);
    assert.equal(measurement.current.value.value, 4.2);
    assert.equal(measurement.provenance, 'user-corrected');
    assert.deepEqual(measurement.source?.observationIds, ['decision-source']);
    const reopened = await repository.getRecord(records[0]!.id);
    assert.deepEqual(reopened?.measurements[0]?.source?.observationIds, ['decision-source']);
  });

  test('migration and typed repository preserve every manual value kind', async () => {
    const { repository, database } = createRepository();
    const record = await repository.createRecord({
      id: 'lab-record-1',
      collectionDate: { kind: 'missing' },
      specimenType: 'blood',
      measurements: [
        {
          id: 'measurement-number',
          label: 'LDL-C',
          value: { kind: 'numeric', value: 3.2 },
          unit: 'mmol/L',
        },
        {
          id: 'measurement-bound',
          label: 'Vitamin D',
          value: { kind: 'bounded', comparator: '<', value: 20 },
          valueString: '>999',
          unit: 'ng/mL',
        },
        {
          id: 'measurement-category',
          label: 'Blood group',
          value: { kind: 'categorical', value: 'O+' },
        },
        {
          id: 'measurement-text',
          label: 'Comment',
          value: { kind: 'free_text', value: 'fasting sample' },
        },
      ],
    });

    assert.equal(record.collectionDate.kind, 'missing');
    assert.deepEqual(
      record.measurements.map((measurement) => measurement.current.value.kind),
      ['numeric', 'bounded', 'categorical', 'free_text'],
    );
    assert.equal(record.measurements[1]?.current.valueString, '<20');
    assert.equal(protectedPaths.length > 0, true);

    const migrationRows = await database.getAllAsync<{ version: number }>(
      'SELECT MAX(version) AS version FROM schema_migrations',
    );
    assert.equal(migrationRows[0]?.version, CURRENT_SCHEMA_VERSION);
    await repository.close();
  });

  test('LabsService maps manual labels after explicit confirmation without rewriting provenance', async () => {
    const { repository } = createRepository();
    const labs = createLabsService({ repositoryFactory: async () => repository });
    const created = await labs.createRecord({
      id: 'lab-record-safe-mapping',
      collectionDate: { kind: 'known', value: '2026-08-19' },
      specimenType: 'unknown',
      measurements: [
        {
          id: 'measurement-safe-mapping',
          label: 'Total cholesterol',
          value: { kind: 'numeric', value: 205 },
          unit: 'mg/dL',
        },
      ],
    });
    const mapped = created.measurements.find(
      (measurement) => measurement.id === 'measurement-safe-mapping',
    );
    assert.equal(mapped?.biomarkerId, canonicalId('biomarker.total_cholesterol'));
    assert.equal(mapped?.original.label, 'Total cholesterol');
    assert.equal(mapped?.provenance, 'user-entered');

    await repository.createReport({
      id: 'report-extracted-correction',
      sourceType: 'image',
      originalFilename: 'synthetic-extracted.png',
      mimeType: 'image/png',
      originalPath: 'protected://original/synthetic-extracted.png',
      sourceHash: 'synthetic-extracted-hash',
      importState: 'imported',
      pageCount: 1,
    });
    const extractedSource = {
      pageIndex: 0,
      boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
      orientation: 0,
      observationIds: ['extracted-observation'],
      raw: {
        label: 'CHOL',
        value: '210',
        unit: 'mg/dL',
        referenceInterval: null,
        flag: null,
        collectionDate: '2026-08-20',
      },
    };
    await repository.createRecord({
      id: 'lab-record-corrected-mapping',
      labReportId: 'report-extracted-correction',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      specimenType: 'unknown',
      measurements: [
        {
          id: 'measurement-preserved-then-corrected',
          label: 'CHOL',
          value: { kind: 'numeric', value: 210 },
          unit: 'mg/dL',
          provenance: 'extracted',
          reviewState: 'needs-review',
          source: extractedSource,
        },
      ],
    });
    const needsReview = await labs.correctMeasurement('measurement-preserved-then-corrected', {
      label: 'Total cholesterol',
      unit: 'mg/dL',
      specimenType: 'unknown',
      reviewState: 'needs-review',
      reason: 'Review mapped label',
    });
    assert.equal(needsReview.biomarkerId, null);
    assert.equal(needsReview.reviewState, 'needs-review');

    const corrected = await labs.correctMeasurement('measurement-preserved-then-corrected', {
      label: 'Total cholesterol',
      unit: 'mg/dL',
      specimenType: 'unknown',
      reviewState: 'confirmed',
      reason: 'Confirm mapped label',
    });
    assert.equal(corrected.biomarkerId, canonicalId('biomarker.total_cholesterol'));
    assert.equal(corrected.reviewState, 'confirmed');
    assert.equal(corrected.original.label, 'CHOL');
    assert.equal(corrected.original.valueString, '210');
    assert.equal(corrected.original.unit, 'mg/dL');
    assert.equal(corrected.originalState.biomarkerId, null);
    assert.equal(corrected.originalState.reviewState, 'needs-review');
    assert.equal(corrected.originalState.provenance, 'extracted');
    assert.deepEqual(corrected.originalState.source?.observationIds, ['extracted-observation']);
    assert.equal(corrected.provenance, 'user-corrected');
    assert.deepEqual(corrected.source?.observationIds, ['extracted-observation']);
    assert.deepEqual(corrected.source?.raw, extractedSource.raw);
    assert.equal(corrected.corrections[0]?.previous.provenance, 'extracted');
    assert.equal(corrected.corrections[0]?.previous.reviewState, 'needs-review');
    assert.deepEqual(corrected.corrections[0]?.previous.source?.observationIds, [
      'extracted-observation',
    ]);
    assert.equal(corrected.corrections[0]?.next.reviewState, 'needs-review');
    assert.equal(corrected.corrections[0]?.next.provenance, 'user-corrected');
    assert.deepEqual(corrected.corrections[0]?.next.source?.observationIds, [
      'extracted-observation',
    ]);
    assert.equal(corrected.corrections[1]?.previous.reviewState, 'needs-review');
    assert.equal(corrected.corrections[1]?.previous.provenance, 'user-corrected');
    assert.deepEqual(corrected.corrections[1]?.previous.source?.observationIds, [
      'extracted-observation',
    ]);
    assert.equal(corrected.corrections[1]?.next.reviewState, 'confirmed');
    assert.deepEqual(corrected.corrections[1]?.next.source?.observationIds, [
      'extracted-observation',
    ]);
    assert.equal(corrected.corrections[1]?.next.biomarkerId, corrected.biomarkerId);

    const detail = await labs.getRecordDetail('lab-record-safe-mapping');
    assert.equal(detail?.measurements[0]?.canonicalLabel, 'Total cholesterol');
    const correctedRecord = await labs.getRecord('lab-record-corrected-mapping');
    if (correctedRecord === null) throw new Error('Corrected Lab Record was not found');
    const trend = buildMeasuredTrend(
      [created, correctedRecord],
      canonicalId('biomarker.total_cholesterol'),
      comparableBiomarkers,
    );
    assert.deepEqual(
      trend.points.map((point) => point.normalized.value),
      [205, 210],
    );
    assert.equal(trend.direction, 'increased');
    await repository.close();
  });

  test('reopening the same database preserves records offline without an account', async () => {
    const databasePath = temporaryDatabase();
    const first = createRepository(databasePath);
    await first.repository.createRecord({
      id: 'lab-record-restart',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      measurements: [
        {
          id: 'measurement-restart',
          biomarkerId: canonicalId('biomarker.ldl_c'),
          label: 'LDL cholesterol',
          value: { kind: 'numeric', value: 3.1 },
          unit: 'mmol/L',
        },
      ],
    });
    await first.repository.close();

    const second = createRepository(databasePath);
    const reopened = await second.repository.getRecord('lab-record-restart');
    assert.equal(reopened?.measurements[0]?.current.valueString, '3.1');
    assert.equal(reopened?.measurements[0]?.original.label, 'LDL cholesterol');
    await second.repository.close();
  });

  test('correction stores prior user-entered provenance and a readable audit trail', async () => {
    const databasePath = temporaryDatabase();
    const { repository } = createRepository(databasePath);
    await repository.createRecord({
      id: 'lab-record-correction',
      collectionDate: { kind: 'known', value: '2026-08-20' },
      measurements: [
        {
          id: 'measurement-correction',
          biomarkerId: canonicalId('biomarker.ldl_c'),
          label: 'LDL-C',
          value: { kind: 'numeric', value: 3.2 },
          unit: 'mmol/L',
          referenceInterval: '<3.0',
          provenance: 'user-entered',
          source: {
            pageIndex: 0,
            boundingBox: { x: 0.1, y: 0.2, width: 0.3, height: 0.04 },
            orientation: 0,
            observationIds: ['manual-source'],
          },
        },
      ],
    });

    const corrected = await repository.correctMeasurement('measurement-correction', {
      biomarkerId: canonicalId('biomarker.total_cholesterol'),
      label: 'Total cholesterol',
      value: { kind: 'numeric', value: 3.8 },
      unit: 'mg/dL',
      referenceInterval: '100-200',
      flag: 'H',
      specimenType: 'serum',
      reviewState: 'needs-review',
      source: {
        pageIndex: 1,
        boundingBox: { x: 0.2, y: 0.3, width: 0.4, height: 0.05 },
        orientation: 90,
        observationIds: ['corrected-source'],
      },
      reason: 'Transcription correction',
    });
    assert.equal(corrected.provenance, 'user-corrected');
    assert.equal(corrected.original.valueString, '3.2');
    assert.equal(corrected.original.unit, 'mmol/L');
    assert.equal(corrected.biomarkerId, canonicalId('biomarker.total_cholesterol'));
    assert.equal(corrected.current.label, 'Total cholesterol');
    assert.equal(corrected.current.valueString, '3.8');
    assert.equal(corrected.current.unit, 'mg/dL');
    assert.equal(corrected.current.referenceInterval, '100-200');
    assert.equal(corrected.current.flag, 'H');
    assert.equal(corrected.specimenType, 'serum');
    assert.deepEqual(corrected.source?.observationIds, ['corrected-source']);
    assert.equal(corrected.reviewState, 'needs-review');
    assert.equal(corrected.corrections.length, 1);
    assert.equal(corrected.corrections[0]?.previousProvenance, 'user-entered');
    assert.equal(corrected.corrections[0]?.previous.snapshot.valueString, '3.2');
    assert.equal(corrected.corrections[0]?.next.snapshot.valueString, '3.8');
    assert.equal(corrected.corrections[0]?.previous.reviewState, 'confirmed');
    assert.equal(corrected.corrections[0]?.next.reviewState, 'needs-review');
    assert.equal(corrected.corrections[0]?.previous.biomarkerId, canonicalId('biomarker.ldl_c'));
    assert.equal(
      corrected.corrections[0]?.next.biomarkerId,
      canonicalId('biomarker.total_cholesterol'),
    );
    assert.equal(corrected.corrections[0]?.next.specimenType, 'serum');
    assert.deepEqual(corrected.corrections[0]?.next.source?.observationIds, ['corrected-source']);
    assert.equal(corrected.corrections[0]?.reason, 'Transcription correction');
    await repository.close();

    const reopenedRepository = createRepository(databasePath);
    const reopened = await reopenedRepository.repository.getRecord('lab-record-correction');
    assert.equal(reopened?.measurements[0]?.current.label, 'Total cholesterol');
    assert.equal(reopened?.measurements[0]?.current.valueString, '3.8');
    assert.equal(reopened?.measurements[0]?.current.unit, 'mg/dL');
    assert.equal(reopened?.measurements[0]?.specimenType, 'serum');
    assert.equal(reopened?.measurements[0]?.reviewState, 'needs-review');
    assert.equal(
      reopened?.measurements[0]?.originalState.biomarkerId,
      canonicalId('biomarker.ldl_c'),
    );
    assert.equal(reopened?.measurements[0]?.originalState.specimenType, 'unknown');
    assert.equal(reopened?.measurements[0]?.originalState.snapshot.valueString, '3.2');
    assert.deepEqual(reopened?.measurements[0]?.originalState.source?.observationIds, [
      'manual-source',
    ]);
    assert.equal(reopened?.measurements[0]?.corrections[0]?.next.snapshot.valueString, '3.8');
    await reopenedRepository.repository.close();
  });

  test('record deletion removes measurements and correction rows transactionally', async () => {
    const { repository, database } = createRepository();
    await repository.createRecord({
      id: 'lab-record-delete',
      collectionDate: { kind: 'missing' },
      measurements: [
        {
          id: 'measurement-delete',
          label: 'Result',
          value: { kind: 'numeric', value: 1 },
        },
      ],
    });
    await repository.correctMeasurement('measurement-delete', {
      value: { kind: 'numeric', value: 2 },
    });
    await repository.deleteRecord('lab-record-delete');
    assert.deepEqual(await repository.getRecord('lab-record-delete'), null);
    assert.equal((await database.getAllAsync('SELECT id FROM measurements')).length, 0);
    assert.equal((await database.getAllAsync('SELECT id FROM measurement_corrections')).length, 0);
    await repository.close();
  });

  test('Measurement deletion cascades only its correction chain', async () => {
    const { repository, database } = createRepository();
    await repository.createRecord({
      id: 'lab-record-measurement-delete',
      collectionDate: { kind: 'missing' },
      measurements: [
        {
          id: 'measurement-delete-one',
          label: 'Synthetic one',
          value: { kind: 'numeric', value: 1 },
        },
        { id: 'measurement-keep', label: 'Synthetic two', value: { kind: 'numeric', value: 2 } },
      ],
    });
    await repository.correctMeasurement('measurement-delete-one', {
      value: { kind: 'numeric', value: 3 },
    });
    await repository.deleteMeasurement('measurement-delete-one');
    assert.deepEqual(
      (await repository.getRecord('lab-record-measurement-delete'))?.measurements.map(
        (item) => item.id,
      ),
      ['measurement-keep'],
    );
    assert.equal(
      (
        await database.getAllAsync(
          'SELECT id FROM measurement_corrections WHERE measurement_id = ?',
          'measurement-delete-one',
        )
      ).length,
      0,
    );
    await repository.close();
  });

  test('combined deletion intent survives restart and revalidates the record-source link', async () => {
    const { repository, databasePath } = createRepository();
    await repository.createReport({
      id: 'report-combined',
      sourceType: 'pdf',
      originalFilename: 'synthetic.pdf',
      mimeType: 'application/pdf',
      importState: 'imported',
    });
    await repository.createRecord({
      id: 'record-combined',
      labReportId: 'report-combined',
      collectionDate: { kind: 'missing' },
      measurements: [],
    });
    await repository.requestCombinedDeletion('record-combined', 'report-combined');
    await repository.close();
    const reopened = createRepository(databasePath);
    assert.deepEqual(await reopened.repository.listPendingCombinedDeletions(), [
      { recordId: 'record-combined', reportId: 'report-combined', state: 'requested' },
    ]);
    await reopened.repository.updateRecord('record-combined', {
      labReportId: null,
      collectionDate: { kind: 'missing' },
      specimenType: 'unknown',
      laboratoryName: null,
      notes: null,
    });
    await assert.rejects(
      reopened.repository.markCombinedDeletionSourceComplete('record-combined', 'report-combined'),
      /association changed/,
    );
    await assert.rejects(
      reopened.database.runAsync(
        `INSERT INTO lab_combined_deletions (id, record_id, report_id, state, created_at, updated_at)
         VALUES (?, ?, ?, 'requested', ?, ?);`,
        'invalid-combined',
        'missing-record',
        'report-combined',
        '2026-08-22T10:00:00.000Z',
        '2026-08-22T10:00:00.000Z',
      ),
      /FOREIGN KEY/,
    );
    await reopened.repository.close();
  });

  test('deletion plans expose sibling impact and combined cleanup retries without losing records', async () => {
    const { repository } = createRepository();
    await repository.createReport({
      id: 'report-shared-records',
      sourceType: 'pdf',
      originalFilename: 'synthetic.pdf',
      mimeType: 'application/pdf',
      originalPath: 'protected://original-reports/synthetic.pdf',
      importState: 'imported',
    });
    for (const id of ['record-target', 'record-sibling']) {
      await repository.createRecord({
        id,
        labReportId: 'report-shared-records',
        collectionDate: { kind: 'missing' },
        measurements: [
          {
            id: `measurement-${id}`,
            label: 'Synthetic result',
            value: { kind: 'numeric', value: 1 },
          },
        ],
      });
    }
    let failSource = true;
    const service = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: async (reportId) => {
        await repository.requestReportDeletion(reportId);
        if (failSource) {
          await repository.failReportDeletion(reportId, 'source-cleanup-failed');
          throw new Error('synthetic cleanup failure');
        }
        await repository.completeReportDeletion(reportId);
      },
    });
    const plan = await service.planDeletion({
      kind: 'record-plus-source',
      recordId: 'record-target',
    });
    assert.deepEqual(plan.linkedRecordIdsAffectedBySourceDeletion, ['record-sibling']);
    await assert.rejects(
      service.executeDeletion({ kind: 'record-plus-source', recordId: 'record-target' }),
      /synthetic cleanup failure/,
    );
    assert.notEqual(await repository.getRecord('record-target'), null);
    assert.equal((await service.getRecordDetail('record-sibling'))?.source.kind, 'deletion-failed');
    failSource = false;
    const relaunched = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: async (reportId) =>
        repository.completeReportDeletion(reportId).then(() => undefined),
    });
    await relaunched.retryPendingDeletion('record-target');
    assert.equal(await repository.getRecord('record-target'), null);
    assert.notEqual(await repository.getRecord('record-sibling'), null);
    assert.equal((await service.getRecordDetail('record-sibling'))?.source.kind, 'deleted');
    assert.deepEqual(await repository.listPendingCombinedDeletions(), []);
    await repository.close();
  });

  test('LabsService record-only preserves the report, sibling record, and source artifacts', async () => {
    const { repository } = createRepository();
    await repository.createReport({
      id: 'report-record-only',
      sourceType: 'pdf',
      originalFilename: 'synthetic.pdf',
      mimeType: 'application/pdf',
      originalPath: 'protected://original-reports/record-only.pdf',
      importState: 'imported',
      pages: [{ pageIndex: 0, derivedPath: 'protected://working-pages/record-only.png' }],
    });
    for (const id of ['record-delete-only', 'record-keep-only'])
      await repository.createRecord({
        id,
        labReportId: 'report-record-only',
        collectionDate: { kind: 'missing' },
        measurements: [],
      });
    let sourceDeletionCalls = 0;
    const service = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: async () => {
        sourceDeletionCalls += 1;
      },
    });
    await service.deleteRecord('record-delete-only');
    assert.equal(sourceDeletionCalls, 0);
    assert.equal(await repository.getRecord('record-delete-only'), null);
    assert.notEqual(await repository.getRecord('record-keep-only'), null);
    const report = await repository.getReport('report-record-only');
    assert.equal(report?.originalPath, 'protected://original-reports/record-only.pdf');
    assert.equal(report?.pages[0]?.derivedPath, 'protected://working-pages/record-only.png');
    await repository.close();
  });

  test('LabsService rejects an execution when the displayed deletion plan became stale', async () => {
    const { repository } = createRepository();
    await repository.createRecord({
      id: 'record-stale-plan',
      collectionDate: { kind: 'missing' },
      measurements: [
        { id: 'measurement-before-plan', label: 'Synthetic', value: { kind: 'numeric', value: 1 } },
      ],
    });
    const service = createLabsService({ repositoryFactory: async () => repository });
    const displayed = await service.planDeletion({
      kind: 'record-only',
      recordId: 'record-stale-plan',
    });
    await repository.deleteMeasurement('measurement-before-plan');
    await assert.rejects(
      service.executeDeletion({ kind: 'record-only', recordId: 'record-stale-plan' }, displayed),
      /plan changed/,
    );
    assert.notEqual(await repository.getRecord('record-stale-plan'), null);
    await repository.close();
  });

  test('LabsService source-only keeps linked records readable as source-deleted after restart', async () => {
    const { repository, databasePath } = createRepository();
    await repository.createReport({
      id: 'report-source-only',
      sourceType: 'pdf',
      originalFilename: 'synthetic.pdf',
      mimeType: 'application/pdf',
      originalPath: 'protected://original-reports/source-only.pdf',
      importState: 'imported',
    });
    for (const id of ['record-source-one', 'record-source-two'])
      await repository.createRecord({
        id,
        labReportId: 'report-source-only',
        collectionDate: { kind: 'missing' },
        measurements: [{ label: `Synthetic ${id}`, value: { kind: 'numeric', value: 1 } }],
      });
    const service = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: async (reportId) =>
        repository.completeReportDeletion(reportId).then(() => undefined),
    });
    await service.executeDeletion({ kind: 'source-only', recordId: 'record-source-one' });
    await repository.close();
    const reopened = createRepository(databasePath);
    const relaunched = createLabsService({
      repositoryFactory: async () => reopened.repository,
      deleteSource: async () => undefined,
    });
    for (const id of ['record-source-one', 'record-source-two']) {
      assert.notEqual(await relaunched.getRecord(id), null);
      assert.equal((await relaunched.getRecordDetail(id))?.source.kind, 'deleted');
    }
    await reopened.repository.close();
  });

  test('LabsService retries source-only cleanup without asking UI to infer its operation', async () => {
    const { repository } = createRepository();
    await repository.createReport({
      id: 'report-retry-source',
      sourceType: 'pdf',
      originalFilename: 'synthetic.pdf',
      mimeType: 'application/pdf',
      originalPath: 'protected://original-reports/retry.pdf',
      importState: 'imported',
    });
    await repository.createRecord({
      id: 'record-retry-source',
      labReportId: 'report-retry-source',
      collectionDate: { kind: 'missing' },
      measurements: [],
    });
    let attempts = 0;
    const service = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: async (id) => {
        attempts += 1;
        if (attempts === 1) {
          await repository.requestReportDeletion(id);
          await repository.failReportDeletion(id, 'synthetic');
          throw new Error('synthetic');
        }
        await repository.completeReportDeletion(id);
      },
    });
    await assert.rejects(
      service.executeDeletion({ kind: 'source-only', recordId: 'record-retry-source' }),
    );
    await service.retryPendingDeletion('record-retry-source');
    assert.equal((await service.getRecordDetail('record-retry-source'))?.source.kind, 'deleted');
    await repository.close();
  });

  test('legacy correction snapshots remain readable after the provenance contract expands', async () => {
    const { repository, database } = createRepository();
    await repository.createRecord({
      id: 'lab-record-legacy-correction',
      collectionDate: { kind: 'missing' },
      measurements: [
        {
          id: 'measurement-legacy-correction',
          label: 'Result',
          value: { kind: 'numeric', value: 1 },
        },
      ],
    });
    const oldSnapshot = JSON.stringify({
      label: 'Result',
      value: { kind: 'numeric', value: 1 },
      valueString: '1',
      unit: null,
      referenceInterval: null,
      flag: null,
    });
    await database.runAsync(
      `INSERT INTO measurement_corrections (
        id, measurement_id, corrected_at, reason, previous_json, next_json, previous_provenance
      ) VALUES (?, ?, ?, ?, ?, ?, ?);`,
      'measurement-correction-legacy',
      'measurement-legacy-correction',
      '2026-08-22T10:00:00.000Z',
      'Legacy correction',
      oldSnapshot,
      oldSnapshot,
      'user-entered',
    );
    const record = await repository.getRecord('lab-record-legacy-correction');
    const correction = record?.measurements[0]?.corrections[0];
    assert.equal(correction?.previous.snapshot.valueString, '1');
    assert.equal(correction?.previous.specimenType, 'unknown');
    assert.equal(correction?.previous.reviewState, 'confirmed');
    assert.equal(correction?.previous.provenance, 'user-entered');
    assert.equal(correction?.next.provenance, 'user-corrected');
    await repository.close();
  });

  test('deleting a date-only Lab Record succeeds when it has no Measurements', async () => {
    const { repository } = createRepository();
    await repository.createRecord({
      id: 'lab-record-empty-delete',
      collectionDate: { kind: 'missing' },
      measurements: [],
    });
    await repository.deleteRecord('lab-record-empty-delete');
    assert.equal(await repository.getRecord('lab-record-empty-delete'), null);
    await repository.close();
  });

  test('protection failure blocks initialization before schema or health records are persisted', async () => {
    const { repository, database } = createRepository(undefined, {
      async protectDatabaseFiles() {
        throw new ProtectionError('test protection failure');
      },
    });
    await assert.rejects(repository.initialize(), /test protection failure/);
    assert.deepEqual(
      await database.getAllAsync<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lab_records'",
      ),
      [],
    );
    await repository.close();
  });

  test('post-write protection failure rolls back a newly requested create', async () => {
    let strictCalls = 0;
    let failPostWrite = false;
    const failingProtection: DatabaseProtection = {
      async protectDatabaseFiles(databasePath, options = {}) {
        if (options.requireSidecars === true) {
          strictCalls += 1;
          if (failPostWrite && strictCalls === 2) {
            throw new ProtectionError('post-write protection failure');
          }
        }
        return {
          protectedPaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
          missingSidecarPaths: [],
        };
      },
    };
    const { repository, database } = createRepository(undefined, failingProtection);
    await repository.initialize();
    strictCalls = 0;
    failPostWrite = true;
    await assert.rejects(
      repository.createRecord({
        id: 'lab-record-rollback-create',
        collectionDate: { kind: 'missing' },
        measurements: [{ label: 'Result', value: { kind: 'numeric', value: 1 } }],
      }),
      /post-write protection failure/,
    );
    assert.deepEqual(await repository.getRecord('lab-record-rollback-create'), null);
    assert.equal((await database.getAllAsync('SELECT id FROM measurements')).length, 0);
    await repository.close();
  });

  test('protection failure blocks update, correction, and delete without committing', async () => {
    let fail = false;
    const guardedProtection: DatabaseProtection = {
      async protectDatabaseFiles(databasePath, options = {}) {
        if (fail && options.requireSidecars === true) {
          throw new ProtectionError('mutation protection failure');
        }
        return {
          protectedPaths: [databasePath, `${databasePath}-wal`, `${databasePath}-shm`],
          missingSidecarPaths: [],
        };
      },
    };
    const { repository } = createRepository(undefined, guardedProtection);
    await repository.createRecord({
      id: 'lab-record-rollback-mutations',
      collectionDate: { kind: 'known', value: '2026-08-22' },
      specimenType: 'blood',
      laboratoryName: 'Original lab',
      measurements: [
        { id: 'measurement-rollback', label: 'Result', value: { kind: 'numeric', value: 1 } },
      ],
    });
    fail = true;
    await assert.rejects(
      repository.updateRecord('lab-record-rollback-mutations', {
        collectionDate: { kind: 'known', value: '2026-08-23' },
        specimenType: 'urine',
        laboratoryName: 'Changed lab',
        notes: 'changed',
      }),
      /mutation protection failure/,
    );
    await assert.rejects(
      repository.correctMeasurement('measurement-rollback', {
        value: { kind: 'numeric', value: 2 },
      }),
      /mutation protection failure/,
    );
    await assert.rejects(
      repository.deleteRecord('lab-record-rollback-mutations'),
      /mutation protection failure/,
    );
    const record = await repository.getRecord('lab-record-rollback-mutations');
    assert.equal(record?.laboratoryName, 'Original lab');
    assert.equal(record?.measurements[0]?.current.valueString, '1');
    await repository.close();
  });
});

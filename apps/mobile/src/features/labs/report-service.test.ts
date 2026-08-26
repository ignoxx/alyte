import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ExtractionDraftRow,
  ExtractionSemanticMapper,
  LabReportSourceIntegrity,
  LabRecord,
  Measurement,
  MeasurementSnapshot,
  VisionOCRResult,
} from '@alyte/domain';
import {
  buildExtractionConfirmationPlan,
  buildMeasuredTrend,
  canonicalId,
  convertComparableValue,
  decodeVisionOCRResult,
  EXTRACTION_PARSER_VERSION,
  groupObservationsIntoRows,
  parseLabDate,
  revalidateExtractionRow,
} from '@alyte/domain';
import { createLabRepository, type LabRepository, type SqliteDatabase } from './persistence';
import {
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import {
  createLabReportsService,
  createDefaultExtractionAliases,
  LabReportExtractionError,
  type LabReportsServiceOptions,
  type LabReportsService,
} from './report-service';
import type { LabReportImportError } from './report-service';
import type { PdfInspection, PdfInspectionSession, PdfInspector } from './pdf';
import type { PdfSanitizedVerification } from './pdf';
import type { ImageInspection, ImageSanitizedVerification, ImageSanitizationResult } from './image';
import type { VisionOCR } from './vision';
import type { DatabaseProtection } from './protection';
import { addRedaction } from '@alyte/domain';
import { createSanitizationRecipe } from '@alyte/domain';
import { comparableBiomarkers } from '@alyte/catalogue';
import {
  bloodLiverSafetyReportFixture,
  bloodLiverLabReportFixtures,
  metabolicLabReportFixtures,
  mixedSpecimenMetabolicLabReportFixture,
  multilingualLabTableFixtures,
} from '@alyte/fixtures';
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

  async runAsync(source: string, ...params: readonly unknown[]) {
    const result = this.database.prepare(source).run(...(params as any[]));
    return { changes: Number(result.changes), lastInsertRowId: Number(result.lastInsertRowid) };
  }

  async getAllAsync<T>(source: string, ...params: readonly unknown[]): Promise<readonly T[]> {
    return this.database.prepare(source).all(...(params as any[])) as T[];
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

const temporaryPaths: string[] = [];
const protection: DatabaseProtection = {
  async protectDatabaseFiles(databasePath, options = {}) {
    return {
      protectedPaths:
        options.requireSidecars === true
          ? [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
          : [databasePath],
      missingSidecarPaths: options.requireSidecars === true ? [] : [],
    };
  },
};

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function createRepository(databasePath?: string): LabRepository {
  const directory =
    databasePath === undefined ? mkdtempSync(join(tmpdir(), 'alyte-reports-')) : null;
  if (directory !== null) temporaryPaths.push(directory);
  const database = new NodeSqliteDatabase(
    databasePath ?? join(directory as string, 'alyte.sqlite'),
  );
  return createLabRepository(database, {
    protection,
    now: () => '2026-08-22T10:00:00.000Z',
    idGenerator: (prefix) => `${prefix}-test-${Math.random().toString(36).slice(2)}`,
  });
}

class FakeFiles implements ProtectedReportFileService {
  readonly removed: string[] = [];
  readonly files = new Map<string, { hash: string; size: number }>();
  readonly transient = new Set<string>();
  private next = 0;

  async initialize(): Promise<void> {}
  async cleanupTransientImports(): Promise<void> {
    for (const path of this.transient) {
      this.files.delete(path);
      this.removed.push(path);
    }
    this.transient.clear();
  }

  async stage(source: LabSourceSelection, _importId: string): Promise<ProtectedCopy> {
    const path = `protected://transient/${++this.next}-${source.name}`;
    const hash = `hash-${source.uri}`;
    this.files.set(path, { hash, size: source.byteSize ?? 10 });
    this.transient.add(path);
    return { path, sourceHash: hash, byteSize: source.byteSize ?? 10 };
  }

  async promote(
    staged: ProtectedCopy,
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy> {
    const path = `protected://originals/${reportId}-${source.name}`;
    const current = this.files.get(staged.path);
    if (current === undefined) throw new Error('staged file missing');
    this.files.set(path, current);
    return { path, sourceHash: current.hash, byteSize: current.size };
  }

  async recoverPromoted(
    _reportId: string,
    _source: LabSourceSelection,
  ): Promise<ProtectedCopy | null> {
    return null;
  }

  async hashFile(path: string): Promise<string> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error('file missing');
    return file.hash;
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async remove(path: string): Promise<void> {
    this.files.delete(path);
    this.transient.delete(path);
    this.removed.push(path);
  }

  async sanitizedDestination(reportId: string, derivativeId: string): Promise<string> {
    return `protected://sanitized/${reportId}-${derivativeId}.pdf`;
  }

  async sanitizedImageDestination(reportId: string, derivativeId: string): Promise<string> {
    return `protected://sanitized/${reportId}-${derivativeId}.jpg`;
  }

  async protectArtifact(path: string): Promise<ProtectedCopy> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error('sanitized artifact missing');
    return { path, sourceHash: file.hash, byteSize: file.size };
  }

  async listOwnedFiles(): Promise<readonly string[]> {
    return [...this.files.keys()].filter((path) => path.startsWith('protected://'));
  }

  async removeOwnedFile(path: string): Promise<void> {
    await this.remove(path);
  }
}

class FailingDeleteFiles extends FakeFiles {
  failRemoval = false;

  override async remove(path: string): Promise<void> {
    if (this.failRemoval) throw new Error('synthetic file cleanup failure');
    await super.remove(path);
  }
}

class RelocatingFiles extends FakeFiles {
  readonly legacyPath =
    'file:///Users/test/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents/alyte-protected/original-reports/relocated.pdf';
  readonly currentPath =
    'file:///Users/test/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/alyte-protected/original-reports/relocated.pdf';

  portablePath(path: string): string {
    if (path === this.legacyPath || path === this.currentPath) {
      return 'protected://original-reports/relocated.pdf';
    }
    if (path.startsWith('protected://')) return path;
    throw new Error('unowned path');
  }

  async resolvePath(path: string): Promise<string> {
    if (path === this.legacyPath || path === 'protected://original-reports/relocated.pdf') {
      return this.currentPath;
    }
    return path;
  }

  private current(path: string): string {
    return path === this.legacyPath || path === 'protected://original-reports/relocated.pdf'
      ? this.currentPath
      : path;
  }

  override async hashFile(path: string): Promise<string> {
    return super.hashFile(this.current(path));
  }

  override async exists(path: string): Promise<boolean> {
    return super.exists(this.current(path));
  }

  override async remove(path: string): Promise<void> {
    return super.remove(this.current(path));
  }
}

const pdfInspection: PdfInspection = {
  encrypted: false,
  locked: false,
  pageCount: 2,
  metadata: {},
  pages: [
    { pageIndex: 0, width: 612, height: 792, hasTextLayer: true },
    { pageIndex: 1, width: 612, height: 792, hasTextLayer: true },
  ],
};

class FakePdf implements PdfInspector {
  locked = false;
  passwordAttempts: string[] = [];
  inspectedPaths: string[] = [];
  previewCalls = 0;
  async inspect(path: string): Promise<PdfInspection> {
    this.inspectedPaths.push(path);
    return this.locked
      ? { ...pdfInspection, encrypted: true, locked: true, pageCount: 0, pages: [] }
      : pdfInspection;
  }
  async unlock(_path: string, password: string): Promise<PdfInspectionSession> {
    this.passwordAttempts.push(password);
    if (password !== 'correct horse') throw new Error('Wrong password');
    return {
      inspection: { ...pdfInspection, encrypted: true },
      renderPreview: async () => ['data:image/png;base64,synthetic-preview'],
      exportUnlocked: async () => {},
      close: async () => {},
    };
  }
  async renderPreview(_path: string): Promise<readonly string[]> {
    this.previewCalls += 1;
    return ['data:image/png;base64,synthetic-preview'];
  }
}

const verifiedSanitized: PdfSanitizedVerification = {
  verified: true,
  selectableText: false,
  annotations: false,
  attachments: false,
  metadata: false,
  removableRedactions: false,
  reloadChecked: true,
  sourceAwareChecked: true,
  sourceContentRemoved: true,
  verificationVersion: 'source-aware-v1',
  failureReasons: [],
};

class SanitizingPdf extends FakePdf {
  readonly sanitizedPaths: string[] = [];
  verification: PdfSanitizedVerification = verifiedSanitized;
  standaloneVerification: PdfSanitizedVerification = verifiedSanitized;
  files: FakeFiles | null = null;

  async sanitize(
    _sourcePath: string,
    destinationPath: string,
  ): Promise<{
    destinationPath: string;
    pageCount: number;
    verification: PdfSanitizedVerification;
  }> {
    this.sanitizedPaths.push(destinationPath);
    this.files?.files.set(destinationPath, {
      hash: `artifact-${this.sanitizedPaths.length}`,
      size: 128,
    });
    return { destinationPath, pageCount: 2, verification: this.verification };
  }

  async verifySanitized(_path: string): Promise<PdfSanitizedVerification> {
    return this.standaloneVerification;
  }
}

const verifiedImage: ImageSanitizedVerification = {
  verified: true,
  selectableText: false,
  annotations: false,
  attachments: false,
  metadata: false,
  removableRedactions: false,
  reloadChecked: true,
  sourceAwareChecked: true,
  sourceContentRemoved: true,
  verificationVersion: 'image-source-aware-v2',
  failureReasons: [],
  pixelWidth: 1200,
  pixelHeight: 900,
};

class SanitizingImage {
  readonly sanitizedPaths: string[] = [];
  files: FakeFiles;
  failSanitize = false;

  constructor(files: FakeFiles) {
    this.files = files;
  }

  async inspect(_path: string): Promise<ImageInspection> {
    return { width: 1200, height: 900, pixelWidth: 1200, pixelHeight: 900, hasMetadata: true };
  }

  async sanitize(_sourcePath: string, destinationPath: string): Promise<ImageSanitizationResult> {
    if (this.failSanitize) throw new Error('synthetic replacement failure');
    this.sanitizedPaths.push(destinationPath);
    this.files.files.set(destinationPath, {
      hash: `image-artifact-${this.sanitizedPaths.length}`,
      size: 256,
    });
    return { destinationPath, byteSize: 256, verification: verifiedImage };
  }

  async verifySanitized(
    _path: string,
    _sourcePath: string,
    _recipe: Parameters<NonNullable<LabReportsServiceOptions['imageInspector']>['sanitize']>[2],
  ): Promise<ImageSanitizedVerification> {
    return verifiedImage;
  }
}

function source(uri: string, sourceType: 'pdf' | 'image' = 'pdf'): LabSourceSelection {
  return {
    uri,
    name: sourceType === 'pdf' ? `${uri}.pdf` : `${uri}.jpg`,
    mimeType: sourceType === 'pdf' ? 'application/pdf' : 'image/jpeg',
    sourceType,
    byteSize: 42,
    width: sourceType === 'image' ? 1200 : null,
    height: sourceType === 'image' ? 900 : null,
  };
}

function createService(
  repository: LabRepository,
  files: FakeFiles,
  pdf: PdfInspector = new FakePdf(),
  visionOCR?: VisionOCR,
  semanticMapper?: ExtractionSemanticMapper,
  imageInspector?: LabReportsServiceOptions['imageInspector'],
): LabReportsService {
  return createLabReportsService({
    repositoryFactory: async () => repository,
    fileService: files,
    pdfInspector: pdf,
    ...(visionOCR === undefined ? {} : { visionOCR }),
    ...(semanticMapper === undefined ? {} : { semanticMapper }),
    ...(imageInspector === undefined ? {} : { imageInspector }),
    idGenerator: (() => {
      let count = 0;
      return (prefix: string) => `${prefix}-fixed-${++count}`;
    })(),
  });
}

async function prepareSanitizedExtraction(service: LabReportsService, reportId: string) {
  const editor = await service.openSanitizationEditor(reportId);
  await service.saveSanitizedReport(reportId, editor.recipe);
}

function sanitizingPdf(files: FakeFiles): SanitizingPdf {
  const pdf = new SanitizingPdf();
  pdf.files = files;
  return pdf;
}

function measurementFromExtractionRow(
  row: ExtractionDraftRow,
  recordId: string,
  specimenType: LabRecord['specimenType'],
): Measurement {
  const valueString =
    row.proposedValue.kind === 'numeric'
      ? String(row.proposedValue.value)
      : row.proposedValue.kind === 'bounded'
        ? `${row.proposedValue.comparator}${row.proposedValue.value}`
        : row.proposedValue.value;
  const snapshot: MeasurementSnapshot = {
    label: row.proposedLabel,
    value: row.proposedValue,
    valueString,
    unit: row.proposedUnit,
    referenceInterval: row.proposedReferenceInterval,
    flag: row.proposedFlag,
  };
  const biomarkerId =
    row.proposedBiomarkerId === null ? null : canonicalId(row.proposedBiomarkerId);
  const state = {
    biomarkerId,
    specimenType,
    snapshot,
    reviewState: row.reviewState === 'ready' ? ('confirmed' as const) : ('needs-review' as const),
    provenance: 'extracted' as const,
    source: row.source,
  };
  return {
    id: `${recordId}-${row.id}`,
    labRecordId: recordId,
    biomarkerId,
    specimenType,
    panelLabel: row.panelLabel,
    original: snapshot,
    originalState: state,
    current: snapshot,
    provenance: 'extracted',
    reviewState: state.reviewState,
    source: row.source,
    corrections: [],
  };
}

function recordFromMeasurements(
  id: string,
  specimenType: LabRecord['specimenType'],
  measurements: readonly Measurement[],
): LabRecord {
  return {
    id,
    labReportId: `report-${id}`,
    collectionDate: { kind: 'known', value: '2026-08-20' },
    specimenType,
    laboratoryName: 'Synthetic Laboratory',
    notes: null,
    createdAt: '2026-08-20T00:00:00.000Z',
    updatedAt: '2026-08-20T00:00:00.000Z',
    measurements,
  };
}

describe('protected Lab Report import lifecycle', () => {
  test('exercises the synthetic Lithuanian, English, and German extraction fixtures', () => {
    const aliases = createDefaultExtractionAliases();
    const counts = Object.fromEntries(
      Object.entries(multilingualLabTableFixtures).map(([locale, lines]) => {
        const observations = lines.map((text, index) => ({
          id: `${locale}-${index}`,
          text,
          alternatives: [],
          pageIndex: 0,
          orientation: 0,
          boundingBox: { x: 0.05, y: 0.05 + index * 0.12, width: 0.9, height: 0.04 },
          recognition: { level: 'accurate' as const, language: locale, internalConfidence: null },
        }));
        return [locale, groupObservationsIntoRows(observations, { aliases }).length];
      }),
    );
    assert.deepEqual(counts, { lt: 2, en: 1, de: 1 });
  });

  test('extracts metabolic report fixtures through the production catalogue aliases', () => {
    const aliases = createDefaultExtractionAliases();
    const fixtures = [...metabolicLabReportFixtures, mixedSpecimenMetabolicLabReportFixture];

    for (const fixture of fixtures) {
      const ocr = decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v2',
        pageIndex: 0,
        orientation: 0,
        observations: fixture.observations,
      });
      const collectionDate = parseLabDate(fixture.collectionDateText, fixture.locale) ?? {
        kind: 'missing' as const,
      };
      const contexts =
        fixture.expected.specimenContexts ??
        ([
          {
            tableId: 'synthetic-results',
            specimenType: fixture.specimenType,
            observationIds: fixture.observations.map((observation) => observation.id),
          },
        ] as const);
      const rows = contexts.flatMap((context) =>
        groupObservationsIntoRows(
          ocr.observations.filter((observation) => context.observationIds.includes(observation.id)),
          {
            aliases,
            locale: fixture.locale,
            collectionDate,
            specimenType: context.specimenType,
          },
        ),
      );
      const rowByObservation = new Map(rows.map((row) => [row.id, row]));
      const specimenByObservation = new Map(
        contexts.flatMap((context) =>
          context.observationIds.map(
            (observationId) => [observationId, context.specimenType] as const,
          ),
        ),
      );
      const draft = {
        id: fixture.id,
        reportId: `${fixture.id}-source`,
        state: 'draft' as const,
        ocrContractVersion: 'alyte.vision.document.v2' as const,
        parserVersion: EXTRACTION_PARSER_VERSION,
        collectionDate,
        rows,
        createdAt: '2026-08-20T00:00:00.000Z',
        updatedAt: '2026-08-20T00:00:00.000Z',
        confirmedAt: null,
      };
      const confirmationPlan = buildExtractionConfirmationPlan(draft, {
        record: (key) => `${fixture.id}-record-${key}`,
        measurement: (rowId) => `${fixture.id}-measurement-${rowId}`,
      });
      const plannedMeasurements = new Map(
        confirmationPlan.records
          .flatMap((record) => record.measurements)
          .map((measurement) => [measurement.sourceRowId, measurement]),
      );

      assert.deepEqual(
        fixture.expected.credible.map(({ observationId }) => rowByObservation.has(observationId)),
        fixture.expected.credible.map(() => true),
        fixture.id,
      );
      for (const expected of fixture.expected.credible) {
        const row = rowByObservation.get(expected.observationId);
        const expectedContext = contexts.find((context) =>
          context.observationIds.includes(expected.observationId),
        );
        assert.ok(expectedContext, `${fixture.id}: context ${expected.observationId}`);
        assert.equal(row?.proposedBiomarkerId, expected.biomarkerId, fixture.id);
        assert.equal(
          row?.reviewState,
          'ready',
          `${fixture.id}:${expected.observationId}:${row?.reviewReasons.join(',') ?? 'missing'}`,
        );
        assert.equal(
          row?.proposedSpecimenType,
          specimenByObservation.get(expected.observationId),
          fixture.id,
        );
        assert.equal(row?.collectionDate.kind, 'known', fixture.id);
        assert.deepEqual(
          row?.proposedValue,
          { kind: 'numeric', value: expected.value },
          fixture.id,
        );
        assert.equal(row?.sourceValueString, expected.valueString, fixture.id);
        assert.equal(row?.sourceUnit, expected.unit, fixture.id);
        assert.equal(row?.proposedUnit, expected.unit, fixture.id);
        assert.equal(row?.sourceReferenceInterval, expected.referenceInterval, fixture.id);
        assert.equal(row?.proposedReferenceInterval, expected.referenceInterval, fixture.id);
        assert.ok(
          row?.source.observations?.every(
            (observation) => observation.structure?.tableId === expectedContext.tableId,
          ),
          `${fixture.id}:${expected.observationId} table context`,
        );

        const entry = comparableBiomarkers.find(
          (candidate) => candidate.id === expected.biomarkerId,
        );
        assert.ok(entry, `${fixture.id}: catalogue entry ${expected.biomarkerId}`);
        const normalized = convertComparableValue(expected.value, expected.unit, entry);
        assert.equal(normalized?.unit, expected.canonicalUnit, fixture.id);
        assert.ok(
          normalized !== null &&
            Math.abs(normalized.value - expected.normalizedValue) < 0.000000001,
          `${fixture.id}:${expected.observationId} normalized value`,
        );

        const planned = plannedMeasurements.get(expected.observationId);
        assert.ok(planned, `${fixture.id}: confirmation plan ${expected.observationId}`);
        assert.deepEqual(planned?.value, { kind: 'numeric', value: expected.value }, fixture.id);
        assert.equal(planned?.valueString, String(expected.value), fixture.id);
        assert.equal(planned?.unit, expected.unit, fixture.id);
        assert.equal(planned?.referenceInterval, expected.referenceInterval, fixture.id);
      }

      for (const expected of fixture.expected.needsReview) {
        const row = rowByObservation.get(expected.observationId);
        const expectedContext = contexts.find((context) =>
          context.observationIds.includes(expected.observationId),
        );
        assert.ok(row, `${fixture.id}: expected review row ${expected.observationId}`);
        assert.ok(expectedContext, `${fixture.id}: context ${expected.observationId}`);
        assert.equal(row?.proposedBiomarkerId, expected.biomarkerId, fixture.id);
        assert.ok(row?.reviewReasons.includes(expected.reason), fixture.id);
        assert.equal(row?.reviewState, 'needs-review', fixture.id);
        assert.ok(
          row?.source.observations?.every(
            (observation) => observation.structure?.tableId === expectedContext.tableId,
          ),
          `${fixture.id}:${expected.observationId} table context`,
        );
        const planned = plannedMeasurements.get(expected.observationId);
        if (row?.decision === 'skip') {
          assert.equal(
            planned,
            undefined,
            `${fixture.id}: unsafe review row is excluded by default`,
          );
        } else {
          assert.ok(planned, `${fixture.id}: review confirmation plan ${expected.observationId}`);
          assert.equal(planned?.biomarkerId, expected.biomarkerId, fixture.id);
        }
      }

      for (const excludedId of fixture.expected.excludedObservationIds) {
        assert.equal(rowByObservation.has(excludedId), false, `${fixture.id}: ${excludedId}`);
      }

      if (fixture.id === 'metabolic-report-de-v1') {
        const unsafeRow = rowByObservation.get('de-vitamin-d3');
        assert.ok(unsafeRow);
        const attemptedUnsafeCorrection = revalidateExtractionRow(
          unsafeRow,
          {
            proposedBiomarkerId: canonicalId('biomarker.vitamin_d_total'),
            decision: 'resolve',
          },
          aliases,
        );
        assert.equal(attemptedUnsafeCorrection.proposedBiomarkerId, null);
        assert.ok(attemptedUnsafeCorrection.reviewReasons.includes('ambiguous-assay'));
        assert.equal(attemptedUnsafeCorrection.reviewState, 'needs-review');
        assert.equal(
          plannedMeasurements.get('de-vitamin-d3')?.biomarkerId,
          null,
          'unsafe vitamin-D form never becomes the canonical mapping',
        );
        const correctedDraft = {
          ...draft,
          rows: draft.rows.map((row) =>
            row.id === attemptedUnsafeCorrection.id ? attemptedUnsafeCorrection : row,
          ),
        };
        const correctedPlan = buildExtractionConfirmationPlan(correctedDraft, {
          record: (key) => `${fixture.id}-corrected-record-${key}`,
          measurement: (rowId) => `${fixture.id}-corrected-measurement-${rowId}`,
        });
        const correctedMeasurement = correctedPlan.records
          .flatMap((record) => record.measurements)
          .find((measurement) => measurement.sourceRowId === 'de-vitamin-d3');
        assert.equal(correctedMeasurement?.biomarkerId, null);
        assert.equal(correctedMeasurement?.reviewState, 'needs-review');
        const unsafeTrend = buildMeasuredTrend(
          [
            recordFromMeasurements('unsafe-vitamin-d', 'serum', [
              measurementFromExtractionRow(attemptedUnsafeCorrection, 'unsafe-vitamin-d', 'serum'),
            ]),
          ],
          canonicalId('biomarker.vitamin_d_total'),
          comparableBiomarkers,
        );
        assert.equal(unsafeTrend.points.length, 0);
        assert.equal(unsafeTrend.nonPoints[0]?.kind, 'not-measured');
      }

      if (fixture.id === 'metabolic-report-mixed-specimen-v1') {
        const unknownRow = rowByObservation.get('mixed-unknown-glucose');
        assert.ok(unknownRow);
        const unknownTrend = buildMeasuredTrend(
          [
            recordFromMeasurements('unknown-glucose', 'unknown', [
              measurementFromExtractionRow(unknownRow, 'unknown-glucose', 'unknown'),
            ]),
          ],
          canonicalId('biomarker.glucose'),
          comparableBiomarkers,
        );
        assert.equal(unknownTrend.points.length, 0);
        assert.equal(unknownTrend.nonPoints[0]?.kind, 'incompatible');
        assert.equal(unknownTrend.nonPoints[0]?.reason, 'incompatible-specimen');
      }
    }
  });

  test('resolves a mixed blood/serum/plasma/unknown report per table in production extraction', async () => {
    const fixture = bloodLiverSafetyReportFixture;
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: fixture.observations,
        });
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr);
    const report = (await service.importPdf(source('blood-liver-mixed-production')))!.report;
    await prepareSanitizedExtraction(service, report.id);

    const draft = await service.startExtraction(report.id);
    const rowByObservation = new Map(
      draft.rows.flatMap((row) => row.source.observationIds.map((id) => [id, row] as const)),
    );
    const expectedSpecimens = {
      'safety-unknown-mcv': 'unknown',
      'safety-urine-hemoglobin': 'urine',
      'safety-blood-mcv': 'blood',
      'safety-incompatible-unit': 'blood',
      'safety-ambiguous-sibling': 'serum',
      'safety-incomplete-alt-method': 'serum',
      'safety-incompatible-ast-unit': 'serum',
      'safety-unsafe-ggt-method': 'serum',
      'safety-plasma-ggt': 'plasma',
    } as const;
    assert.equal(draft.collectionDate.kind, 'known');
    assert.equal(draft.collectionDate.value, fixture.expectedCollectionDate);
    assert.equal(draft.rows.length, Object.keys(expectedSpecimens).length);
    assert.deepEqual(
      draft.rows.map((row) => row.source.observationIds[0]),
      [
        'safety-unknown-mcv',
        'safety-urine-hemoglobin',
        'safety-blood-mcv',
        'safety-incompatible-unit',
        'safety-ambiguous-sibling',
        'safety-plasma-ggt',
        'safety-incomplete-alt-method',
        'safety-incompatible-ast-unit',
        'safety-unsafe-ggt-method',
      ],
    );
    assert.deepEqual(
      draft.rows.map((row) => row.order),
      draft.rows.map((_row, order) => order),
    );
    for (const [observationId, specimenType] of Object.entries(expectedSpecimens)) {
      const row = rowByObservation.get(observationId);
      assert.ok(row, observationId);
      assert.equal(row?.proposedSpecimenType, specimenType, observationId);
      assert.deepEqual(row?.source.observationIds, [observationId], observationId);
    }
    for (const expected of fixture.expected.credible) {
      const row = rowByObservation.get(expected.observationId);
      assert.equal(row?.reviewState, 'ready', expected.observationId);
      assert.equal(row?.sourceReferenceInterval, expected.referenceInterval);
    }
    for (const expected of fixture.expected.needsReview) {
      const row = rowByObservation.get(expected.observationId);
      assert.ok(row, expected.observationId);
      assert.equal(row?.proposedBiomarkerId, expected.biomarkerId, expected.observationId);
      assert.equal(row?.proposedSpecimenType, expected.specimenType, expected.observationId);
      assert.equal(row?.reviewState, 'needs-review', expected.observationId);
      assert.ok(row?.reviewReasons.includes(expected.reason), expected.observationId);
    }
    for (const excludedObservationId of fixture.expected.excludedObservationIds) {
      assert.equal(rowByObservation.has(excludedObservationId), false, excludedObservationId);
    }

    // Unsafe rows remain visible for review but are excluded before the person takes any action.
    for (const observationId of [
      'safety-incompatible-unit',
      'safety-ambiguous-sibling',
      'safety-incompatible-ast-unit',
    ]) {
      assert.equal(rowByObservation.get(observationId)?.decision, 'skip', observationId);
    }

    const records = await service.confirmExtraction(draft.id);
    const mcvTrend = buildMeasuredTrend(
      records,
      canonicalId('biomarker.mcv'),
      comparableBiomarkers,
    );
    assert.equal(mcvTrend.points.length, 1);
    assert.deepEqual(
      records
        .flatMap((record) => record.measurements)
        .find((measurement) => measurement.source?.observationIds?.includes('safety-blood-mcv'))
        ?.source?.observationIds,
      ['safety-blood-mcv'],
    );
    assert.equal(mcvTrend.points[0]?.laboratoryReference.interval, '80-100');
    assert.equal(
      mcvTrend.nonPoints.some((point) => point.reason === 'incompatible-specimen'),
      true,
    );
    const hemoglobinTrend = buildMeasuredTrend(
      records,
      canonicalId('biomarker.hemoglobin'),
      comparableBiomarkers,
    );
    assert.equal(hemoglobinTrend.points.length, 0);
    assert.equal(
      hemoglobinTrend.nonPoints.some((point) => point.reason === 'unconfirmed'),
      true,
    );
    const ggtTrend = buildMeasuredTrend(
      records,
      canonicalId('biomarker.ggt'),
      comparableBiomarkers,
    );
    assert.equal(ggtTrend.points.length, 1);
    assert.deepEqual(
      records
        .flatMap((record) => record.measurements)
        .find((measurement) => measurement.source?.observationIds?.includes('safety-plasma-ggt'))
        ?.source?.observationIds,
      ['safety-plasma-ggt'],
    );
    assert.equal(ggtTrend.points[0]?.laboratoryReference.interval, '9-48');
  });

  test('runs multilingual blood-liver fixtures through production extraction and preserves source intervals', async () => {
    for (const fixture of bloodLiverLabReportFixtures) {
      const repository = createRepository();
      const files = new FakeFiles();
      const ocr: VisionOCR = {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v2',
            pageIndex: 0,
            orientation: 0,
            observations: fixture.observations,
          });
        },
      };
      const service = createService(repository, files, sanitizingPdf(files), ocr);
      const report = (await service.importPdf(source(`${fixture.id}-production`)))!.report;
      await prepareSanitizedExtraction(service, report.id);
      const draft = await service.startExtraction(report.id);
      const rowByObservation = new Map(
        draft.rows.flatMap((row) => row.source.observationIds.map((id) => [id, row] as const)),
      );

      assert.deepEqual(draft.collectionDate, {
        kind: 'known',
        value: fixture.expectedCollectionDate,
      });
      for (const expected of fixture.expected.credible) {
        const row = rowByObservation.get(expected.observationId);
        assert.ok(row, `${fixture.id}:${expected.observationId}`);
        assert.equal(
          row?.proposedBiomarkerId,
          expected.biomarkerId,
          `${fixture.id}:${expected.observationId}`,
        );
        assert.equal(
          row?.proposedSpecimenType,
          expected.specimenType,
          `${fixture.id}:${expected.observationId}`,
        );
        assert.equal(row?.reviewState, 'ready', `${fixture.id}:${expected.observationId}`);
        assert.deepEqual(row?.proposedValue, { kind: 'numeric', value: expected.value });
        assert.equal(row?.sourceValueString, expected.valueString);
        assert.equal(row?.sourceUnit, expected.unit);
        assert.equal(row?.sourceReferenceInterval, expected.referenceInterval);
        assert.equal(row?.proposedReferenceInterval, expected.referenceInterval);
        assert.equal(row?.sourceFlag, expected.flag ?? null);
        assert.equal(row?.proposedFlag, expected.flag ?? null);
        assert.deepEqual(row?.source.observationIds, [expected.observationId]);
        if (expected.sourceContext !== undefined) {
          assert.ok(
            fixture.observations.some((observation) =>
              observation.text.includes(expected.sourceContext!),
            ),
            `${fixture.id}:${expected.observationId} source context`,
          );
        }
        if (
          expected.biomarkerId === 'biomarker.alt' ||
          expected.biomarkerId === 'biomarker.ast' ||
          expected.biomarkerId === 'biomarker.ggt'
        ) {
          assert.match(row?.sourceText ?? '', /IFCC 37 C with P5P/u);
        }
      }
      for (const excludedId of fixture.expected.excludedObservationIds) {
        assert.equal(rowByObservation.has(excludedId), false, `${fixture.id}:${excludedId}`);
      }

      const records = await service.confirmExtraction(draft.id);
      assert.equal(
        records.every((record) => record.labReportId === report.id),
        true,
      );
      assert.equal(
        records.every(
          (record) =>
            record.collectionDate.kind === 'known' &&
            record.collectionDate.value === fixture.expectedCollectionDate,
        ),
        true,
      );
      for (const expected of fixture.expected.credible) {
        const measurement = records
          .flatMap((record) => record.measurements)
          .find((candidate) => candidate.source?.observationIds?.includes(expected.observationId));
        assert.ok(measurement, `${fixture.id}:${expected.observationId} persisted`);
        assert.deepEqual(measurement?.original.value, { kind: 'numeric', value: expected.value });
        assert.equal(measurement?.original.valueString, expected.valueString);
        assert.equal(measurement?.original.unit, expected.unit);
        assert.equal(measurement?.original.referenceInterval, expected.referenceInterval);
        assert.equal(measurement?.original.flag, expected.flag ?? null);
        assert.deepEqual(measurement?.source?.observationIds, [expected.observationId]);

        const trend = buildMeasuredTrend(
          records,
          canonicalId(expected.biomarkerId),
          comparableBiomarkers,
        );
        const point = trend.points.find((candidate) => candidate.measurementId === measurement?.id);
        assert.ok(point, `${fixture.id}:${expected.observationId} trend point`);
        assert.equal(point?.normalized.value, expected.normalizedValue);
        assert.deepEqual(point?.current.value, { kind: 'numeric', value: expected.value });
        assert.equal(point?.laboratoryReference.interval, expected.referenceInterval);
        assert.equal(point?.laboratoryReference.flag, expected.flag ?? null);
      }
    }
  });

  test('local extraction creates an editable draft from untrusted OCR with source provenance', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'ocr-row',
              text: 'LDL-C 3,8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
          ],
        };
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr);
    const report = (await service.importPdf(source('extraction-pdf')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(await service.countOpenExtractionDrafts(), 1);
    assert.equal(draft.rows.length, 1);
    assert.equal(draft.rows[0]?.source.pageIndex, 0);
    assert.equal(draft.rows[0]?.sourceValueString, '3,8');
    assert.equal(draft.rows[0]?.reviewState, 'needs-review');
    assert.ok(draft.rows[0]?.reviewReasons.includes('missing-collection-date'));
    const corrected = await service.updateExtractionRow(draft.rows[0]!.id, {
      proposedLabel: 'LDL-C',
      collectionDate: { kind: 'known', value: '2026-08-22' },
    });
    assert.equal(corrected.proposedBiomarkerId, 'biomarker.ldl_c');
    await service.updateExtractionRow(corrected.id, { decision: 'resolve' });
    const records = await service.confirmExtraction(draft.id);
    assert.equal(records.length, 1);
    assert.equal(await service.countOpenExtractionDrafts(), 0);
    assert.equal(records[0]?.measurements[0]?.original.valueString, '3,8');
  });

  test('does not confirm a numeric candidate from a malformed multi-row OCR observation', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
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
        };
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr);
    const report = (await service.importPdf(source('malformed-multi-row')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows.length, 1);
    assert.equal(draft.rows[0]?.proposedBiomarkerId, 'biomarker.triglycerides');
    assert.deepEqual(draft.rows[0]?.proposedValue, { kind: 'numeric', value: 9.839 });
    assert.equal(draft.rows[0]?.proposedUnit, null);
    assert.ok(draft.rows[0]?.reviewReasons.includes('missing-unit'));
    assert.equal(draft.rows[0]?.decision, 'skip');
    await assert.rejects(
      service.confirmExtraction(draft.id),
      /At least one extraction row must be included/,
    );
    const corrected = await service.updateExtractionRow(draft.rows[0]!.id, {
      proposedUnit: 'mmol/L',
    });
    assert.equal(corrected.decision, 'skip');
    assert.equal(corrected.reviewReasons.includes('missing-unit'), false);
    await service.updateExtractionRow(corrected.id, { decision: 'preserve' });
    const records = await service.confirmExtraction(draft.id);
    assert.equal(records.length, 1);
  });

  test('does not confirm an extracted value with a biomarker-incompatible unit', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, sanitizingPdf(files), {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'incompatible-unit-row',
              text: 'LDL-C 3.8 g/L',
              alternatives: [],
              boundingBox: { x: 0.12, y: 0.42, width: 0.69, height: 0.03 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        };
      },
    });
    const report = (await service.importPdf(source('incompatible-unit')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.ok(draft.rows[0]?.reviewReasons.includes('incompatible-unit'));
    assert.equal(draft.rows[0]?.decision, 'skip');
    await assert.rejects(
      service.confirmExtraction(draft.id),
      /At least one extraction row must be included/,
    );
  });

  test('classifies a readable report with no plausible Measurements separately from source failure', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, sanitizingPdf(files), {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'prose-only',
              text: 'Synthetic laboratory contact details',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        };
      },
    });
    const report = (await service.importPdf(source('no-measurements')))!.report;
    await prepareSanitizedExtraction(service, report.id);

    await assert.rejects(service.startExtraction(report.id), (error: unknown) => {
      assert.ok(error instanceof LabReportExtractionError);
      assert.equal(error.reason, 'no-reviewable-measurements');
      return true;
    });
  });

  test('refuses extraction before a current Sanitized Report is verified', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let recognitionCalls = 0;
    const service = createService(repository, files, new FakePdf(), {
      async recognize() {
        recognitionCalls += 1;
        throw new Error('Vision must not receive an Original Report');
      },
    });
    const report = (await service.importImages([source('unsanitized', 'image')]))[0]!.report;
    await assert.rejects(service.startExtraction(report.id), (error: unknown) => {
      assert.ok(error instanceof LabReportExtractionError);
      assert.equal(error.reason, 'sanitized-source');
      return true;
    });
    assert.equal(recognitionCalls, 0);
  });

  test('uses an optional supported semantic mapper and persists its versioned source selection', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize() {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'semantic-source',
              text: 'Sintetinis žymuo 3,8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate' as const, language: 'en', internalConfidence: 0.8 },
            },
            {
              id: 'incompatible-source',
              text: 'Kitas žymuo 2,1 µg/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.4, width: 0.6, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate' as const, language: 'en', internalConfidence: 0.8 },
            },
          ],
        };
      },
    };
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'synthetic.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: (locale) => locale === 'en',
      async map() {
        return [
          { sourceObservationIds: ['semantic-source'], proposedBiomarkerId: 'biomarker.ldl_c' },
          {
            sourceObservationIds: ['incompatible-source'],
            proposedBiomarkerId: 'biomarker.ldl_c',
          },
        ];
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr, mapper);
    const report = (await service.importPdf(source('semantic')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows[0]?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(draft.rows[0]?.source.semantic, {
      adapterVersion: 'synthetic.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      sourceObservationIds: ['semantic-source'],
    });
    assert.equal(draft.rows[0]?.source.observations?.[0]?.text, 'Sintetinis žymuo 3,8 mmol/L');
    assert.equal(draft.rows[1]?.proposedBiomarkerId, null);
    assert.equal(draft.rows[1]?.source.semantic, null);
  });

  test('bounds mapper input by candidate rows and preserves every deterministic row on partial failure', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = Array.from({ length: 13 }, (_, index) => ({
      id: `bounded-${index}`,
      text: `Synthetic marker ${index + 1}.2 mg/dL`,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x: 0.1, y: 0.08 + index * 0.06, width: 0.7, height: 0.03 },
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    }));
    const ocr: VisionOCR = {
      async recognize() {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations,
        };
      },
    };
    const chunkSizes: number[] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'bounded.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      maxRowsPerChunk: 12,
      supports: () => true,
      async map({ rows: chunk }) {
        chunkSizes.push(chunk.length);
        if (chunkSizes.length === 1) {
          // The valid-looking candidate must not partially apply when the same envelope also
          // contains an invented source ID.
          return {
            schemaVersion: 'alyte.semantic-mapper.v1',
            proposals: [
              {
                sourceObservationIds: ['bounded-0'],
                proposedBiomarkerId: 'biomarker.ldl_c',
                role: 'measurement',
              },
              {
                sourceObservationIds: ['invented-source'],
                proposedBiomarkerId: 'biomarker.ldl_c',
                role: 'measurement',
              },
            ],
          };
        }
        throw new Error('synthetic timeout after first bounded chunk');
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr, mapper);
    const report = (await service.importPdf(source('bounded-mapping')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);

    assert.deepEqual(chunkSizes, [12, 1]);
    assert.equal(draft.rows.length, 13);
    assert.equal(
      draft.rows.every((row) => row.source.semantic === null),
      true,
    );
    assert.deepEqual(
      draft.rows.map((row) => row.sourceText),
      observations.map((observation) => observation.text),
    );
  });

  test('passes nearby section headings as context without turning them into measurements', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      {
        id: 'serum-heading',
        text: 'Serum',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.1, y: 0.1, width: 0.2, height: 0.03 },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
      {
        id: 'serum-row',
        text: 'LDL-C 3.8 mmol/L',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.1, y: 0.18, width: 0.6, height: 0.03 },
        structure: {
          kind: 'table-cell' as const,
          tableId: 'serum-table',
          rowIndex: 1,
          columnIndex: 0,
        },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
      {
        id: 'urine-heading',
        text: 'Urine',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.1, y: 0.58, width: 0.2, height: 0.03 },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
      {
        id: 'urine-row',
        text: 'LDL-C 3.8 mmol/L',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.1, y: 0.66, width: 0.6, height: 0.03 },
        structure: {
          kind: 'table-cell' as const,
          tableId: 'urine-table',
          rowIndex: 1,
          columnIndex: 0,
        },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
    ];
    const headingChunks: string[][] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'heading-context.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map(input) {
        headingChunks.push((input.headings ?? []).map((heading) => heading.id));
        return [];
      },
    };
    const service = createService(
      repository,
      files,
      sanitizingPdf(files),
      {
        async recognize() {
          return {
            contractVersion: 'alyte.vision.document.v2',
            pageIndex: 0,
            orientation: 0,
            observations,
          };
        },
      },
      mapper,
    );
    const report = (await service.importPdf(source('heading-context')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows.length, 2);
    assert.deepEqual(headingChunks, [['serum-heading'], ['urine-heading']]);
    assert.deepEqual(
      draft.rows.map((row) => row.source.observationIds),
      [['serum-row'], ['urine-row']],
    );
    assert.deepEqual(
      draft.rows.map((row) => row.proposedSpecimenType),
      ['unknown', 'unknown'],
    );
  });

  test('gates missing packs before Vision while preserving a distinct runtime fallback path', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let recognitionCalls = 0;
    const ocr: VisionOCR = {
      async recognize() {
        recognitionCalls += 1;
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'pack-missing-source',
              text: 'LDL-C 3,8 mmol/L',
              alternatives: [],
              pageIndex: 0,
              orientation: 0,
              boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
              recognition: { level: 'accurate' as const, language: 'de', internalConfidence: null },
            },
          ],
        };
      },
    };
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'missing-pack.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => {
        throw new Error('unavailable mapper must not receive a chunk');
      },
      prepare: async () => {
        throw new Error('synthetic deleted pack');
      },
      async map() {
        throw new Error('unavailable mapper must not run');
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr, mapper);
    const report = (await service.importPdf(source('missing-pack')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    await assert.rejects(
      service.startExtraction(report.id),
      (error: unknown) =>
        error instanceof LabReportExtractionError && error.reason === 'model-unavailable',
    );
    assert.equal(recognitionCalls, 0);
  });

  test('keeps deterministic extraction when the semantic mapper does not support the language', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize() {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'fallback-source',
              text: 'LDL-C 3,8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
            },
          ],
        };
      },
    };
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'unsupported.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => false,
      async map() {
        throw new Error('unsupported mapper must not run');
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr, mapper);
    const report = (await service.importPdf(source('fallback')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows[0]?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(draft.rows[0]?.source.semantic, null);
  });

  test('uses contextual collection dates, keeps ambiguity reviewable, and groups events', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'collection-one',
              text: 'Collection date 22.08.2026',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.1, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
            {
              id: 'measurement-one',
              text: 'LDL-C 3,8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
            {
              id: 'collection-ambiguous',
              text: 'Collection date 01/02/2026',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.4, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: null, internalConfidence: null },
            },
            {
              id: 'measurement-ambiguous',
              text: 'LDL-C 4,0 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.5, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: null, internalConfidence: null },
            },
            {
              id: 'collection-two',
              text: 'Collection date 23.08.2026',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.7, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
            {
              id: 'measurement-two',
              text: 'LDL-C 3,9 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.8, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
          ],
        };
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr);
    const report = (await service.importPdf(source('contextual-date')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows.length, 3);
    assert.deepEqual(
      draft.rows.map((row) => row.collectionDate),
      [
        { kind: 'known', value: '2026-08-22' },
        { kind: 'missing' },
        { kind: 'known', value: '2026-08-23' },
      ],
    );
    assert.deepEqual(
      draft.rows.map((row) => row.source.observationIds),
      [['measurement-one'], ['measurement-ambiguous'], ['measurement-two']],
    );
    assert.ok(draft.rows[1]?.reviewReasons.includes('ambiguous-date'));
  });

  test('infers unambiguous collection date order when device and report locales differ', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'eu-date-on-us-device',
              text: 'Collection date 20.08.2026 08:15',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.1, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: null, internalConfidence: null },
            },
            {
              id: 'eu-date-value',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: null, internalConfidence: null },
            },
            {
              id: 'us-date-on-eu-report',
              text: 'Collection date 08/22/2026',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.5, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
            {
              id: 'us-date-value',
              text: 'LDL-C 4.0 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.6, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'de', internalConfidence: null },
            },
          ],
        };
      },
    };
    const service = createService(repository, files, sanitizingPdf(files), ocr);
    const report = (await service.importPdf(source('locale-date-boundary')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.deepEqual(
      draft.rows.map((row) => row.collectionDate),
      [
        { kind: 'known', value: '2026-08-20' },
        { kind: 'known', value: '2026-08-22' },
      ],
    );
  });

  test('copies an image into protected storage, records page metadata, and survives relaunch', async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), 'alyte-reports-relaunch-')),
      'alyte.sqlite',
    );
    temporaryPaths.push(databasePath.replace(/\/alyte\.sqlite$/, ''));
    const repository = createRepository(databasePath);
    const files = new FakeFiles();
    const first = createService(repository, files);
    const result = await first.importImages([source('image-1', 'image')]);
    assert.equal(result.length, 1);
    const report = result[0]?.report;
    assert.equal(report?.importState, 'imported');
    assert.equal(report?.pages[0]?.width, 1200);
    assert.equal(report?.originalPath?.startsWith('protected://originals/'), true);
    assert.equal(await first.verifySource(report?.id ?? ''), 'verified');
    await repository.close();

    const reopened = createService(createRepository(databasePath), files);
    const reports = await reopened.listReports();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.originalFilename, 'image-1.jpg');
    assert.equal(reports[0]?.sourceHash, report?.sourceHash);
  });

  test('keeps one immutable source for duplicate hashes and cleans the transient copy', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files);
    const first = await service.importPdf(source('same'));
    const second = await service.importPdf(source('same'));
    assert.equal(first?.duplicate, false);
    assert.equal(second?.duplicate, true);
    assert.equal(
      (await service.listReports()).filter((report) => report.importState !== 'deleted').length,
      1,
    );
    assert.equal(files.removed.filter((path) => path.includes('transient')).length, 2);
  });

  test('does not treat a failed pathless import as a usable duplicate', async () => {
    const repository = createRepository();
    await repository.createReport({
      id: 'lab-report-pathless-failed',
      sourceType: 'pdf',
      originalFilename: 'failed.pdf',
      mimeType: 'application/pdf',
      sourceHash: 'hash-file:///same-source',
      importState: 'failed',
      failureReason: 'promotion-interrupted',
    });
    const files = new FakeFiles();
    const service = createService(repository, files);
    const imported = (await service.importPdf(source('same-source')))!.report;

    assert.equal(imported.importState, 'imported');
    assert.equal(imported.originalPath !== null, true);
    assert.equal((await service.listReports()).length, 2);
  });

  test('previews retained image sources and PDF pages locally from report detail', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new FakePdf();
    const service = createService(repository, files, pdf);
    const image = (await service.importImages([source('preview-image', 'image')]))[0]!.report;
    const importedPdf = (await service.importPdf(source('preview-pdf')))!.report;

    const imagePreview = await service.previewOriginal(image.id);
    assert.deepEqual(imagePreview, { sourceType: 'image', uris: [image.originalPath] });
    const pdfPreview = await service.previewOriginal(importedPdf.id);
    assert.deepEqual(pdfPreview, {
      sourceType: 'pdf',
      uris: ['data:image/png;base64,synthetic-preview'],
    });
    assert.equal(pdf.previewCalls, 1);
  });

  test('rebases a legacy absolute report path before preview, hash verification, and deletion', async () => {
    const repository = createRepository();
    const files = new RelocatingFiles();
    files.files.set(files.currentPath, { hash: 'relocated-hash', size: 42 });
    const pdf = new FakePdf();
    const report = await repository.createReport({
      id: 'lab-report-relocated',
      sourceType: 'pdf',
      originalFilename: 'relocated.pdf',
      mimeType: 'application/pdf',
      byteSize: 42,
      sourceHash: 'relocated-hash',
      originalPath: files.legacyPath,
      importState: 'imported',
      pageCount: 1,
      importedAt: '2026-08-22T10:00:00.000Z',
    });
    const service = createService(repository, files, pdf);

    const reopened = await service.getReport(report.id);
    assert.equal(reopened?.originalPath, 'protected://original-reports/relocated.pdf');
    assert.equal(await service.verifySource(report.id), 'verified');
    assert.deepEqual(await service.previewOriginal(report.id), {
      sourceType: 'pdf',
      uris: ['data:image/png;base64,synthetic-preview'],
    });
    await service.deleteReport(report.id);
    assert.equal(files.files.has(files.currentPath), false);
    assert.equal((await repository.getReport(report.id))?.importState, 'deleted');
  });

  test('resolves a portable relocated report path before PDF inspection and Vision extraction', async () => {
    const repository = createRepository();
    const files = new RelocatingFiles();
    files.files.set(files.currentPath, { hash: 'relocated-hash', size: 42 });
    const pdf = sanitizingPdf(files);
    const nativePaths: string[] = [];
    const ocr: VisionOCR = {
      async recognize(path): Promise<VisionOCRResult> {
        nativePaths.push(path);
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'relocated-row',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.4, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        };
      },
    };
    const report = await repository.createReport({
      id: 'lab-report-relocated-extraction',
      sourceType: 'pdf',
      originalFilename: 'relocated-extraction.pdf',
      mimeType: 'application/pdf',
      byteSize: 42,
      sourceHash: 'relocated-hash',
      originalPath: files.legacyPath,
      importState: 'imported',
      pageCount: 1,
      importedAt: '2026-08-22T10:00:00.000Z',
    });
    const service = createService(repository, files, pdf, ocr);
    await prepareSanitizedExtraction(service, report.id);

    const draft = await service.startExtraction(report.id);

    assert.equal(
      (await service.getReport(report.id))?.originalPath,
      'protected://original-reports/relocated.pdf',
    );
    assert.deepEqual(pdf.inspectedPaths, [files.currentPath]);
    assert.deepEqual(nativePaths, pdf.sanitizedPaths);
    assert.equal(draft.rows[0]?.sourceValueString, '3.8');
    assert.equal(
      await repository.getExtractionDraftForReport(report.id).then((value) => value !== null),
      true,
    );
  });

  test('password preview uses an ephemeral unlock session and reports unavailable sources honestly', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new FakePdf();
    pdf.locked = true;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(
      source('preview-locked'),
      async () => 'correct horse',
    ))!.report;
    const preview = await service.previewOriginal(imported.id, async () => 'correct horse');
    assert.equal(preview.sourceType, 'pdf');
    assert.equal(pdf.passwordAttempts.includes('correct horse'), true);

    files.files.delete(imported.originalPath!);
    await assert.rejects(service.previewOriginal(imported.id), /integrity/);
  });

  test('wrong password is recoverable without persisting the password', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new FakePdf();
    pdf.locked = true;
    const service = createService(repository, files, pdf);
    let failed: LabReportImportError | null = null;
    try {
      await service.importPdf(source('encrypted'), async () => 'wrong');
    } catch (error) {
      failed = error as LabReportImportError;
    }
    assert.ok(failed);
    assert.equal(failed.reason, 'wrong-password');
    assert.equal(failed.report.importState, 'failed');
    assert.equal(failed.report.originalPath !== null, true);
    assert.equal(pdf.passwordAttempts[0], 'wrong');
    assert.equal(JSON.stringify(failed.report).includes('"wrong"'), false);
    const retried = await service.retryImport(failed.report.id, async () => 'correct horse');
    assert.equal(retried.importState, 'imported');
    assert.deepEqual(pdf.passwordAttempts, ['wrong', 'correct horse']);
  });

  test('malformed/cancelled imports leave no transient file while retaining a failed source state', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const malformedPdf: PdfInspector = {
      async inspect() {
        throw new Error('malformed PDF');
      },
      async unlock() {
        throw new Error('unreachable');
      },
      async renderPreview() {
        throw new Error('unreachable');
      },
    };
    const service = createService(repository, files, malformedPdf);
    await assert.rejects(service.importPdf(source('malformed')), (error: unknown) => {
      assert.equal((error as LabReportImportError).reason, 'malformed');
      assert.equal((error as LabReportImportError).report.importState, 'failed');
      return true;
    });
    assert.equal(files.transient.size, 0);

    const cancelledPdf = new FakePdf();
    cancelledPdf.locked = true;
    const cancelled = createService(createRepository(), new FakeFiles(), cancelledPdf);
    await assert.rejects(
      cancelled.importPdf(source('cancelled'), async () => null),
      (error: unknown) => {
        assert.equal((error as LabReportImportError).reason, 'cancelled');
        assert.equal((error as LabReportImportError).report.importState, 'interrupted');
        return true;
      },
    );
  });

  test('source deletion is independent and reference-safe', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files);
    const imported = (await service.importPdf(source('shared')))!.report;
    const second = await repository.createReport({
      id: 'lab-report-shared-reference',
      sourceType: 'pdf',
      originalFilename: 'shared-copy.pdf',
      mimeType: 'application/pdf',
      sourceHash: 'other-hash',
      originalPath: imported.originalPath,
      importState: 'imported',
      pageCount: 1,
      pages: [{ pageIndex: 0, derivedPath: 'protected://working-pages/shared-page.png' }],
      importedAt: '2026-08-22T10:00:00.000Z',
    });
    files.files.set('protected://working-pages/shared-page.png', {
      hash: 'shared-page-hash',
      size: 10,
    });
    await repository.updateReport(imported.id, {
      pages: [{ pageIndex: 0, derivedPath: 'protected://working-pages/shared-page.png' }],
    });
    const sharedSanitizedPath = 'protected://sanitized-reports/shared.pdf';
    files.files.set(sharedSanitizedPath, { hash: 'shared-sanitized-hash', size: 10 });
    for (const reportId of [imported.id, second.id]) {
      await repository.saveSanitizedReport({
        reportId,
        recipe: createSanitizationRecipe(reportId, [
          { pageIndex: 0, selected: true, crop: null, rotation: 0, redactions: [] },
        ]),
        recipeHash: `recipe-${reportId}`,
        artifactPath: sharedSanitizedPath,
        artifactHash: 'shared-sanitized-hash',
        verificationState: 'verified',
      });
    }
    assert.equal(second.originalPath, imported.originalPath);
    await service.deleteReport(imported.id);
    assert.equal(await files.exists(imported.originalPath!), true);
    assert.equal(await files.exists('protected://working-pages/shared-page.png'), true);
    assert.equal(await files.exists(sharedSanitizedPath), true);
    assert.equal((await repository.getReport(imported.id))?.importState, 'deleted');
    assert.equal((await repository.getReport(second.id))?.importState, 'imported');
    await service.deleteReport(second.id);
    assert.equal(await files.exists(imported.originalPath!), false);
    assert.equal(await files.exists('protected://working-pages/shared-page.png'), false);
    assert.equal(await files.exists(sharedSanitizedPath), false);
  });

  test('LabsService record-only leaves protected source files and sibling records untouched', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const reports = createService(repository, files);
    const report = (await reports.importPdf(source('labs-record-only')))!.report;
    await repository.createRecord({
      id: 'labs-record-delete',
      labReportId: report.id,
      collectionDate: { kind: 'missing' },
      measurements: [],
    });
    await repository.createRecord({
      id: 'labs-record-sibling',
      labReportId: report.id,
      collectionDate: { kind: 'missing' },
      measurements: [],
    });
    const labs = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: reports.deleteReport,
    });
    await labs.deleteRecord('labs-record-delete');
    assert.equal(await files.exists(report.originalPath!), true);
    assert.equal((await repository.getReport(report.id))?.importState, 'imported');
    assert.notEqual(await repository.getRecord('labs-record-sibling'), null);
  });

  test('LabsService source-only survives restart with linked records and shared source explicit', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'alyte-labs-source-only-'));
    temporaryPaths.push(directory);
    const databasePath = join(directory, 'alyte.sqlite');
    const repository = createRepository(databasePath);
    const files = new FakeFiles();
    const reports = createService(repository, files);
    const report = (await reports.importPdf(source('labs-source-only')))!.report;
    const shared = await repository.createReport({
      id: 'labs-shared-path-report',
      sourceType: 'pdf',
      originalFilename: 'shared.pdf',
      mimeType: 'application/pdf',
      originalPath: report.originalPath,
      sourceHash: 'shared-path-hash',
      importState: 'imported',
    });
    for (const id of ['labs-source-record-one', 'labs-source-record-two'])
      await repository.createRecord({
        id,
        labReportId: report.id,
        collectionDate: { kind: 'missing' },
        measurements: [{ label: id, value: { kind: 'numeric', value: 1 } }],
      });
    const labs = createLabsService({
      repositoryFactory: async () => repository,
      deleteSource: reports.deleteReport,
    });
    await labs.executeDeletion({ kind: 'source-only', recordId: 'labs-source-record-one' });
    assert.equal(
      await files.exists(report.originalPath!),
      true,
      'the other report still owns the shared path',
    );
    assert.equal((await repository.getReport(shared.id))?.importState, 'imported');
    await repository.close();
    const reopened = createRepository(databasePath);
    const relaunched = createLabsService({
      repositoryFactory: async () => reopened,
      deleteSource: async () => undefined,
    });
    for (const id of ['labs-source-record-one', 'labs-source-record-two']) {
      assert.notEqual(await relaunched.getRecord(id), null);
      assert.equal((await relaunched.getRecordDetail(id))?.source.kind, 'deleted');
    }
    await reopened.close();
  });

  test('deletion intent survives a file cleanup failure and remains retryable', async () => {
    const repository = createRepository();
    const files = new FailingDeleteFiles();
    const service = createService(repository, files);
    const imported = (await service.importPdf(source('delete-retry')))!.report;

    files.failRemoval = true;
    await assert.rejects(service.deleteReport(imported.id), /cleanup failure/);
    const failed = await repository.getReport(imported.id);
    assert.equal(failed?.importState, 'imported');
    assert.equal(failed?.deletionState, 'failed');
    assert.equal(failed?.originalPath, imported.originalPath);
    assert.equal(await files.exists(imported.originalPath!), true);

    files.failRemoval = false;
    await service.deleteReport(imported.id);
    const deleted = await repository.getReport(imported.id);
    assert.equal(deleted?.importState, 'deleted');
    assert.equal(deleted?.deletionState, 'complete');
    assert.equal(deleted?.failureReason, 'user-deleted');
    assert.equal(await files.exists(imported.originalPath!), false);
  });

  test('relaunch completes a durable deletion intent after process death before file cleanup', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files);
    const imported = (await service.importPdf(source('delete-relaunch')))!.report;
    await repository.requestReportDeletion(imported.id);
    assert.equal(await files.exists(imported.originalPath!), true);

    const reopened = createService(repository, files);
    const deleted = await reopened.getReport(imported.id);
    assert.equal(deleted?.importState, 'deleted');
    assert.equal(deleted?.deletionState, 'complete');
    assert.equal(await files.exists(imported.originalPath!), false);
  });

  test('relaunch turns an unfinished durable import into an interrupted library item', async () => {
    const databasePath = join(
      mkdtempSync(join(tmpdir(), 'alyte-reports-interrupted-')),
      'alyte.sqlite',
    );
    temporaryPaths.push(databasePath.replace(/\/alyte\.sqlite$/, ''));
    const repository = createRepository(databasePath);
    const report = await repository.createReport({
      id: 'lab-report-interrupted',
      sourceType: 'pdf',
      originalFilename: 'interrupted.pdf',
      mimeType: 'application/pdf',
      importState: 'importing',
    });
    assert.equal(report.importState, 'importing');
    const service = createService(createRepository(databasePath), new FakeFiles());
    const reopened = await service.getReport(report.id);
    assert.equal(reopened?.importState, 'interrupted');
    assert.equal(reopened?.failureReason, 'interrupted-no-protected-source');
  });

  test('hash verification detects accidental source replacement', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files);
    const result = await service.importPdf(source('mutable'));
    assert.ok(result);
    const report = result.report;
    files.files.set(report.originalPath!, { hash: 'tampered', size: 42 });
    const integrity: LabReportSourceIntegrity = await service.verifySource(report.id);
    assert.equal(integrity, 'mismatch');
    await assert.rejects(service.openOriginal(report.id), /integrity/);
  });

  test('renders, protects, re-hashes, and previews the exact verified Sanitized Report', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-exact')))!.report;
    const editor = await service.openSanitizationEditor(imported.id);
    const recipe = addRedaction(editor.recipe, 0, {
      id: 'redaction-name',
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 },
      origin: 'user',
      label: 'name',
    });
    const saved = await service.saveSanitizedReport(imported.id, recipe);
    assert.equal(saved.verificationState, 'verified');
    assert.equal(saved.artifactHash, 'artifact-1');
    const preview = await service.previewSanitizedReport(imported.id);
    assert.equal(preview.artifactPath, saved.artifactPath);
    assert.equal(preview.artifactHash, saved.artifactHash);
    assert.equal(pdf.previewCalls, 2);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('previews a source-aware PDF when standalone verification is structural-only', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    pdf.standaloneVerification = {
      ...verifiedSanitized,
      sourceAwareChecked: false,
      sourceContentRemoved: false,
    };
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-structural-preview')))!.report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );

    assert.equal(saved.verification?.sourceAwareChecked, true);
    const preview = await service.previewSanitizedReport(imported.id);
    assert.equal(preview.artifactPath, saved.artifactPath);
    assert.equal(preview.verification.sourceAwareChecked, false);
    assert.equal(await files.exists(saved.artifactPath!), true);
    assert.deepEqual(await service.getExtractionReadiness(imported.id), {
      ready: true,
      status: 'verified',
    });
  });

  test('rejects a PDF preview when standalone structural verification detects source text', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-structural-failure')))!.report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    pdf.standaloneVerification = {
      ...verifiedSanitized,
      selectableText: true,
      failureReasons: ['selectable-source-text'],
    };

    await assert.rejects(
      service.previewSanitizedReport(imported.id),
      /Sanitized Report no longer passes verification/,
    );
    assert.equal((await repository.getSanitizedReport(imported.id))?.verificationState, 'failed');
    assert.equal(await files.exists(saved.artifactPath!), false);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('sanitizes an image locally without replacing the immutable original', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const image = new SanitizingImage(files);
    const service = createService(repository, files, new FakePdf(), undefined, undefined, image);
    const imported = (await service.importImages([source('sanitize-image', 'image')]))[0]!.report;
    const editor = await service.openSanitizationEditor(imported.id);
    const recipe = addRedaction(editor.recipe, 0, {
      id: 'image-redaction-name',
      rect: { x: 0.1, y: 0.1, width: 0.2, height: 0.08 },
      origin: 'user',
      label: 'name',
    });

    const saved = await service.saveSanitizedReport(imported.id, recipe);
    assert.equal(saved.verificationState, 'verified');
    assert.equal(saved.artifactPath?.endsWith('.jpg'), true);
    assert.deepEqual(image.sanitizedPaths, [saved.artifactPath]);
    const preview = await service.previewSanitizedReport(imported.id);
    assert.deepEqual(preview.uris, [saved.artifactPath]);
    assert.equal(await files.exists(imported.originalPath!), true);
    assert.equal(await files.exists(saved.artifactPath!), true);
  });

  test('extracts an image only from its verified sanitized derivative and preserves page-zero provenance', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const image = new SanitizingImage(files);
    const visionPaths: string[] = [];
    const ocr: VisionOCR = {
      async recognize(path): Promise<VisionOCRResult> {
        visionPaths.push(path);
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'image-collection-date',
              text: 'Collection date 2026-08-22',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.05, width: 0.45, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
            {
              id: 'image-ldl',
              text: 'Blood LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.25, width: 0.45, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
            {
              id: 'image-header',
              text: 'Synthetic laboratory contact details',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.1, width: 0.7, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    };
    const service = createService(repository, files, new FakePdf(), ocr, undefined, image);
    const imported = (await service.importImages([source('extract-image', 'image')]))[0]!.report;
    const editor = await service.openSanitizationEditor(imported.id);
    const saved = await service.saveSanitizedReport(imported.id, editor.recipe);

    const draft = await service.startExtraction(imported.id);
    assert.equal(draft.rows.length, 1, 'unrelated image prose is not a review row');
    assert.equal(draft.rows[0]?.source.pageIndex, 0);
    assert.deepEqual(draft.rows[0]?.source.boundingBox, {
      x: 0.1,
      y: 0.25,
      width: 0.45,
      height: 0.04,
    });
    assert.deepEqual(visionPaths, [saved.artifactPath]);
    assert.notEqual(visionPaths[0], imported.originalPath);

    const records = await service.confirmExtraction(draft.id);
    const measurement = records[0]?.measurements[0];
    assert.deepEqual(measurement?.source?.observationIds, ['image-ldl']);
    assert.equal(measurement?.source?.pageIndex, 0);
    assert.deepEqual(measurement?.source?.boundingBox, draft.rows[0]?.source.boundingBox);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('does not call Vision when an image derivative is missing or tampered', async () => {
    for (const state of ['missing', 'tampered'] as const) {
      const repository = createRepository();
      const files = new FakeFiles();
      const image = new SanitizingImage(files);
      let recognitionCalls = 0;
      const service = createService(
        repository,
        files,
        new FakePdf(),
        {
          async recognize(): Promise<VisionOCRResult> {
            recognitionCalls += 1;
            throw new Error('Vision must not receive an unavailable image derivative');
          },
        },
        undefined,
        image,
      );
      const imported = (await service.importImages([source(`extract-image-${state}`, 'image')]))[0]!
        .report;
      const saved = await service.saveSanitizedReport(
        imported.id,
        (await service.openSanitizationEditor(imported.id)).recipe,
      );
      if (state === 'missing') {
        files.files.delete(saved.artifactPath!);
      } else {
        files.files.set(saved.artifactPath!, { hash: 'tampered-image', size: 256 });
      }

      await assert.rejects(service.startExtraction(imported.id), (error: unknown) => {
        assert.ok(error instanceof LabReportExtractionError);
        assert.equal(error.reason, 'sanitized-source');
        return true;
      });
      assert.equal(recognitionCalls, 0);
      assert.equal((await repository.getSanitizedReport(imported.id))?.verificationState, 'failed');
    }
  });

  test('invalidates image extraction drafts only after a successful derivative replacement or deletion', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const image = new SanitizingImage(files);
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'draft-invalidation-ldl',
              text: 'Blood LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.25, width: 0.45, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    };
    const service = createService(repository, files, new FakePdf(), ocr, undefined, image);
    const imported = (await service.importImages([source('draft-invalidation', 'image')]))[0]!
      .report;
    const first = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    const firstDraft = await service.startExtraction(imported.id);

    const secondRecipe = addRedaction(first.recipe, 0, {
      id: 'draft-invalidation-redaction',
      rect: { x: 0.2, y: 0.2, width: 0.15, height: 0.08 },
      origin: 'user',
      label: 'synthetic-private-region',
    });
    image.failSanitize = true;
    await assert.rejects(
      service.saveSanitizedReport(imported.id, secondRecipe),
      /Sanitized Report could not be verified/,
    );
    assert.equal((await repository.getExtractionDraftForReport(imported.id))?.id, firstDraft.id);
    assert.equal(await files.exists(first.artifactPath!), true);

    image.failSanitize = false;
    const second = await service.saveSanitizedReport(imported.id, secondRecipe);
    assert.notEqual(second.artifactHash, first.artifactHash);
    assert.equal(await repository.getExtractionDraftForReport(imported.id), null);
    assert.equal(await repository.getExtractionDraft(firstDraft.id), null);
    assert.equal(await files.exists(first.artifactPath!), false);

    const replacementDraft = await service.startExtraction(imported.id);
    assert.notEqual(replacementDraft.id, firstDraft.id);
    await service.deleteSanitizedReport(imported.id);
    assert.equal(await repository.getExtractionDraftForReport(imported.id), null);
    assert.equal(await repository.getExtractionDraft(replacementDraft.id), null);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('readiness fails closed for a malformed persisted verification and extraction remains retryable', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const image = new SanitizingImage(files);
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v2',
            pageIndex: 0,
            orientation: 0,
            observations: [
              {
                id: 'readiness-ldl',
                text: 'Blood LDL-C 3.8 mmol/L',
                alternatives: [],
                boundingBox: { x: 0.1, y: 0.25, width: 0.45, height: 0.04 },
                pageIndex: 0,
                orientation: 0,
                recognition: { level: 'accurate', language: 'en', internalConfidence: null },
              },
            ],
          });
        },
      },
      undefined,
      image,
    );
    const imported = (await service.importImages([source('readiness-malformed', 'image')]))[0]!
      .report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    const draft = await service.startExtraction(imported.id);
    await repository.updateSanitizedReport(saved.id, {
      verification: {
        ...saved.verification!,
        verificationVersion: 'future-unsupported-version',
      },
    });

    assert.deepEqual(await service.getExtractionReadiness(imported.id), {
      ready: false,
      status: 'unverified',
    });
    await assert.rejects(service.startExtraction(imported.id), (error: unknown) => {
      assert.ok(error instanceof LabReportExtractionError);
      assert.equal(error.reason, 'sanitized-source');
      return true;
    });
    assert.equal((await repository.getExtractionDraftForReport(imported.id))?.id, draft.id);
    assert.equal(await files.exists(saved.artifactPath!), true);
  });

  test('failed structural verification never exposes the derivative and preserves the original', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    pdf.verification = {
      ...verifiedSanitized,
      verified: false,
      selectableText: true,
      failureReasons: ['selectable-source-text'],
    };
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-fails')))!.report;
    const editor = await service.openSanitizationEditor(imported.id);
    const failed = await service.saveSanitizedReport(imported.id, editor.recipe);
    assert.equal(failed.verificationState, 'failed');
    assert.equal(failed.artifactPath, null);
    await assert.rejects(service.previewSanitizedReport(imported.id), /not verified/);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('failed regeneration preserves the last verified derivative and relaunch cleans stale bytes', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-regenerate')))!.report;
    const firstRecipe = (await service.openSanitizationEditor(imported.id)).recipe;
    const first = await service.saveSanitizedReport(imported.id, firstRecipe);
    const secondRecipe = addRedaction(firstRecipe, 0, {
      id: 'redaction-address',
      rect: { x: 0.2, y: 0.2, width: 0.2, height: 0.08 },
      origin: 'user',
      label: 'address',
    });
    pdf.verification = {
      ...verifiedSanitized,
      verified: false,
      sourceAwareChecked: false,
      sourceContentRemoved: false,
      failureReasons: ['synthetic replacement failure'],
    };
    await assert.rejects(service.saveSanitizedReport(imported.id, secondRecipe), /replacement/);
    const preserved = await repository.getSanitizedReport(imported.id);
    assert.equal(preserved?.artifactPath, first.artifactPath);
    assert.equal(await files.exists(first.artifactPath!), true);

    pdf.verification = verifiedSanitized;
    const second = await service.saveSanitizedReport(imported.id, secondRecipe);
    assert.notEqual(second.recipeHash, first.recipeHash);
    assert.equal(await files.exists(first.artifactPath!), false);
    assert.equal(await files.exists(imported.originalPath!), true);
    await service.deleteSanitizedReport(imported.id);
    assert.equal(await repository.getSanitizedReport(imported.id), null);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('relaunch removes an unreferenced sanitized artifact after cleanup was interrupted', async () => {
    const repository = createRepository();
    const files = new FailingDeleteFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-orphan-recovery')))!.report;
    const first = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    const nextRecipe = addRedaction(first.recipe, 0, {
      id: 'redaction-next',
      rect: { x: 0.3, y: 0.3, width: 0.15, height: 0.08 },
      origin: 'user',
      label: 'next',
    });
    files.failRemoval = true;
    const next = await service.saveSanitizedReport(imported.id, nextRecipe);
    assert.equal(await files.exists(first.artifactPath!), true);
    assert.equal(await files.exists(next.artifactPath!), true);
    files.failRemoval = false;
    const relaunched = createService(repository, files, pdf);
    assert.equal(
      (await relaunched.getSanitizedReport(imported.id))?.artifactPath,
      next.artifactPath,
    );
    assert.equal(await files.exists(first.artifactPath!), false);
  });

  test('preview invalidates a derivative after hash tampering', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-tamper')))!.report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    files.files.set(saved.artifactPath!, { hash: 'tampered', size: 128 });
    await assert.rejects(service.previewSanitizedReport(imported.id), /hash changed/);
    const failed = await repository.getSanitizedReport(imported.id);
    assert.equal(failed?.verificationState, 'failed');
    assert.equal(await files.exists(saved.artifactPath!), false);
  });

  test('derivative deletion records pending cleanup before a file failure', async () => {
    const repository = createRepository();
    const files = new FailingDeleteFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-delete-file-failure')))!.report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    files.failRemoval = true;
    await assert.rejects(service.deleteSanitizedReport(imported.id), /could not be deleted/);
    const pending = await repository.getSanitizedReport(imported.id);
    assert.equal(pending?.verificationState, 'failed');
    assert.equal(pending?.failureReason, 'sanitized-delete-pending');
    assert.equal(await files.exists(saved.artifactPath!), true);
  });

  test('relaunch reconciles a row when the database fails after derivative removal', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SanitizingPdf();
    pdf.files = files;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('sanitize-delete-db-failure')))!.report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    const deleteRow = repository.deleteSanitizedReport;
    repository.deleteSanitizedReport = async () => {
      throw new Error('synthetic database failure after file removal');
    };
    await assert.rejects(service.deleteSanitizedReport(imported.id), /database failure/);
    assert.equal(await files.exists(saved.artifactPath!), false);
    const pending = await repository.getSanitizedReport(imported.id);
    assert.equal(pending?.verificationState, 'failed');
    assert.equal(pending?.failureReason, 'sanitized-delete-pending');
    repository.deleteSanitizedReport = deleteRow;
    const relaunched = createService(repository, files, pdf);
    assert.equal(await relaunched.getSanitizedReport(imported.id), null);
  });
});

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
  extractionReviewRequiresAttention,
  groupObservationsIntoRows,
  normalizeUnit,
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
  localCalendarDateFromInstant,
  LabReportExtractionError,
  LabReportImportError,
  LabReportSelectionError,
  resolveLabReportImportDestination,
  type LabReportsServiceOptions,
  type LabReportsService,
  type LabReportExtractionProgress,
} from './report-service';

test('fallback collection dates use the device local calendar rather than UTC slicing', () => {
  const instant = '2026-08-27T22:30:00.000Z';
  const local = new Date(instant);
  const expected = `${local.getFullYear().toString().padStart(4, '0')}-${(local.getMonth() + 1)
    .toString()
    .padStart(2, '0')}-${local.getDate().toString().padStart(2, '0')}`;
  assert.deepEqual(localCalendarDateFromInstant(instant), { kind: 'known', value: expected });
});
import type { LabSourcePicker } from './pickers';
import type {
  PdfInspection,
  PdfInspectionSession,
  PdfInspector,
  PdfViewerOpenResult,
  PdfViewerSession,
} from './pdf';
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
  return createRepositoryWithDatabase(databasePath).repository;
}

function createRepositoryWithDatabase(databasePath?: string): {
  readonly database: NodeSqliteDatabase;
  readonly repository: LabRepository;
} {
  const directory =
    databasePath === undefined ? mkdtempSync(join(tmpdir(), 'alyte-reports-')) : null;
  if (directory !== null) temporaryPaths.push(directory);
  const database = new NodeSqliteDatabase(
    databasePath ?? join(directory as string, 'alyte.sqlite'),
  );
  return {
    database,
    repository: createLabRepository(database, {
      protection,
      now: () => '2026-08-22T10:00:00.000Z',
      idGenerator: (prefix) => `${prefix}-test-${Math.random().toString(36).slice(2)}`,
    }),
  };
}

/** Reproduce legacy local stores created before the per-report draft uniqueness constraint. */
async function allowMultipleExtractionDrafts(database: NodeSqliteDatabase): Promise<void> {
  await database.execAsync(`
    PRAGMA foreign_keys = OFF;
    CREATE TABLE extraction_drafts_without_unique AS SELECT * FROM extraction_drafts WHERE 0;
    CREATE TABLE extraction_draft_rows_without_fk AS SELECT * FROM extraction_draft_rows WHERE 0;
    DROP TABLE extraction_draft_rows;
    DROP TABLE extraction_drafts;
    ALTER TABLE extraction_drafts_without_unique RENAME TO extraction_drafts;
    ALTER TABLE extraction_draft_rows_without_fk RENAME TO extraction_draft_rows;
    CREATE INDEX extraction_drafts_report_id_idx ON extraction_drafts(report_id);
    CREATE INDEX extraction_draft_rows_draft_id_idx ON extraction_draft_rows(draft_id, row_order);
    PRAGMA foreign_keys = ON;
  `);
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

class FailingStageFiles extends FakeFiles {
  override async stage(source: LabSourceSelection, importId: string): Promise<ProtectedCopy> {
    await super.stage(source, importId);
    throw new Error('storage exhausted after stage copy');
  }
}

class FailingPromotionFiles extends FakeFiles {
  private failedPromotion: ProtectedCopy | null = null;

  override async promote(
    staged: ProtectedCopy,
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy> {
    this.failedPromotion = await super.promote(staged, reportId, source);
    throw new Error('storage exhausted after promotion copy');
  }

  override async recoverPromoted(
    _reportId: string,
    _source: LabSourceSelection,
  ): Promise<ProtectedCopy | null> {
    const promoted = this.failedPromotion;
    if (promoted === null || !this.files.has(promoted.path)) return null;
    return promoted;
  }
}

class RetainedPromotionCleanupFiles extends FailingPromotionFiles {
  failOriginalRemoval = true;

  override async remove(path: string): Promise<void> {
    if (this.failOriginalRemoval && path.includes('/originals/')) {
      throw new Error('synthetic promoted-source cleanup failure');
    }
    await super.remove(path);
  }
}

class FlakyOriginalOrphanCleanupFiles extends FakeFiles {
  failuresRemaining = 1;

  override async removeOwnedFile(path: string): Promise<void> {
    if (path.startsWith('protected://original-reports/') && this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('synthetic orphan cleanup interruption');
    }
    await super.removeOwnedFile(path);
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
  inspectCalls = 0;
  previewCalls = 0;
  async inspect(path: string): Promise<PdfInspection> {
    this.inspectCalls += 1;
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

class ViewerPdf extends FakePdf {
  viewerOpenCalls = 0;
  viewerUnlockCalls = 0;
  viewerCloseCalls = 0;

  viewerPageCount = 2;

  async openViewer(_path: string): Promise<PdfViewerOpenResult> {
    this.viewerOpenCalls += 1;
    if (this.locked) return { locked: true, pageCount: 0, session: null };
    return {
      locked: false,
      pageCount: this.viewerPageCount,
      session: {
        pageCount: this.viewerPageCount,
        sessionId: 'synthetic-pdf-session',
        close: async () => {
          this.viewerCloseCalls += 1;
        },
      },
    };
  }

  async unlockViewer(_path: string, password: string): Promise<PdfViewerSession> {
    this.viewerUnlockCalls += 1;
    await this.unlock(_path, password);
    return {
      pageCount: this.viewerPageCount,
      sessionId: 'synthetic-locked-pdf-session',
      close: async () => {
        this.viewerCloseCalls += 1;
      },
    };
  }
}

class CorruptViewerPdf extends ViewerPdf {
  override async unlockViewer(_path: string, _password: string): Promise<PdfViewerSession> {
    throw new Error('The PDF could not be opened');
  }
}

class EmptyViewerPdf extends ViewerPdf {
  override async openViewer(_path: string): Promise<PdfViewerOpenResult> {
    this.viewerOpenCalls += 1;
    return {
      locked: false,
      pageCount: 0,
      session: {
        pageCount: 0,
        sessionId: 'synthetic-empty-pdf-session',
        close: async () => {
          this.viewerCloseCalls += 1;
        },
      },
    };
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

class ViewerImage extends SanitizingImage {
  viewerOpenCalls = 0;
  viewerCloseCalls = 0;

  async openViewer(_path: string) {
    this.viewerOpenCalls += 1;
    return { sessionId: 'synthetic-image-session', width: 1200, height: 900 };
  }

  async closeViewer(_sessionId: string) {
    this.viewerCloseCalls += 1;
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

type CreateServiceOverrides = {
  readonly pdf?: PdfInspector;
  readonly visionOCR?: VisionOCR;
  readonly semanticMapper?: ExtractionSemanticMapper;
  readonly imageInspector?: LabReportsServiceOptions['imageInspector'];
  readonly picker?: LabSourcePicker;
};

function isCreateServiceOverrides(value: unknown): value is CreateServiceOverrides {
  if (value === null || typeof value !== 'object') return false;
  return ['pdf', 'visionOCR', 'semanticMapper', 'imageInspector', 'picker'].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function createService(
  repository: LabRepository,
  files: FakeFiles,
  pdfOrOverrides?: PdfInspector | CreateServiceOverrides,
  visionOCR?: VisionOCR,
  semanticMapper?: ExtractionSemanticMapper,
  imageInspector?: LabReportsServiceOptions['imageInspector'],
  picker?: LabSourcePicker,
): LabReportsService {
  const overrides =
    pdfOrOverrides === undefined
      ? { visionOCR, semanticMapper, imageInspector, picker }
      : isCreateServiceOverrides(pdfOrOverrides)
        ? pdfOrOverrides
        : { pdf: pdfOrOverrides, visionOCR, semanticMapper, imageInspector, picker };
  return createLabReportsService({
    repositoryFactory: async () => repository,
    fileService: files,
    pdfInspector: overrides.pdf ?? new FakePdf(),
    ...(overrides.visionOCR === undefined ? {} : { visionOCR: overrides.visionOCR }),
    ...(overrides.semanticMapper === undefined ? {} : { semanticMapper: overrides.semanticMapper }),
    ...(overrides.imageInspector === undefined ? {} : { imageInspector: overrides.imageInspector }),
    ...(overrides.picker === undefined ? {} : { picker: overrides.picker }),
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

test('duplicate import destination resumes only an open draft and otherwise returns the report', () => {
  assert.deepEqual(resolveLabReportImportDestination(false, null), { kind: 'extraction-progress' });
  assert.deepEqual(resolveLabReportImportDestination(true, { id: 'draft-open', state: 'draft' }), {
    kind: 'extraction-draft',
    draftId: 'draft-open',
  });
  assert.deepEqual(
    resolveLabReportImportDestination(true, { id: 'draft-confirmed', state: 'confirmed' }),
    { kind: 'report-detail' },
  );
  assert.deepEqual(
    resolveLabReportImportDestination(true, { id: 'draft-failed', state: 'failed' }),
    { kind: 'report-detail' },
  );
  assert.deepEqual(resolveLabReportImportDestination(true, null), { kind: 'report-detail' });
});

describe('protected Lab Report import lifecycle', () => {
  test('retries a failed report repository open on the next local read', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let attempts = 0;
    const reports = createLabReportsService({
      repositoryFactory: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('temporary report database open failure');
        return repository;
      },
      fileService: files,
    });

    await assert.rejects(reports.listReports(), /temporary report database open failure/);
    assert.deepEqual(await reports.listReports(), []);
    assert.equal(attempts, 2);
  });

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
        pipelineFingerprint: null,
        pipelineStatus: 'older' as const,
        revision: 1,
        hasUserEdits: false,
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

  test('preserves complete units through the production import and extraction draft path', async () => {
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
    const unitObservations = units.map((unit, index) => ({
      id: `unit-${index}`,
      text: `Unfamiliar analyte ${index + 1} ${unit}`,
      alternatives: [],
      boundingBox: { x: 0.1, y: 0.05 + index * 0.06, width: 0.8, height: 0.03 },
      pageIndex: 0,
      orientation: 0,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    }));
    const ldlObservation = {
      id: 'incompatible-known-unit',
      text: 'LDL-C 3.8 mg/L',
      alternatives: [],
      boundingBox: { x: 0.1, y: 0.82, width: 0.8, height: 0.03 },
      pageIndex: 0,
      orientation: 0,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    };
    const footerObservation = {
      id: 'numeric-footer',
      text: 'Synthetic laboratory footer 2026',
      alternatives: [],
      boundingBox: { x: 0.1, y: 0.94, width: 0.8, height: 0.03 },
      pageIndex: 0,
      orientation: 0,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    };
    const observations = [...unitObservations, ldlObservation, footerObservation];
    const ocr: VisionOCR = {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: pageIndex === 0 ? observations : [],
        });
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, new FakePdf(), ocr);
    const report = (await service.importPdf(source('unit-preservation-production')))!.report;
    const draft = await service.startExtraction(report.id);
    const rowByObservation = new Map(
      draft.rows.flatMap((row) => row.source.observationIds.map((id) => [id, row] as const)),
    );

    assert.equal(draft.rows.length, units.length + 1);
    for (const [index, unit] of units.entries()) {
      const row = rowByObservation.get(`unit-${index}`);
      assert.ok(row, unit);
      const expectedUnit = normalizeUnit(unit);
      assert.equal(row?.source.raw?.unit, unit, unit);
      assert.equal(row?.sourceUnit, expectedUnit, unit);
      assert.equal(row?.proposedUnit, expectedUnit, unit);
      assert.equal(row?.reviewState, 'needs-review', unit);
      assert.ok(row?.reviewReasons.includes('unsupported-alias'), unit);
      assert.equal(row?.decision, 'preserve', unit);
    }

    const incompatible = rowByObservation.get(ldlObservation.id);
    assert.ok(incompatible);
    assert.equal(incompatible?.source.raw?.unit, 'mg/L');
    assert.equal(incompatible?.proposedUnit, 'mg/L');
    assert.ok(incompatible?.reviewReasons.includes('incompatible-unit'));
    assert.equal(incompatible?.decision, 'skip');
    assert.equal(rowByObservation.has(footerObservation.id), false);
  });

  test('keeps slash prose and assay methods out of units through the production path', async () => {
    const observations = [
      ['method-only', 'LDL-C 3.8 CHOD/PAP'],
      ['unit-before-value', 'mg/L LDL-C 3.8 CHOD/PAP'],
      ['terminal-punctuation', 'LDL-C 3.8 mg/L.'],
      ['url-footer', 'Synthetic footer 2026 https://www.example.test/g/L'],
      ['prose-footer', 'Synthetic footer 2026 Final/Verified'],
    ].map(([id, text], index) => ({
      id,
      text,
      alternatives: [],
      boundingBox: { x: 0.1, y: 0.1 + index * 0.14, width: 0.8, height: 0.04 },
      pageIndex: 0,
      orientation: 0,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    }));
    const ocr: VisionOCR = {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: pageIndex === 0 ? observations : [],
        });
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, new FakePdf(), ocr);
    const report = (await service.importPdf(source('unit-token-negative-production')))!.report;
    const draft = await service.startExtraction(report.id);
    const rowByObservation = new Map(
      draft.rows.flatMap((row) => row.source.observationIds.map((id) => [id, row] as const)),
    );

    assert.equal(draft.rows.length, 3);
    assert.equal(rowByObservation.get('method-only')?.sourceUnit, null);
    assert.equal(rowByObservation.get('method-only')?.proposedUnit, null);

    const unitBeforeValue = rowByObservation.get('unit-before-value');
    assert.ok(unitBeforeValue);
    assert.equal(unitBeforeValue?.source.raw?.unit, 'mg/L');
    assert.equal(unitBeforeValue?.proposedUnit, 'mg/L');
    assert.ok(unitBeforeValue?.reviewReasons.includes('incompatible-unit'));

    const terminalPunctuation = rowByObservation.get('terminal-punctuation');
    assert.ok(terminalPunctuation);
    assert.equal(terminalPunctuation?.source.raw?.unit, 'mg/L');
    assert.equal(terminalPunctuation?.proposedUnit, 'mg/L');
    assert.equal(rowByObservation.has('url-footer'), false);
    assert.equal(rowByObservation.has('prose-footer'), false);
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
    assert.equal(draft.rows[0]?.reviewReasons.includes('defaulted-collection-date'), true);
    assert.equal(draft.rows[0]?.collectionDateContext, null);
    assert.equal(draft.rows[0]?.source.raw?.collectionDate, null);
    const dated = await service.updateExtractionGroupDate(
      draft.id,
      draft.rows[0]!.collectionDate,
      draft.rows[0]!.proposedSpecimenType,
      { kind: 'known', value: '2026-08-22' },
    );
    assert.deepEqual(dated.rows[0]?.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.equal(dated.rows[0]?.reviewReasons.includes('defaulted-collection-date'), false);
    const corrected = await service.updateExtractionRow(draft.rows[0]!.id, {
      proposedLabel: 'LDL-C',
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

  test('keeps local extraction independent from the Sanitized Report', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let recognitionCalls = 0;
    const service = createService(repository, files, new FakePdf(), {
      async recognize() {
        recognitionCalls += 1;
        throw new Error('synthetic Vision failure');
      },
    });
    const report = (await service.importImages(source('unsanitized', 'image')))!.report;
    await assert.rejects(service.startExtraction(report.id), (error: unknown) => {
      assert.ok(error instanceof LabReportExtractionError);
      assert.equal(error.reason, 'recognition');
      return true;
    });
    assert.equal(recognitionCalls, 1);
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
          {
            sourceObservationIds: ['semantic-source'],
            proposedBiomarkerId: 'biomarker.ldl_c',
            proposedSpecimenType: 'serum',
          },
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
    assert.equal(draft.rows[0]?.proposedSpecimenType, 'serum');
    assert.deepEqual(draft.rows[0]?.source.semantic, {
      adapterVersion: 'synthetic.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      sourceObservationIds: ['semantic-source'],
    });
    assert.equal(draft.rows[0]?.source.observations?.[0]?.text, 'Sintetinis žymuo 3,8 mmol/L');
    assert.equal(draft.rows[1]?.proposedBiomarkerId, null);
    assert.equal(draft.rows[1]?.source.semantic, null);
  });

  test('improves only unresolved automatic rows and preserves user decisions', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let mapperCalls = 0;
    const observations = ['improve-auto', 'improve-user'].map((id, index) => ({
      id,
      text: `Unknown marker ${index + 1}.2 mg/dL`,
      alternatives: [],
      boundingBox: { x: 0.1, y: 0.2 + index * 0.12, width: 0.6, height: 0.04 },
      pageIndex: 0,
      orientation: 0,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: 0.8 },
    }));
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
      {
        adapterVersion: 'improve.mapper.v1',
        schemaVersion: 'alyte.semantic-mapper.v1',
        supports: () => true,
        async map({ rows }) {
          mapperCalls += 1;
          if (mapperCalls === 1) return [];
          return rows.length === 1
            ? [{ sourceObservationIds: ['improve-auto'], proposedBiomarkerId: 'biomarker.ldl_c' }]
            : [];
        },
      },
    );
    const report = (await service.importPdf(source('improve')))!.report;
    const draft = await service.startExtraction(report.id);
    const userRow = await service.updateExtractionRow(draft.rows[1]!.id, { decision: 'skip' });
    const improved = await service.improveExtraction(report.id);
    assert.equal(mapperCalls, 2);
    assert.equal(improved.rows[0]?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(improved.rows[1], userRow);
    assert.equal(improved.rows[0]?.editState, 'automatic');
  });

  test('restores the exact open draft when the Original changes after reprocess replacement', async () => {
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
              id: 'reprocess-preserve-source',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
            },
          ],
        };
      },
    };
    const service = createService(repository, files, new FakePdf(), ocr);
    const report = (await service.importImages(source('reprocess-preserve', 'image')))!.report;
    const original = await service.startExtraction(report.id);
    const edited = await service.updateExtractionRow(original.rows[0]!.id, { decision: 'skip' });
    const replace = repository.replaceExtractionDraft.bind(repository);
    let mutated = false;
    repository.replaceExtractionDraft = async (input) => {
      const replacement = await replace(input);
      if (!mutated) {
        mutated = true;
        for (const [path, file] of files.files) {
          if (path.includes('/originals/'))
            files.files.set(path, { ...file, hash: 'changed-after-write' });
        }
      }
      return replacement;
    };
    await assert.rejects(
      service.reprocessExtraction(report.id),
      /changed and must be imported again/,
    );
    const restored = await repository.getExtractionDraft(original.id);
    assert.equal(restored?.id, original.id);
    assert.deepEqual(restored?.rows[0], edited);
  });

  test('bounds mapper input by candidate rows and keeps independent valid proposals on partial failure', async () => {
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
    assert.equal(draft.rows[0]?.source.semantic?.adapterVersion, 'bounded.mapper.v1');
    assert.equal(draft.rows[1]?.source.semantic, null);
    assert.equal(
      draft.rows.slice(2).every((row) => row.source.semantic === null),
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

  test('inherits v3 table specimen context without changing deterministic row fields', async () => {
    const observation = (
      id: string,
      text: string,
      tableId: string,
      rowIndex: number,
      columnIndex: number,
      x = 0.1 + columnIndex * 0.18,
    ) => ({
      id,
      text,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: { x, y: 0.08 + rowIndex * 0.05, width: 0.15, height: 0.03 },
      structure: {
        kind: 'table-cell' as const,
        tableId,
        rowIndex,
        columnIndex,
      },
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    });
    const observations = [
      {
        id: 'collection-date',
        text: 'Collection date 2026-08-20',
        alternatives: [],
        pageIndex: 0,
        orientation: 0,
        boundingBox: { x: 0.1, y: 0.01, width: 0.35, height: 0.03 },
        recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
      },
      observation('table-serum-heading', 'Serum', 'table-serum', 0, 0),
      observation('table-serum-label', 'Ferritin', 'table-serum', 1, 0),
      observation('table-serum-value', '42', 'table-serum', 1, 1),
      observation('table-serum-unit', 'ng/mL', 'table-serum', 1, 2),
      observation('table-serum-reference', '15-300', 'table-serum', 1, 3),
      observation('table-plasma-label', 'Glucose', 'table-serum', 2, 0),
      observation('table-plasma-value', '5.7', 'table-serum', 2, 1),
      observation('table-plasma-unit', 'mmol/L', 'table-serum', 2, 2),
      observation('table-plasma-reference', '4.0-5.9', 'table-serum', 2, 3),
      observation('table-plasma-specimen', 'Plasma', 'table-serum', 2, 4),
      observation(
        'table-conflicting-row',
        'Glucose 100 mg/dL 70-110 Serum Plasma',
        'table-conflicting',
        0,
        0,
      ),
      observation('table-unknown-row', 'Glucose 100 mg/dL 70-110', 'table-unknown', 0, 0),
    ];
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, sanitizingPdf(files), {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v3',
          pageIndex: 0,
          orientation: 0,
          observations,
        });
      },
    });
    const report = (await service.importPdf(source('v3-table-specimen-context')))!.report;
    const draft = await service.startExtraction(report.id);
    const rows = new Map(
      draft.rows.flatMap((row) => row.source.observationIds.map((id) => [id, row] as const)),
    );

    const serumRow = rows.get('table-serum-label');
    assert.ok(serumRow);
    assert.equal(serumRow.proposedSpecimenType, 'serum');
    assert.equal(serumRow.proposedBiomarkerId, 'biomarker.ferritin');
    assert.deepEqual(serumRow.proposedValue, { kind: 'numeric', value: 42 });
    assert.equal(serumRow.sourceValueString, '42');
    assert.equal(serumRow.sourceUnit, 'ng/mL');
    assert.equal(serumRow.proposedUnit, 'ng/mL');
    assert.equal(serumRow.sourceReferenceInterval, '15-300');
    assert.equal(serumRow.proposedReferenceInterval, '15-300');
    assert.deepEqual(serumRow.collectionDate, { kind: 'known', value: '2026-08-20' });
    assert.deepEqual(serumRow.source.observationIds, [
      'table-serum-label',
      'table-serum-value',
      'table-serum-unit',
      'table-serum-reference',
    ]);
    assert.deepEqual(serumRow.source.raw, {
      label: 'Ferritin',
      value: '42',
      unit: 'ng/mL',
      referenceInterval: '15-300',
      flag: null,
      collectionDate: 'Collection date 2026-08-20',
    });

    const plasmaRow = rows.get('table-plasma-label');
    assert.ok(plasmaRow);
    assert.equal(plasmaRow.proposedSpecimenType, 'plasma');
    assert.equal(plasmaRow.proposedBiomarkerId, 'biomarker.glucose');
    assert.deepEqual(plasmaRow.proposedValue, { kind: 'numeric', value: 5.7 });
    assert.equal(plasmaRow.sourceValueString, '5.7');
    assert.equal(plasmaRow.sourceUnit, 'mmol/L');
    assert.equal(plasmaRow.proposedUnit, 'mmol/L');
    assert.equal(plasmaRow.sourceReferenceInterval, '4.0-5.9');
    assert.equal(plasmaRow.proposedReferenceInterval, '4.0-5.9');
    assert.deepEqual(plasmaRow.collectionDate, { kind: 'known', value: '2026-08-20' });
    assert.deepEqual(plasmaRow.source.observationIds, [
      'table-plasma-label',
      'table-plasma-value',
      'table-plasma-unit',
      'table-plasma-reference',
      'table-plasma-specimen',
    ]);
    assert.deepEqual(plasmaRow.source.raw, {
      label: 'Glucose',
      value: '5.7',
      unit: 'mmol/L',
      referenceInterval: '4.0-5.9',
      flag: null,
      collectionDate: 'Collection date 2026-08-20',
    });
    assert.equal(rows.get('table-conflicting-row')?.proposedSpecimenType, 'unknown');
    assert.equal(rows.get('table-unknown-row')?.proposedSpecimenType, 'unknown');
  });

  test('does not let a semantic mapper author v3 specimen context', async () => {
    const observation = (id: string, text: string, columnIndex: number) => ({
      id,
      text,
      alternatives: [],
      pageIndex: 0,
      orientation: 0,
      boundingBox: {
        x: 0.1 + columnIndex * 0.18,
        y: 0.08,
        width: 0.15,
        height: 0.03,
      },
      structure: {
        kind: 'table-cell' as const,
        tableId: 'table-unknown',
        rowIndex: 0,
        columnIndex,
      },
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    });
    const observations = [
      observation('unknown-label-a', 'Unmapped marker', 0),
      observation('unknown-label-b', 'result', 1),
      observation('unknown-value', '100', 2),
      observation('unknown-unit', 'mg/dL', 3),
      observation('unknown-reference', '70-110', 4),
    ];
    let mapperCalls = 0;
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'v3-specimen-lock.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map({ rows }) {
        mapperCalls += 1;
        return rows.map((row) => ({
          sourceObservationIds: row.sourceObservationIds,
          proposedBiomarkerId: 'biomarker.glucose',
          proposedSpecimenType: 'serum' as const,
        }));
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      sanitizingPdf(files),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v3',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importPdf(source('v3-specimen-lock')))!.report;
    const draft = await service.startExtraction(report.id);
    assert.equal(mapperCalls, 1);
    assert.equal(draft.rows.length, 1);
    assert.equal(draft.rows[0]?.proposedSpecimenType, 'unknown');
    assert.equal(draft.rows[0]?.proposedBiomarkerId, 'biomarker.glucose');
  });

  test('gates missing packs before OCR while preserving a distinct runtime fallback path', async () => {
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
      supports: () => true,
      checkAvailability: async () => {
        throw Object.assign(new Error('synthetic missing verified pack'), {
          code: 'semantic-model-unavailable' as const,
        });
      },
      prepare: async () => {
        throw Object.assign(new Error('synthetic deleted pack'), {
          code: 'semantic-model-unavailable' as const,
        });
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

  test('routes typed mid-operation model loss while runtime failure keeps deterministic rows', async () => {
    const ocr: VisionOCR = {
      async recognize() {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'mid-operation-source',
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
    const mapper = (
      error: Error,
      onRelease: () => void = () => undefined,
    ): ExtractionSemanticMapper => ({
      adapterVersion: 'mid-operation.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      prepare: async () => ({ release: async () => onRelease() }),
      async map() {
        throw error;
      },
    });

    const unavailableRepository = createRepository();
    let unavailableReleaseCalls = 0;
    const unavailableService = createService(
      unavailableRepository,
      new FakeFiles(),
      new FakePdf(),
      ocr,
      mapper(
        Object.assign(new Error('synthetic model removed'), {
          code: 'semantic-model-unavailable' as const,
        }),
        () => {
          unavailableReleaseCalls += 1;
        },
      ),
    );
    const unavailableReport = (await unavailableService.importPdf(
      source('mid-operation-unavailable'),
    ))!.report;
    const unavailableDraft = await unavailableService.startExtraction(unavailableReport.id);
    assert.equal(unavailableDraft.rows.length, 1);
    assert.equal(await unavailableService.countOpenExtractionDrafts(), 1);
    assert.equal(unavailableReleaseCalls, 1);

    let runtimeReleaseCalls = 0;
    const runtimeRepository = createRepository();
    const runtimeService = createService(
      runtimeRepository,
      new FakeFiles(),
      new FakePdf(),
      ocr,
      mapper(
        Object.assign(new Error('synthetic runtime failure'), {
          failureCategory: 'runtime-failed' as const,
        }),
        () => {
          runtimeReleaseCalls += 1;
        },
      ),
    );
    const runtimeReport = (await runtimeService.importPdf(source('mid-operation-runtime')))!.report;
    const runtimeDraft = await runtimeService.startExtraction(runtimeReport.id);
    assert.equal(runtimeDraft.rows.length, 1);
    assert.equal(runtimeDraft.rows[0]?.source.semantic, null);
    assert.equal(runtimeReleaseCalls, 1);
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

  test('recognizes Lithuanian specimen collection wording without using birth or issued dates', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      {
        id: 'lt-issued-date',
        text: 'Ataskaitos išdavimo data 2026-08-28',
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.01, width: 0.55, height: 0.03 },
        pageIndex: 0,
        orientation: 0,
        recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
      },
      {
        id: 'lt-birth-date',
        text: 'Gimimo data 1990-01-01',
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.15, width: 0.45, height: 0.03 },
        pageIndex: 0,
        orientation: 0,
        recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
      },
      {
        id: 'lt-collection-date',
        text: 'Mėginio data 2026-08-22',
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.29, width: 0.45, height: 0.03 },
        pageIndex: 0,
        orientation: 0,
        recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
      },
      {
        id: 'lt-date-measurement',
        text: 'LDL-C 3,8 mmol/L',
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.4, width: 0.55, height: 0.03 },
        pageIndex: 0,
        orientation: 0,
        recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
      },
    ];
    const service = createService(repository, files, sanitizingPdf(files), {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations,
        };
      },
    });
    const report = (await service.importPdf(source('lt-collection-date')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows.length, 1);
    assert.deepEqual(draft.rows[0]?.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.equal(draft.rows[0]?.collectionDateContext?.sourceText, 'Mėginio data 2026-08-22');
    assert.deepEqual(draft.rows[0]?.source.observationIds, ['lt-date-measurement']);
  });

  test('keeps a representative multilingual 45-row report under the compact mapper blocker target', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      {
        id: 'aggregate-collection-date',
        text: 'Mėginio data 2026-08-22',
        alternatives: [],
        boundingBox: { x: 0.05, y: 0.01, width: 0.4, height: 0.03 },
        pageIndex: 0,
        orientation: 0,
        recognition: { level: 'accurate' as const, language: 'lt', internalConfidence: null },
      },
      ...Array.from({ length: 45 }, (_, index) => {
        const y = 0.08 + index * 0.012;
        const safe = index < 30;
        const noisy = index >= 30 && index < 38;
        const unsupported = index >= 38 && index < 42;
        const ambiguous = index >= 42;
        const language = index % 3 === 0 ? 'en' : index % 3 === 1 ? 'de' : 'lt';
        const label =
          language === 'de'
            ? 'LDL-Cholesterin'
            : language === 'lt'
              ? 'Mažo tankio lipoproteinų cholesterolis'
              : unsupported
                ? 'Unbekannter Marker'
                : 'LDL-C';
        const cells = [
          ['label', label, 0.05],
          ['value', ambiguous ? '3,8' : index % 2 === 0 ? '3,8' : '3.8', 0.28],
          ['unit', 'mmol/L', 0.4],
          ['range', '<5,0', 0.55],
          ...(ambiguous ? [['second-value', '4,2', 0.67] as const] : []),
          ...(noisy ? [['metadata', `Batch ${index + 1}`, 0.72] as const] : []),
        ];
        if (safe) cells.splice(4);
        return cells.map(([field, text, x], columnIndex) => ({
          id: `aggregate-${index}-${field}`,
          text: text as string,
          alternatives: [],
          boundingBox: { x: x as number, y, width: 0.12, height: 0.03 },
          pageIndex: 0,
          orientation: 0,
          structure: {
            kind: 'table-cell' as const,
            tableId: 'aggregate-results',
            rowIndex: index,
            columnIndex,
          },
          recognition: { level: 'accurate' as const, language, internalConfidence: null },
        }));
      }).flat(),
    ];
    const chunks: number[] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'aggregate.mapper.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 4,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        chunks.push(rows.length);
        const ordered = [...rows].sort((left, right) => left.rowId.localeCompare(right.rowId));
        const proposals: Record<string, unknown>[] = [];
        ordered.forEach((row, rowIndex) => {
          const label = row.observations[0]?.text ?? '';
          if (row.observations.some((observation) => observation.text === '4,2')) return;
          if (label.includes('Unbekannter')) {
            proposals.push({
              rowKey: `r${rowIndex}`,
              labelKey: 'c0',
              valueKey: 'c1',
              unitKey: 'c2',
              referenceIntervalKey: 'c3',
              flagKey: null,
              role: 'preserve',
              specimenType: 'unknown',
              biomarkerId: null,
            });
          } else if (label.includes('LDL') || label.includes('Mažo tankio')) {
            proposals.push({
              rowKey: `r${rowIndex}`,
              labelKey: 'c0',
              valueKey: 'c1',
              unitKey: 'c2',
              referenceIntervalKey: 'c3',
              flagKey: null,
              role: 'measurement',
              specimenType: 'serum',
              biomarkerId: 'biomarker.ldl_c',
            });
          }
        });
        return {
          schemaVersion: 'alyte.semantic-mapper.v2',
          proposals,
        };
      },
    };
    const service = createService(
      repository,
      files,
      sanitizingPdf(files),
      {
        async recognize(): Promise<VisionOCRResult> {
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
    const report = (await service.importPdf(source('compact-aggregate')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.rows.length, 45);
    assert.ok(Math.max(...chunks) <= 2);
    assert.ok(chunks.length > 0);
    assert.equal(draft.rows.filter(extractionReviewRequiresAttention).length, 3);
    assert.equal(draft.rows.filter((row) => row.source.semantic !== null).length, 9);
    assert.equal(
      draft.rows.slice(0, 30).every((row) => row.source.semantic === null),
      true,
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
    const result = await first.importImages(source('image-1', 'image'));
    assert.ok(result);
    const report = result.report;
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

  test('picker cancellation is a no-op and creates no Lab Report', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const picker: LabSourcePicker = {
      pickPdf: async () => null,
      pickImages: async () => null,
    };
    const service = createService(repository, files, { picker });

    assert.equal(await service.importImages(), null);
    assert.deepEqual(await service.listReports(), []);
    assert.equal(files.files.size, 0);
  });

  test('picker one-image output creates exactly one discoverable Lab Report', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const picker: LabSourcePicker = {
      pickPdf: async () => null,
      pickImages: async () => source('picker-one', 'image'),
    };
    const service = createService(repository, files, { picker });

    const result = await service.importImages();
    assert.ok(result);
    assert.equal(result.duplicate, false);
    const reports = await service.listReports();
    assert.equal(reports.filter((report) => report.importState !== 'deleted').length, 1);
    assert.equal(reports[0]?.id, result.report.id);
  });

  test('rejects hostile multiple-image picker output before creating hidden reports', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const picker = {
      pickPdf: async () => null,
      pickImages: async () => [source('picker-first', 'image'), source('picker-second', 'image')],
    } as unknown as LabSourcePicker;
    const service = createService(repository, files, { picker });

    await assert.rejects(service.importImages(), (error: unknown) => {
      assert.ok(error instanceof LabReportSelectionError);
      assert.equal(error.reason, 'multiple-images');
      return true;
    });
    assert.deepEqual(await service.listReports(), []);
    assert.equal(
      [...files.files.keys()].some((path) => path.includes('/originals/')),
      false,
    );
    assert.equal(files.transient.size, 0);
  });

  test('cleans transient and promoted orphans when copying one image fails', async () => {
    const stagedRepository = createRepository();
    const stagedFiles = new FailingStageFiles();
    const stagedService = createService(stagedRepository, stagedFiles);
    await assert.rejects(
      stagedService.importImages(source('stage-failure', 'image')),
      (error: unknown) => {
        assert.ok(error instanceof LabReportImportError);
        assert.equal(error.reason, 'protection');
        return true;
      },
    );
    assert.equal(stagedFiles.transient.size, 0);
    assert.equal(
      (await stagedService.listReports()).filter((report) => report.importState !== 'deleted')
        .length,
      1,
    );

    const promotedRepository = createRepository();
    const promotedFiles = new FailingPromotionFiles();
    const promotedService = createService(promotedRepository, promotedFiles);
    await assert.rejects(
      promotedService.importImages(source('promotion-failure', 'image')),
      (error: unknown) => {
        assert.ok(error instanceof LabReportImportError);
        assert.equal(error.reason, 'protection');
        return true;
      },
    );
    assert.equal(
      [...promotedFiles.files.keys()].some((path) => path.includes('/originals/')),
      false,
    );
    assert.equal(promotedFiles.transient.size, 0);
    assert.equal(
      (await promotedService.listReports()).filter((report) => report.importState !== 'deleted')
        .length,
      1,
    );
  });

  test('retains a promoted source when cleanup fails so relaunch can still discover it', async () => {
    const repository = createRepository();
    const files = new RetainedPromotionCleanupFiles();
    const service = createService(repository, files);

    const failedReports: LabReportImportError['report'][] = [];
    await assert.rejects(
      service.importImages(source('retained-after-cleanup-failure', 'image')),
      (error: unknown) => {
        assert.ok(error instanceof LabReportImportError);
        failedReports.push(error.report);
        return true;
      },
    );
    const failedReport = failedReports[0];
    if (failedReport === undefined) throw new Error('Expected a failed import report');
    assert.equal(failedReport.originalPath !== null, true);
    assert.equal(failedReport.sourceHash !== null, true);
    assert.equal(
      (await service.listReports()).filter((report) => report.importState !== 'deleted').length,
      1,
    );
    assert.equal(files.transient.size, 0);

    const reopened = createService(repository, files);
    const retained = (await reopened.listReports())[0];
    assert.equal(retained?.originalPath, failedReport.originalPath);
    assert.equal(await reopened.verifySource(retained?.id ?? ''), 'verified');

    files.failOriginalRemoval = false;
    await reopened.deleteReport(retained?.id ?? '');
    await reopened.listReports();
    assert.equal(await files.exists(failedReport.originalPath!), false);
  });

  test('retries unreferenced Original cleanup after relaunch without hiding the failed row', async () => {
    const repository = createRepository();
    const files = new FlakyOriginalOrphanCleanupFiles();
    const orphanPath = 'protected://original-reports/orphan-report-orphan.jpg';
    files.files.set(orphanPath, { hash: 'hash-orphan', size: 42 });
    await repository.createReport({
      id: 'orphan-report',
      sourceType: 'image',
      originalFilename: 'orphan.jpg',
      mimeType: 'image/jpeg',
      importState: 'failed',
      failureReason: 'promotion-interrupted',
    });

    const firstLaunch = createService(repository, files);
    const failed = (await firstLaunch.listReports())[0];
    assert.equal(failed?.originalPath, null);
    assert.equal(await files.exists(orphanPath), true);

    const relaunched = createService(repository, files);
    const reports = await relaunched.listReports();
    assert.equal(reports.length, 1);
    assert.equal(reports[0]?.originalPath, null);
    assert.equal(await files.exists(orphanPath), false);
  });

  test('keeps one immutable source for duplicate hashes and cleans the transient copy', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files);
    const first = await service.importPdf(source('same'));
    const second = await service.importPdf(source('same'));
    assert.equal(first?.duplicate, false);
    assert.equal(second?.duplicate, true);
    assert.deepEqual(second?.destination, { kind: 'report-detail' });
    assert.equal(
      (await service.listReports()).filter((report) => report.importState !== 'deleted').length,
      1,
    );
    assert.equal(files.removed.filter((path) => path.includes('transient')).length, 2);
  });

  test('duplicate hashes carry an open draft destination without creating another source', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new FakePdf();
    const service = createService(repository, files, pdf);
    const first = (await service.importPdf(source('same-open-draft')))!;
    assert.equal(pdf.inspectCalls, 1);
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'duplicate-open-draft-row',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          pageIndex: 0,
          orientation: 0,
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      {
        locale: 'en-US',
        collectionDate: { kind: 'known', value: '2026-08-20' },
        specimenType: 'blood',
        aliases: createDefaultExtractionAliases(),
        artifact: { kind: 'original', id: null, hash: first.report.sourceHash },
      },
    );
    assert.equal(rows.length, 1);
    const draft = await repository.createExtractionDraft({
      reportId: first.report.id,
      collectionDate: { kind: 'known', value: '2026-08-20' },
      rows,
      sourceArtifact: { kind: 'original', id: null, hash: first.report.sourceHash },
    });
    assert.deepEqual(await service.listOpenExtractionDrafts(), [
      { reportId: first.report.id, draftId: draft.id },
    ]);

    const duplicate = await service.importPdf(source('same-open-draft'));
    assert.equal(duplicate?.duplicate, true);
    assert.deepEqual(duplicate?.destination, {
      kind: 'extraction-draft',
      draftId: draft.id,
    });
    assert.equal(pdf.inspectCalls, 1);
    assert.equal(
      (await service.listReports()).filter((report) => report.importState !== 'deleted').length,
      1,
    );
  });

  test('duplicate hashes select the open draft when a legacy report has confirmed and open drafts', async () => {
    const { database, repository } = createRepositoryWithDatabase();
    await repository.initialize();
    await allowMultipleExtractionDrafts(database);
    const files = new FakeFiles();
    const pdf = new FakePdf();
    const service = createService(repository, files, pdf);
    const first = (await service.importPdf(source('same-multiple-drafts')))!;
    const rows = groupObservationsIntoRows(
      [
        {
          id: 'multiple-drafts-row',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          pageIndex: 0,
          orientation: 0,
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
        },
      ],
      {
        locale: 'en-US',
        collectionDate: { kind: 'known', value: '2026-08-20' },
        specimenType: 'blood',
        aliases: createDefaultExtractionAliases(),
        artifact: { kind: 'original', id: null, hash: first.report.sourceHash },
      },
    );
    const confirmedDraft = await repository.createExtractionDraft({
      id: 'confirmed-legacy-draft',
      reportId: first.report.id,
      collectionDate: { kind: 'known', value: '2026-08-20' },
      rows,
      sourceArtifact: { kind: 'original', id: null, hash: first.report.sourceHash },
    });
    await database.runAsync(
      "UPDATE extraction_drafts SET state = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?;",
      '2026-08-21T10:00:00.000Z',
      '2026-08-21T10:00:00.000Z',
      confirmedDraft.id,
    );
    const openDraft = await repository.createExtractionDraft({
      id: 'open-new-draft',
      reportId: first.report.id,
      collectionDate: { kind: 'known', value: '2026-08-22' },
      rows,
      sourceArtifact: { kind: 'original', id: null, hash: first.report.sourceHash },
    });

    assert.equal((await repository.getExtractionDraftForReport(first.report.id))?.id, openDraft.id);
    const duplicate = await service.importPdf(source('same-multiple-drafts'));

    assert.equal(duplicate?.duplicate, true);
    assert.deepEqual(duplicate?.destination, {
      kind: 'extraction-draft',
      draftId: openDraft.id,
    });
    assert.equal(pdf.inspectCalls, 1);
    await repository.close();
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
    const image = (await service.importImages(source('preview-image', 'image')))!.report;
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

  test('opens a lazy PDF viewer session without eager page rasterization and closes it', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new ViewerPdf();
    pdf.viewerPageCount = 4096;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('lazy-viewer')))!.report;
    const inspectCallsBeforeViewer = pdf.inspectCalls;

    const viewer = await service.openOriginalViewer(imported.id);

    assert.deepEqual(
      { sourceType: viewer.sourceType, pageCount: viewer.pageCount, sessionId: viewer.sessionId },
      { sourceType: 'pdf', pageCount: 4096, sessionId: 'synthetic-pdf-session' },
    );
    assert.equal(pdf.viewerOpenCalls, 1);
    assert.equal(pdf.inspectCalls, inspectCallsBeforeViewer);
    assert.equal(pdf.previewCalls, 0);
    await viewer.close();
    assert.equal(pdf.viewerCloseCalls, 1);
  });

  test('uses an ephemeral password unlock for a protected PDF viewer', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new ViewerPdf();
    pdf.locked = true;
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(
      source('lazy-locked-viewer'),
      async () => 'correct horse',
    ))!.report;

    const viewer = await service.openOriginalViewer(imported.id, async () => 'correct horse');

    assert.equal(viewer.sessionId, 'synthetic-locked-pdf-session');
    assert.equal(pdf.viewerUnlockCalls, 1);
    await viewer.close();
    assert.equal(pdf.viewerCloseCalls, 1);
  });

  test('keeps an unreadable protected PDF separate from a wrong password', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new CorruptViewerPdf();
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('corrupt-locked-viewer')))!.report;
    pdf.locked = true;

    await assert.rejects(
      service.openOriginalViewer(imported.id, async () => 'correct horse'),
      (error: unknown) => !(error instanceof LabReportImportError),
    );
  });

  test('rejects a zero-page PDF viewer session and releases its capability', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new EmptyViewerPdf();
    const service = createService(repository, files, pdf);
    const imported = (await service.importPdf(source('empty-viewer')))!.report;

    await assert.rejects(
      service.openOriginalViewer(imported.id),
      (error: unknown) => error instanceof Error && error.message === 'The PDF has no pages',
    );
    assert.equal(pdf.viewerCloseCalls, 1);
  });

  test('opens and closes an image viewer capability without exposing its path', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const image = new ViewerImage(files);
    const service = createService(repository, files, { pdf: new FakePdf(), imageInspector: image });
    const imported = (await service.importImages(source('image-viewer', 'image')))!.report;

    const viewer = await service.openOriginalViewer(imported.id);

    assert.deepEqual(
      { sourceType: viewer.sourceType, pageCount: viewer.pageCount, sessionId: viewer.sessionId },
      { sourceType: 'image', pageCount: 1, sessionId: 'synthetic-image-session' },
    );
    assert.equal(image.viewerOpenCalls, 1);
    await viewer.close();
    assert.equal(image.viewerCloseCalls, 1);
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
    assert.deepEqual(pdf.inspectedPaths, [files.currentPath, files.currentPath]);
    assert.deepEqual(nativePaths, [files.currentPath, files.currentPath]);
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
    const service = createService(repository, files, { pdf: new FakePdf(), imageInspector: image });
    const imported = (await service.importImages(source('sanitize-image', 'image')))!.report;
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

  test('extracts an image from the protected Original and preserves page-zero provenance', async () => {
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
    const service = createService(repository, files, {
      pdf: new FakePdf(),
      visionOCR: ocr,
      imageInspector: image,
    });
    const imported = (await service.importImages(source('extract-image', 'image')))!.report;
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
    assert.deepEqual(visionPaths, [imported.originalPath]);
    assert.notEqual(visionPaths[0], saved.artifactPath);

    const records = await service.confirmExtraction(draft.id);
    const measurement = records[0]?.measurements[0];
    assert.deepEqual(measurement?.source?.observationIds, ['image-ldl']);
    assert.equal(measurement?.source?.pageIndex, 0);
    assert.deepEqual(measurement?.source?.boundingBox, draft.rows[0]?.source.boundingBox);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('does not call Vision when an Original image is missing or tampered', async () => {
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
            throw new Error('Vision must not receive an unavailable Original');
          },
        },
        undefined,
        image,
      );
      const imported = (await service.importImages(source(`extract-image-${state}`, 'image')))!
        .report;
      await service.saveSanitizedReport(
        imported.id,
        (await service.openSanitizationEditor(imported.id)).recipe,
      );
      if (state === 'missing') {
        files.files.delete(imported.originalPath!);
      } else {
        files.files.set(imported.originalPath!, { hash: 'tampered-image', size: 256 });
      }

      await assert.rejects(service.startExtraction(imported.id), (error: unknown) => {
        assert.ok(error instanceof LabReportExtractionError);
        assert.equal(error.reason, 'original-source');
        return true;
      });
      assert.equal(recognitionCalls, 0);
      assert.equal(
        (await repository.getSanitizedReport(imported.id))?.verificationState,
        'verified',
      );
    }
  });

  test('preserves Original extraction drafts across Sanitized Report replacement or deletion', async () => {
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
    const service = createService(repository, files, {
      pdf: new FakePdf(),
      visionOCR: ocr,
      imageInspector: image,
    });
    const imported = (await service.importImages(source('draft-invalidation', 'image')))!.report;
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
    assert.equal((await repository.getExtractionDraftForReport(imported.id))?.id, firstDraft.id);
    assert.equal((await repository.getExtractionDraft(firstDraft.id))?.id, firstDraft.id);
    assert.equal(await files.exists(first.artifactPath!), false);

    const replacementDraft = await service.startExtraction(imported.id);
    assert.equal(replacementDraft.id, firstDraft.id);
    await service.deleteSanitizedReport(imported.id);
    assert.equal((await repository.getExtractionDraftForReport(imported.id))?.id, firstDraft.id);
    assert.equal((await repository.getExtractionDraft(replacementDraft.id))?.id, firstDraft.id);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('readiness fails closed for a malformed persisted verification and extraction remains retryable', async () => {
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
    const imported = (await service.importImages(source('readiness-malformed', 'image')))!.report;
    const saved = await service.saveSanitizedReport(
      imported.id,
      (await service.openSanitizationEditor(imported.id)).recipe,
    );
    const draft = await service.startExtraction(imported.id);
    assert.equal(recognitionCalls, 1);
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
    assert.equal((await service.startExtraction(imported.id)).id, draft.id);
    assert.equal(recognitionCalls, 1, 'cached start performs no second OCR pass');
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

  test('runs the local journey from Original through ordered progress stages without sanitizing', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = sanitizingPdf(files);
    let calls = 0;
    const lifecycle: string[] = [];
    const ocr: VisionOCR = {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        calls += 1;
        lifecycle.push(`ocr-${pageIndex}`);
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: `progress-row-${pageIndex}`,
              text: `LDL-C ${pageIndex + 1}.2 mmol/L`,
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    };
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'progress.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      maxRowsPerChunk: 1,
      prepare: async () => {
        lifecycle.push('prepare');
        return {
          release: async () => {
            lifecycle.push('release');
          },
        };
      },
      supports: () => true,
      async map() {
        lifecycle.push('map');
        return [];
      },
    };
    const service = createService(repository, files, pdf, ocr, mapper);
    const report = (await service.importPdf(source('progress-order')))!.report;
    const events: LabReportExtractionProgress[] = [];
    const unsubscribe = service.subscribeExtractionProgress((event) => events.push(event));
    const draft = await service.startExtraction(report.id);
    unsubscribe();

    assert.equal(draft.sourceArtifact?.kind, 'original');
    assert.equal(draft.sourceArtifact?.id, null);
    assert.equal(draft.sourceArtifact?.hash, report.sourceHash);
    assert.equal(calls, 2);
    assert.deepEqual(lifecycle, ['ocr-0', 'ocr-1', 'prepare', 'map', 'map', 'release']);
    assert.equal(pdf.sanitizedPaths.length, 0);
    assert.deepEqual(
      events.map((event) => event.stage).filter((stage, index, all) => stage !== all[index - 1]),
      ['import', 'ocr', 'model', 'review'],
    );
    assert.equal(
      events.some((event) => event.stage === 'ocr' && event.status === 'complete'),
      true,
    );
    assert.equal(
      events.some((event) => event.stage === 'model' && event.status === 'complete'),
      true,
    );
    assert.equal(events.at(-1)?.status, 'complete');
  });

  test('does not report completion when the final semantic lease release fails', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: `release-failure-row-${pageIndex}`,
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    };
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'release-failure.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      prepare: async () => ({
        release: async () => {
          throw new Error('synthetic release failure');
        },
      }),
      map: async () => [],
    };
    const service = createService(repository, files, new FakePdf(), ocr, mapper);
    const report = (await service.importPdf(source('release-failure')))!.report;

    await assert.rejects(
      service.startExtraction(report.id),
      (error: unknown) =>
        error instanceof LabReportExtractionError && error.reason === 'recognition',
    );
    assert.equal(await repository.countOpenExtractionDrafts(), 0);
  });

  test('progress subscribers are isolated and completion is available after relaunch', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, new FakePdf(), {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: 'durable-progress-row',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    });
    const report = (await service.importPdf(source('durable-progress')))!.report;
    const unsubscribe = service.subscribeExtractionProgress(() => {
      throw new Error('screen observer failed');
    });
    await assert.doesNotReject(service.startExtraction(report.id));
    unsubscribe();
    const progress = await service.loadExtractionProgress(report.id);
    assert.equal(progress?.status, 'complete');
    assert.equal((await repository.getExtractionOperation(report.id))?.state, 'complete');
  });

  test('preserves the imported report across extraction retry and does not create duplicate drafts', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let calls = 0;
    const service = createService(repository, files, new FakePdf(), {
      async recognize(): Promise<VisionOCRResult> {
        calls += 1;
        if (calls === 1) throw new Error('temporary Vision failure');
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'retry-row',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    });
    const report = (await service.importPdf(source('retry-progress')))!.report;
    await assert.rejects(service.startExtraction(report.id), /recognition failed/);
    assert.equal((await service.getReport(report.id))?.originalPath, report.originalPath);
    assert.equal(await repository.getExtractionDraftForReport(report.id), null);

    const first = await service.startExtraction(report.id);
    const second = await service.startExtraction(report.id);
    assert.equal(second.id, first.id);
    assert.equal(await service.countOpenExtractionDrafts(), 1);
    assert.equal(calls, 3);
  });

  test('classifies draft persistence failure and retries without losing the Original Report', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const createDraft = repository.createExtractionDraft;
    let failPersistence = true;
    repository.createExtractionDraft = async (input) => {
      if (failPersistence) {
        failPersistence = false;
        throw new Error('synthetic draft persistence failure');
      }
      return createDraft(input);
    };
    let calls = 0;
    const service = createService(repository, files, new FakePdf(), {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        calls += 1;
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: 'persistence-recovery-row',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    });
    const report = (await service.importImages(source('persistence-recovery', 'image')))!.report;

    await assert.rejects(
      service.startExtraction(report.id),
      (error: unknown) =>
        error instanceof LabReportExtractionError &&
        error.reason === 'persistence' &&
        error.message === 'The local extraction draft could not be saved',
    );
    const failedOperation = await repository.getExtractionOperation(report.id);
    assert.equal(failedOperation?.reportId, report.id);
    assert.equal(failedOperation?.state, 'failed');
    assert.equal(failedOperation?.stage, 'review');
    assert.equal(failedOperation?.completed, 0);
    assert.equal(failedOperation?.total, 1);
    assert.equal(failedOperation?.error, 'persistence');
    assert.equal(await repository.getExtractionDraftForReport(report.id), null);
    assert.equal((await service.getReport(report.id))?.originalPath, report.originalPath);

    const draft = await service.startExtraction(report.id);
    assert.equal(draft.sourceArtifact?.kind, 'original');
    assert.equal(await repository.countOpenExtractionDrafts(), 1);
    assert.equal((await repository.getExtractionDraftForReport(report.id))?.id, draft.id);
    assert.equal(calls, 2);
  });

  test('unlocks a protected Original only for Vision and never persists the password', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new FakePdf();
    pdf.locked = true;
    const visionPasswords: Array<string | null | undefined> = [];
    const service = createService(repository, files, pdf, {
      async recognize(_path, pageIndex, _orientation, password): Promise<VisionOCRResult> {
        visionPasswords.push(password);
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: `protected-row-${pageIndex}`,
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    });
    const report = (await service.importPdf(
      source('protected-extraction'),
      async () => 'correct horse',
    ))!.report;
    const draft = await service.startExtraction(report.id, async () => 'correct horse');

    assert.equal(report.encrypted, true);
    assert.equal(
      visionPasswords.every((password) => password === 'correct horse'),
      true,
    );
    assert.equal(JSON.stringify(draft).includes('correct horse'), false);
    assert.equal(
      JSON.stringify(await repository.getExtractionDraft(draft.id)).includes('correct horse'),
      false,
    );
  });

  test('rejects confirmation after Original tampering while preserving the editable draft', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, new FakePdf(), {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'tamper-after-draft',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    });
    const report = (await service.importPdf(source('tamper-after-draft')))!.report;
    const draft = await service.startExtraction(report.id);
    files.files.set(report.originalPath!, { hash: 'tampered-after-draft', size: 42 });

    await assert.rejects(service.confirmExtraction(draft.id), /integrity could not be verified/);
    assert.equal((await repository.getExtractionDraft(draft.id))?.state, 'draft');
    assert.equal((await service.getReport(report.id))?.importState, 'imported');
  });

  test('cancelling during OCR cannot write a draft and an immediate retry stays unique', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new FakePdf();
    let service!: LabReportsService;
    let calls = 0;
    let resolveFirstRecognition!: (result: VisionOCRResult) => void;
    let signalRecognitionStarted!: () => void;
    const recognitionStarted = new Promise<void>((resolve) => {
      signalRecognitionStarted = resolve;
    });
    const firstRecognition = new Promise<VisionOCRResult>((resolve) => {
      resolveFirstRecognition = resolve;
    });
    const result = (pageIndex: number): VisionOCRResult =>
      decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v2',
        pageIndex,
        orientation: 0,
        observations: [
          {
            id: 'cancel-ocr-row',
            text: 'LDL-C 3.8 mmol/L',
            alternatives: [],
            boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
            pageIndex,
            orientation: 0,
            recognition: { level: 'accurate', language: 'en', internalConfidence: null },
          },
        ],
      });
    service = createService(repository, files, pdf, {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        calls += 1;
        if (calls === 1) {
          signalRecognitionStarted();
          return firstRecognition;
        }
        return result(pageIndex);
      },
    });
    const report = (await service.importPdf(source('cancel-during-ocr')))!.report;
    const first = service.startExtraction(report.id);
    await recognitionStarted;
    await service.cancelExtraction(report.id);
    const retry = service.startExtraction(report.id);
    resolveFirstRecognition(result(0));

    await assert.rejects(first, (error: unknown) => {
      return error instanceof LabReportExtractionError && error.reason === 'cancelled';
    });
    const draft = await retry;
    assert.equal(draft.sourceArtifact?.kind, 'original');
    assert.equal(await repository.countOpenExtractionDrafts(), 1);
    assert.equal((await service.getReport(report.id))?.originalPath, report.originalPath);
    assert.equal(calls, 3);
  });

  test('cancelling after an on-device model await preserves deterministic rows and allows retry', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let service!: LabReportsService;
    let mapCalls = 0;
    let releaseCalls = 0;
    let resolveFirstMap!: (proposals: readonly []) => void;
    let signalMapStarted!: () => void;
    const mapStarted = new Promise<void>((resolve) => {
      signalMapStarted = resolve;
    });
    const firstMap = new Promise<readonly []>((resolve) => {
      resolveFirstMap = resolve;
    });
    const vision: VisionOCR = {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: 'cancel-model-row',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    };
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'cancel.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      maxRowsPerChunk: 12,
      maxObservationsPerChunk: 48,
      provenance: {},
      prepare: async () => ({
        release: async () => {
          releaseCalls += 1;
        },
      }),
      supports: () => true,
      map: async () => {
        mapCalls += 1;
        if (mapCalls === 1) {
          signalMapStarted();
          return firstMap;
        }
        return [];
      },
    };
    service = createService(repository, files, new FakePdf(), vision, mapper);
    const report = (await service.importPdf(source('cancel-during-model')))!.report;
    const first = service.startExtraction(report.id);
    await mapStarted;
    await service.cancelExtraction(report.id);
    const retry = service.startExtraction(report.id);
    resolveFirstMap([]);

    await assert.rejects(first, (error: unknown) => {
      return error instanceof LabReportExtractionError && error.reason === 'cancelled';
    });
    const draft = await retry;
    assert.equal(draft.rows.length, 1);
    assert.equal(await repository.countOpenExtractionDrafts(), 1);
    assert.equal(mapCalls, 2);
    assert.equal(releaseCalls, 2);
  });

  test('cancelling at the review write boundary creates no draft and retry can complete', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let service!: LabReportsService;
    let cancelOnce = true;
    const vision: VisionOCR = {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v2',
          pageIndex,
          orientation: 0,
          observations: [
            {
              id: 'cancel-review-row',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
              pageIndex,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        });
      },
    };
    service = createService(repository, files, new FakePdf(), vision);
    const report = (await service.importPdf(source('cancel-before-write')))!.report;
    const unsubscribe = service.subscribeExtractionProgress((progress) => {
      if (cancelOnce && progress.reportId === report.id && progress.stage === 'review') {
        cancelOnce = false;
        void service.cancelExtraction(report.id);
      }
    });
    await assert.rejects(service.startExtraction(report.id), (error: unknown) => {
      return error instanceof LabReportExtractionError && error.reason === 'cancelled';
    });
    unsubscribe();
    assert.equal(await repository.getExtractionDraftForReport(report.id), null);
    const draft = await service.startExtraction(report.id);
    assert.equal(draft.sourceArtifact?.kind, 'original');
    assert.equal(await repository.countOpenExtractionDrafts(), 1);
  });

  test('invalidates only a draft tied to a failing Sanitized artifact', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const image = new SanitizingImage(files);
    const service = createService(repository, files, { pdf: new FakePdf(), imageInspector: image });
    const report = (await service.importImages(source('sanitized-draft', 'image')))!.report;
    const sanitized = await service.saveSanitizedReport(
      report.id,
      (await service.openSanitizationEditor(report.id)).recipe,
    );
    const originalRows = groupObservationsIntoRows(
      [
        {
          id: 'sanitized-source-row',
          text: 'LDL-C 3.8 mmol/L',
          alternatives: [],
          boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
          pageIndex: 0,
          orientation: 0,
          recognition: { level: 'accurate', language: 'en', internalConfidence: null },
        },
      ],
      {
        aliases: createDefaultExtractionAliases(),
        artifact: { kind: 'sanitized', id: sanitized.id, hash: sanitized.artifactHash },
      },
    );
    const draft = await repository.createExtractionDraft({
      reportId: report.id,
      collectionDate: { kind: 'missing' },
      rows: originalRows,
      sourceArtifact: { kind: 'sanitized', id: sanitized.id, hash: sanitized.artifactHash },
    });
    await assert.rejects(
      service.confirmExtraction(draft.id),
      /Original Report integrity could not be verified/,
    );

    await repository.updateSanitizedReport(sanitized.id, {
      verificationState: 'failed',
      failureReason: 'tampered',
    });
    assert.equal(await repository.getExtractionDraft(draft.id), null);
  });
});

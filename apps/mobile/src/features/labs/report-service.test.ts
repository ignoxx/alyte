import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type {
  ExtractionDraftRow,
  ExtractionSemanticMapper,
  GeometryCandidateWindowGroup,
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
  createExtractionPipelineFingerprint,
  decodeVisionOCRResult,
  EXTRACTION_PARSER_VERSION,
  EXTRACTION_ROW_SEGMENTATION_VERSION,
  VISION_OCR_CONTRACT_VERSION,
  extractionReviewRequiresAttention,
  groupObservationsIntoRows,
  normalizeUnit,
  parseLabDate,
  revalidateExtractionRow,
} from '@alyte/domain';
import { CATALOGUE_VERSION } from '@alyte/catalogue';
import type { DocumentVLMExtractor } from '../local-models/document-vlm';
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
  retainRowsOutsidePromotedPhysicalGroups,
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

test('promoting one physical row does not remove a distinct row sharing an adjacent label', () => {
  type SharedPhysicalRow = {
    readonly id: string;
    readonly source: {
      readonly observationIds: readonly string[];
      readonly semantic?: {
        readonly sourceFieldObservationIds?: { readonly value?: string };
      };
    };
    readonly reviewState: 'needs-review' | 'ready';
    readonly decision: 'preserve' | 'resolve';
  };
  const sharedLabel = { id: 'shared-label' };
  const first: SharedPhysicalRow = {
    id: 'first-row',
    source: { observationIds: [sharedLabel.id, 'first-value'] },
    reviewState: 'needs-review' as const,
    decision: 'preserve' as const,
  };
  const second: SharedPhysicalRow = {
    id: 'second-row',
    source: { observationIds: [sharedLabel.id, 'second-value'] },
    reviewState: 'needs-review' as const,
    decision: 'preserve' as const,
  };
  const promoted = {
    ...first,
    source: {
      observationIds: [sharedLabel.id, 'first-value', 'first-unit'],
      semantic: { sourceFieldObservationIds: { value: 'first-value' } },
    },
    reviewState: 'ready' as const,
    decision: 'resolve' as const,
  };

  const retained = retainRowsOutsidePromotedPhysicalGroups([first, second], [promoted]);

  assert.deepEqual(
    retained.map((row) => row.id),
    ['second-row'],
  );
  assert.equal(retained[0]?.reviewState, 'needs-review');
  assert.equal(retained[0]?.decision, 'preserve');
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

class TextLayerPdf extends FakePdf {
  readonly textLayerCalls: number[] = [];
  readonly textLayerResults = new Map<number, VisionOCRResult | null>();
  readonly inspectionPages: PdfInspection['pages'];
  textLayerError: Error | null = null;
  onTextLayerRead: ((pageIndex: number) => void) | null = null;

  constructor(pages: PdfInspection['pages'] = pdfInspection.pages) {
    super();
    this.inspectionPages = pages;
  }

  override async inspect(path: string): Promise<PdfInspection> {
    const inspected = await super.inspect(path);
    if (this.locked) return inspected;
    return {
      ...inspected,
      pageCount: this.inspectionPages.length,
      pages: this.inspectionPages,
    };
  }

  async readTextLayerPage(_path: string, pageIndex: number): Promise<VisionOCRResult | null> {
    this.textLayerCalls.push(pageIndex);
    this.onTextLayerRead?.(pageIndex);
    if (this.textLayerError !== null) throw this.textLayerError;
    return this.textLayerResults.get(pageIndex) ?? null;
  }
}

class BandTextLayerPdf extends TextLayerPdf {
  readonly renderedRects: Array<{
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  }> = [];
  readonly deletedBandURIs: string[] = [];
  onRender: ((path: string, uri: string) => void) | null = null;

  async renderExtractionBand(
    path: string,
    _pageIndex: number,
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
  ): Promise<{ readonly uri: string; readonly width: number; readonly height: number }> {
    this.renderedRects.push(rect);
    const uri = `file:///synthetic-band-${this.renderedRects.length}.jpg`;
    this.onRender?.(path, uri);
    return { uri, width: 1200, height: 900 };
  }

  async deleteExtractionBand(uri: string): Promise<void> {
    this.deletedBandURIs.push(uri);
  }
}

type SyntheticPdfSessionState = {
  readonly reads: number[];
  closed: boolean;
  readWhileClosed: boolean;
  closeCalls: number;
};

class LockedTextLayerPdf extends TextLayerPdf {
  override locked = true;
  readonly sessions: SyntheticPdfSessionState[] = [];
  sessionTextLayerError: Error | null = null;

  override async unlock(_path: string, password: string): Promise<PdfInspectionSession> {
    await super.unlock(_path, password);
    const state: SyntheticPdfSessionState = {
      reads: [],
      closed: false,
      readWhileClosed: false,
      closeCalls: 0,
    };
    this.sessions.push(state);
    return {
      inspection: {
        ...pdfInspection,
        encrypted: true,
        pageCount: this.inspectionPages.length,
        pages: this.inspectionPages,
      },
      renderPreview: async () => [],
      exportUnlocked: async () => {},
      readTextLayerPage: async (pageIndex) => {
        if (state.closed) state.readWhileClosed = true;
        state.reads.push(pageIndex);
        if (this.sessionTextLayerError !== null) throw this.sessionTextLayerError;
        return this.textLayerResults.get(pageIndex) ?? null;
      },
      close: async () => {
        state.closeCalls += 1;
        state.closed = true;
      },
    };
  }
}

class SessionOnlyTextLayerPdf extends FakePdf {
  override locked = true;
  readonly textLayerAdapterVersion = 'alyte.pdf.text-layer.v3' as const;
  readonly result = syntheticExtractionResult(0, 'session-only-result', 'LDL-C 3.8 mmol/L');

  override async unlock(_path: string, password: string): Promise<PdfInspectionSession> {
    if (password !== 'correct horse') throw new Error('Wrong password');
    return {
      inspection: {
        encrypted: true,
        locked: false,
        pageCount: 1,
        metadata: {},
        pages: [{ pageIndex: 0, width: 612, height: 792, hasTextLayer: true }],
      },
      renderPreview: async () => [],
      readTextLayerPage: async () => this.result,
      exportUnlocked: async () => {},
      close: async () => {},
    };
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

function v3TableObservation(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
): {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly pageIndex: number;
  readonly orientation: number;
  readonly boundingBox: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly structure: {
    readonly kind: 'table-cell';
    readonly tableId: string;
    readonly rowIndex: number;
    readonly columnIndex: number;
  };
  readonly recognition: {
    readonly level: 'accurate';
    readonly language: string;
    readonly internalConfidence: null;
  };
} {
  return {
    id,
    text,
    alternatives: [],
    pageIndex: 0,
    orientation: 0,
    boundingBox: {
      x: 0.08 + columnIndex * 0.2,
      y: 0.08 + rowIndex * 0.08,
      width: 0.16,
      height: 0.03,
    },
    structure: {
      kind: 'table-cell',
      tableId: 'semantic-eligibility',
      rowIndex,
      columnIndex,
    },
    recognition: { level: 'accurate', language: 'en', internalConfidence: null },
  };
}

function v3TableObservationAtY(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
  y: number,
): ReturnType<typeof v3TableObservation> {
  const observation = v3TableObservation(id, text, rowIndex, columnIndex);
  return { ...observation, boundingBox: { ...observation.boundingBox, y } };
}

function compactSemanticProposal(
  row: { readonly observations: readonly VisionOCRResult['observations'][number][] },
  options: {
    readonly role?: 'measurement' | 'preserve';
    readonly biomarkerId?: string | null;
    readonly specimenType?: 'serum' | 'urine';
    readonly valueId?: string;
  } = {},
) {
  const cellKey = (id: string | null): string | null => {
    if (id === null) return null;
    const index = row.observations.findIndex((observation) => observation.id === id);
    return index < 0 ? null : `c${index}`;
  };
  const label = row.observations.find((observation) => /[a-z]/iu.test(observation.text));
  const value =
    options.valueId === undefined
      ? row.observations.find((observation) => /^[<>≤≥+-]?\s*\d/u.test(observation.text))
      : row.observations.find((observation) => observation.id === options.valueId);
  const unit = row.observations.find((observation) =>
    /\/(?:dL|L|mL)|^(?:mg|mmol|ng)/iu.test(observation.text),
  );
  return {
    rowKey: 'r0',
    labelKey: cellKey(label?.id ?? null),
    valueKey: cellKey(value?.id ?? null),
    unitKey: cellKey(unit?.id ?? null),
    referenceIntervalKey: null,
    flagKey: null,
    role: options.role ?? 'measurement',
    biomarkerId: options.biomarkerId === undefined ? 'biomarker.ldl_c' : options.biomarkerId,
    specimenType: options.specimenType,
  };
}

type CreateServiceOverrides = {
  readonly pdf?: PdfInspector;
  readonly visionOCR?: VisionOCR;
  readonly semanticMapper?: ExtractionSemanticMapper;
  readonly documentVLM?: DocumentVLMExtractor;
  readonly imageInspector?: LabReportsServiceOptions['imageInspector'];
  readonly picker?: LabSourcePicker;
};

function isCreateServiceOverrides(value: unknown): value is CreateServiceOverrides {
  if (value === null || typeof value !== 'object') return false;
  return ['pdf', 'visionOCR', 'semanticMapper', 'documentVLM', 'imageInspector', 'picker'].some(
    (key) => Object.prototype.hasOwnProperty.call(value, key),
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
  const positionalOverrides: CreateServiceOverrides = {
    ...(visionOCR === undefined ? {} : { visionOCR }),
    ...(semanticMapper === undefined ? {} : { semanticMapper }),
    ...(imageInspector === undefined ? {} : { imageInspector }),
    ...(picker === undefined ? {} : { picker }),
  };
  const overrides: CreateServiceOverrides =
    pdfOrOverrides === undefined
      ? positionalOverrides
      : isCreateServiceOverrides(pdfOrOverrides)
        ? pdfOrOverrides
        : { pdf: pdfOrOverrides, ...positionalOverrides };
  return createLabReportsService({
    repositoryFactory: async () => repository,
    fileService: files,
    pdfInspector: overrides.pdf ?? new FakePdf(),
    ...(overrides.visionOCR === undefined ? {} : { visionOCR: overrides.visionOCR }),
    ...(overrides.semanticMapper === undefined ? {} : { semanticMapper: overrides.semanticMapper }),
    ...(overrides.documentVLM === undefined ? {} : { documentVLM: overrides.documentVLM }),
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

function syntheticDateObservation(
  id: string,
  text: string,
  x: number,
  y = 0.1,
  language: string | null = 'de',
): VisionOCRResult['observations'][number] {
  return {
    id,
    text,
    alternatives: [],
    boundingBox: { x, y, width: 0.2, height: 0.04 },
    pageIndex: 0,
    orientation: 0,
    recognition: { level: 'accurate', language, internalConfidence: null },
  };
}

function syntheticExtractionResult(
  pageIndex: number,
  id: string,
  text: string,
  language: string | null = 'en',
): VisionOCRResult {
  return decodeVisionOCRResult({
    contractVersion: 'alyte.vision.document.v2',
    pageIndex,
    orientation: 0,
    observations: [
      {
        id,
        text,
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
        pageIndex,
        orientation: 0,
        recognition: { level: 'accurate', language, internalConfidence: null },
      },
    ],
  });
}

function syntheticTrustedTextLayerResult(pageIndex: number): VisionOCRResult {
  const parentID = 'trusted-pdf-parent';
  const parentText = 'Serum LDL-C 3.8 mmol/L';
  return decodeVisionOCRResult({
    contractVersion: 'alyte.vision.document.v4',
    pageIndex,
    orientation: 0,
    observations: [
      {
        id: 'trusted-pdf-collection-date',
        text: 'Collection date 22.08.2026',
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.05, width: 0.45, height: 0.04 },
        pageIndex,
        orientation: 0,
        recognition: { level: 'accurate', language: 'de', internalConfidence: null },
      },
      {
        id: parentID,
        text: parentText,
        alternatives: [],
        boundingBox: { x: 0.1, y: 0.2, width: 0.7, height: 0.04 },
        pageIndex,
        orientation: 0,
        structure: { kind: 'text', tableId: null, rowIndex: null, columnIndex: null },
        spans: [
          {
            id: `${parentID}-serum`,
            parentObservationId: parentID,
            start: 0,
            end: 5,
            text: 'Serum',
            boundingBox: { x: 0.1, y: 0.2, width: 0.08, height: 0.04 },
          },
          {
            id: `${parentID}-label`,
            parentObservationId: parentID,
            start: 6,
            end: 11,
            text: 'LDL-C',
            boundingBox: { x: 0.22, y: 0.2, width: 0.1, height: 0.04 },
          },
          {
            id: `${parentID}-value`,
            parentObservationId: parentID,
            start: 12,
            end: 15,
            text: '3.8',
            boundingBox: { x: 0.48, y: 0.2, width: 0.06, height: 0.04 },
          },
          {
            id: `${parentID}-unit`,
            parentObservationId: parentID,
            start: 16,
            end: 22,
            text: 'mmol/L',
            boundingBox: { x: 0.6, y: 0.2, width: 0.15, height: 0.04 },
          },
        ],
        recognition: { level: 'accurate', language: 'de', internalConfidence: null },
      },
    ],
  });
}

function syntheticResultColumnPage(
  pageIndex: number,
  includeUnrepresentedRow = false,
  includeAmbiguousCandidateRow = false,
): VisionOCRResult {
  const cell = (id: string, text: string, x: number, y: number) => ({
    id,
    text,
    alternatives: [],
    boundingBox: { x, y, width: 0.08, height: 0.025 },
    pageIndex,
    orientation: 0,
    structure: { kind: 'text' as const, tableId: null, rowIndex: null, columnIndex: null },
    recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
  });
  return decodeVisionOCRResult({
    contractVersion: 'alyte.vision.document.v4',
    pageIndex,
    orientation: 0,
    observations: [
      cell('column-header-label', 'Test', 0.08, 0.1),
      cell('column-header-result', 'Result', 0.48, 0.1),
      cell('column-header-reference', 'Reference', 0.74, 0.1),
      cell('column-a-label', 'LDL-C', 0.08, 0.16),
      cell('column-a-result', '3.8', 0.48, 0.16),
      cell('column-a-unit', 'mmol/L', 0.6, 0.16),
      cell('column-a-reference', '2.0', 0.74, 0.16),
      cell('column-b-label', 'HDL-C', 0.08, 0.22),
      cell('column-b-result', '1.2', 0.48, 0.22),
      cell('column-b-unit', 'mmol/L', 0.6, 0.22),
      cell('column-b-reference', '0.9', 0.74, 0.22),
      ...(includeUnrepresentedRow
        ? [
            cell('column-unrepresented-metadata', 'Patient', 0.08, 0.28),
            cell('column-unrepresented-result', '3.3', 0.48, 0.28),
          ]
        : []),
      ...(includeAmbiguousCandidateRow
        ? [
            cell('column-ambiguous-label-a', 'Novel alpha', 0.05, 0.34),
            cell('column-ambiguous-label-b', 'Novel beta', 0.15, 0.34),
            cell('column-ambiguous-label-c', 'Novel gamma', 0.25, 0.34),
            cell('column-ambiguous-label-d', 'Novel delta', 0.35, 0.34),
            cell('column-ambiguous-result', '6.4', 0.48, 0.34),
          ]
        : []),
    ],
  });
}

function syntheticDenseTrustedResultColumnPage(pageIndex: number): VisionOCRResult {
  const line = (id: string, cells: readonly string[], y: number) => {
    let text = '';
    const spans = cells.map((cellText, index) => {
      if (index > 0) text += ' ';
      const start = text.length;
      text += cellText;
      const x = [0.08, 0.48, 0.6, 0.74][index]!;
      return {
        id: `${id}-span-${index}`,
        parentObservationId: id,
        start,
        end: text.length,
        text: cellText,
        boundingBox: { x, y, width: 0.08, height: 0.025 },
      };
    });
    return {
      id,
      text,
      alternatives: [],
      boundingBox: { x: 0.08, y, width: 0.74, height: 0.025 },
      pageIndex,
      orientation: 0,
      structure: { kind: 'text' as const, tableId: null, rowIndex: null, columnIndex: null },
      spans,
      recognition: { level: 'accurate' as const, language: 'en', internalConfidence: null },
    };
  };
  return decodeVisionOCRResult({
    contractVersion: 'alyte.vision.document.v4',
    pageIndex,
    orientation: 0,
    observations: [
      line('dense-column-header', ['Test', 'Result', 'Unit', 'Reference'], 0.1),
      line('dense-column-a', ['LDL-C', '3.8', 'mmol/L', '2.0'], 0.16),
      line('dense-column-b', ['HDL-C', '1.2', 'mmol/L', '0.9'], 0.193),
    ],
  });
}

function syntheticTableDateObservation(
  id: string,
  text: string,
  x: number,
  y: number,
  tableId: string,
  rowIndex: number,
  columnIndex = 0,
): VisionOCRResult['observations'][number] {
  return {
    ...syntheticDateObservation(id, text, x, y),
    structure: { kind: 'table-cell', tableId, rowIndex, columnIndex },
  };
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

  test('confirms an explicit full-form correction when its unchanged value is diff-compacted', async () => {
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
              id: 'multi-anchor-row',
              text: 'LDL cholesterol 100 118 mg/dL',
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
    const report = (await service.importPdf(source('multi-anchor-correction')))!.report;
    const draft = await service.startExtraction(report.id);
    const before = draft.rows[0]!;
    assert.ok(before.reviewReasons.includes('unsupported-layout'));
    assert.equal(before.decision, 'skip');

    const unitOnly = await service.updateExtractionRow(before.id, {
      proposedUnit: 'mg/dL',
    });
    assert.ok(unitOnly.reviewReasons.includes('unsupported-layout'));
    assert.equal(unitOnly.reviewState, 'needs-review');
    assert.equal(unitOnly.decision, 'skip');

    const corrected = await service.updateExtractionRow(
      unitOnly.id,
      { proposedLabel: 'LDL-C' },
      { submission: 'correction-form' },
    );
    assert.equal(corrected.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(corrected.proposedValue, before.proposedValue);
    assert.equal(corrected.reviewReasons.includes('unsupported-layout'), false);
    assert.equal(corrected.reviewReasons.includes('unparseable-value'), false);
    assert.equal(corrected.reviewState, 'ready');
    assert.equal(corrected.editState, 'user-edited');
    assert.deepEqual(corrected.source, before.source);
    assert.equal(corrected.source.semantic, null);
    assert.equal(corrected.sourceText, before.sourceText);
    assert.equal(corrected.sourceValueString, before.sourceValueString);

    const records = await service.confirmExtraction(draft.id);
    const measurement = records[0]!.measurements[0]!;
    assert.equal(measurement.original.label, before.sourceLabel);
    assert.equal(measurement.original.valueString, before.sourceValueString);
    assert.equal(measurement.current.label, 'LDL-C');
    assert.deepEqual(measurement.current.value, before.proposedValue);
    assert.equal(measurement.provenance, 'user-corrected');
    assert.equal(measurement.source?.semantic, null);
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
      supports: () => true,
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
          contractVersion: 'alyte.vision.document.v4',
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
            contractVersion: 'alyte.vision.document.v4',
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

  test('offers a clear unsupported v3 row while excluding a complete known row', async () => {
    const observations = [
      v3TableObservation('unknown-label', 'Unmapped assay', 0, 0),
      v3TableObservation('unknown-value', '4.2', 0, 1),
      v3TableObservation('unknown-unit', 'mg/L', 0, 2),
      v3TableObservation('unknown-reference', '3-5', 0, 3),
      v3TableObservation('known-label', 'LDL-C', 1, 0),
      v3TableObservation('known-value', '3.8', 1, 1),
      v3TableObservation('known-unit', 'mmol/L', 1, 2),
      v3TableObservation('known-reference', '2.0-4.0', 1, 3),
    ];
    const mappedSourceIds: string[][] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-eligibility.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      maxRowsPerChunk: 2,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        mappedSourceIds.push(...rows.map((row) => [...row.sourceObservationIds]));
        return rows.map((row) => ({
          sourceObservationIds: row.sourceObservationIds,
          proposedBiomarkerId: null,
          role: 'preserve' as const,
        }));
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const imported = await service.importImages(source('v3-semantic-eligibility', 'image'));
    assert.ok(imported);
    const report = imported.report;
    const draft = await service.startExtraction(report.id);
    const unknown = draft.rows.find((row) => row.source.observationIds.includes('unknown-label'));
    const known = draft.rows.find((row) => row.source.observationIds.includes('known-label'));

    assert.deepEqual(mappedSourceIds, [
      ['unknown-label', 'unknown-value', 'unknown-unit', 'unknown-reference'],
    ]);
    assert.ok(unknown);
    assert.ok(known);
    assert.equal(unknown.proposedBiomarkerId, null);
    assert.ok(unknown.reviewReasons.includes('unsupported-alias'));
    assert.equal(unknown.source.semantic?.adapterVersion, mapper.adapterVersion);
    assert.equal(known.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(known.reviewReasons, ['defaulted-collection-date']);
    assert.equal(known.source.semantic, null);
  });

  test('preserves a clear unsupported v3 row when semantic output is malformed', async () => {
    const observations = [
      v3TableObservation('malformed-label', 'Unmapped assay', 0, 0),
      v3TableObservation('malformed-value', '4.2', 0, 1),
      v3TableObservation('malformed-unit', 'mg/L', 0, 2),
      v3TableObservation('malformed-reference', '3-5', 0, 3),
    ];
    let mapperCalls = 0;
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-malformed.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map() {
        mapperCalls += 1;
        return '{"schemaVersion":"alyte.semantic-mapper.v1","proposals":[';
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const imported = await service.importImages(source('v3-malformed-semantic', 'image'));
    assert.ok(imported);
    const report = imported.report;
    const draft = await service.startExtraction(report.id);
    const row = draft.rows[0];

    assert.equal(mapperCalls, 1);
    assert.ok(row);
    assert.equal(row.source.semantic, null);
    assert.equal(row.proposedBiomarkerId, null);
    assert.deepEqual(row.proposedValue, { kind: 'numeric', value: 4.2 });
    assert.equal(row.proposedUnit, 'mg/L');
    assert.ok(row.reviewReasons.includes('unsupported-alias'));
  });

  test('preserves a clear unsupported v3 row when no semantic mapper is available', async () => {
    const observations = [
      v3TableObservation('without-mapper-label', 'Unmapped assay', 0, 0),
      v3TableObservation('without-mapper-value', '4.2', 0, 1),
      v3TableObservation('without-mapper-unit', 'mg/L', 0, 2),
      v3TableObservation('without-mapper-reference', '3-5', 0, 3),
    ];
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, new FakePdf(), {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v4',
          pageIndex: 0,
          orientation: 0,
          observations,
        });
      },
    });
    const imported = await service.importImages(source('v3-no-semantic-mapper', 'image'));
    assert.ok(imported);
    const report = imported.report;
    const draft = await service.startExtraction(report.id);
    const row = draft.rows[0];

    assert.ok(row);
    assert.equal(row.source.semantic, null);
    assert.equal(row.proposedBiomarkerId, null);
    assert.equal(row.source.raw?.label, 'Unmapped assay');
    assert.equal(row.source.raw?.value, '4.2');
    assert.equal(row.source.raw?.unit, 'mg/L');
    assert.ok(row.reviewReasons.includes('unsupported-alias'));
  });

  test('promotes an accepted source-selector window with exact provenance', async () => {
    const observations = [
      syntheticDateObservation('window-collection-date', 'Collection date 2026-08-20', 0.08, 0.01),
      v3TableObservation('window-serum-heading', 'Serum', 0, 0),
      v3TableObservation('window-label', 'LDL-C', 1, 0),
      {
        ...v3TableObservation('window-value', '3.8', 2, 1),
        boundingBox: { ...v3TableObservation('window-value', '3.8', 2, 1).boundingBox, y: 0.2 },
      },
      {
        ...v3TableObservation('window-unit', 'mmol/L', 2, 2),
        boundingBox: { ...v3TableObservation('window-unit', 'mmol/L', 2, 2).boundingBox, y: 0.2 },
      },
      v3TableObservation('window-known-label', 'Glucose', 4, 0),
      v3TableObservation('window-known-value', '5.7', 4, 1),
      v3TableObservation('window-known-unit', 'mmol/L', 4, 2),
    ];
    const mappedSourceIds: string[][] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 6,
      supports: () => true,
      async map({ rows }) {
        mappedSourceIds.push(...rows.map((row) => [...row.sourceObservationIds]));
        return { proposals: rows.map((row) => compactSemanticProposal(row)) };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-promotion', 'image')))!
      .report;
    const draft = await service.startExtraction(report.id);
    const promoted = draft.rows.find((row) => row.source.observationIds.includes('window-value'));

    assert.deepEqual(mappedSourceIds, [['window-label', 'window-value', 'window-unit']]);
    assert.ok(promoted);
    assert.equal(promoted.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(promoted.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.equal(promoted.proposedUnit, 'mmol/L');
    assert.equal(promoted.proposedSpecimenType, 'serum');
    assert.equal(promoted.collectionDate.kind, 'known');
    assert.equal(promoted.collectionDate.value, '2026-08-20');
    assert.equal(promoted.source.artifact?.kind, 'original');
    assert.equal(promoted.source.artifact?.hash, report.sourceHash);
    assert.deepEqual(promoted.source.semantic?.sourceObservationIds, [
      'window-label',
      'window-value',
      'window-unit',
    ]);
    assert.deepEqual(promoted.source.semantic?.sourceFieldObservationIds, {
      label: 'window-label',
      value: 'window-value',
      unit: 'window-unit',
      referenceInterval: null,
      flag: null,
    });
    assert.equal(
      draft.rows.filter((row) => row.source.observationIds.includes('window-value')).length,
      1,
    );
  });

  test('runs the production variant schema only over geometry groups and persists exact fields', async () => {
    const observations = [
      v3TableObservation('variant-app-label', 'Novel marker', 0, 0),
      v3TableObservation('variant-app-value', '3.8', 0, 1),
      v3TableObservation('variant-app-unit', 'mmol/L', 0, 2),
      v3TableObservation('variant-known-label', 'Glucose', 2, 0),
      v3TableObservation('variant-known-value', '5.7', 2, 1),
      v3TableObservation('variant-known-unit', 'mmol/L', 2, 2),
    ];
    const mappedRows: string[][] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-variant-selector.test.v1',
      schemaVersion: 'alyte.geometry-variant-selector.v2',
      maxRowsPerChunk: 2,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        mappedRows.push(...rows.map((row) => [...row.sourceObservationIds]));
        const group = rows[0] as GeometryCandidateWindowGroup;
        const variant = group.variants[0]!;
        return [
          {
            sourceObservationIds: [...group.sourceObservationIds],
            sourceFields: { ...variant.provisionalSourceFields },
            proposedBiomarkerId: null,
            role: 'preserve' as const,
          },
        ];
      },
    };
    const service = createService(
      createRepository(),
      new FakeFiles(),
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('variant-app-contract', 'image')))!.report;
    const draft = await service.startExtraction(report.id);
    const promoted = draft.rows.find((row) =>
      row.source.observationIds.includes('variant-app-value'),
    );

    assert.deepEqual(mappedRows, [['variant-app-label', 'variant-app-value', 'variant-app-unit']]);
    assert.ok(promoted);
    assert.equal(promoted.source.semantic?.schemaVersion, 'alyte.geometry-variant-selector.v2');
    assert.deepEqual(promoted.source.semantic?.sourceFieldObservationIds, {
      label: 'variant-app-label',
      value: 'variant-app-value',
      unit: 'variant-app-unit',
      referenceInterval: null,
      flag: null,
    });
    assert.equal(promoted.reviewState, 'needs-review');
    assert.equal(promoted.decision, 'preserve');
    assert.equal(
      mappedRows.some((ids) => ids.includes('variant-known-value')),
      false,
    );
  });

  test('requires an older open draft to be reprocessed before improvement or confirmation', async () => {
    const observations = [
      v3TableObservation('stale-label', 'Glucose', 0, 0),
      v3TableObservation('stale-value', '5.7', 0, 1),
      v3TableObservation('stale-unit', 'mmol/L', 0, 2),
    ];
    const repository = createRepository();
    const files = new FakeFiles();
    const visionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v4',
          pageIndex: 0,
          orientation: 0,
          observations,
        });
      },
    };
    const olderMapper: ExtractionSemanticMapper = {
      adapterVersion: 'legacy-semantic-mapper.test.v1',
      schemaVersion: 'alyte.semantic-mapper.v2',
      supports: () => true,
      map: async () => [],
    };
    const olderService = createService(repository, files, {
      visionOCR,
      semanticMapper: olderMapper,
    });
    const report = (await olderService.importImages(source('stale-open-draft', 'image')))!.report;
    const olderDraft = await olderService.startExtraction(report.id);

    const currentMapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-variant-selector.test.v2',
      schemaVersion: 'alyte.geometry-variant-selector.v2',
      maxRowsPerChunk: 2,
      maxObservationsPerChunk: 24,
      supports: () => true,
      map: async () => [],
    };
    const currentService = createService(repository, files, {
      visionOCR,
      semanticMapper: currentMapper,
    });
    await assert.rejects(
      currentService.improveExtraction(report.id),
      /must be reprocessed before it can be improved/u,
    );
    await assert.rejects(
      currentService.confirmExtraction(olderDraft.id),
      /must be reprocessed before it can be confirmed/u,
    );

    const refreshed = await currentService.startExtraction(report.id);
    assert.notEqual(refreshed.id, olderDraft.id);
    assert.equal(refreshed.pipelineStatus, 'current');
    assert.equal(
      refreshed.pipelineFingerprint?.semanticSchemaVersion,
      'alyte.geometry-variant-selector.v2',
    );
  });

  test('admits one exact variant from a multi-anchor physical row', async () => {
    const observations = [
      v3TableObservation('multi-anchor-label', 'Unmapped marker', 0, 0),
      v3TableObservation('multi-anchor-value-a', '3.8', 0, 1),
      v3TableObservation('multi-anchor-unit', 'mmol/L', 0, 2),
      v3TableObservation('multi-anchor-value-b', '4.1', 0, 3),
    ];
    const mappedInputs: string[][] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'multi-anchor.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 2,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        mappedInputs.push(rows.map((row) => row.rowId));
        const row = rows[0]!;
        return {
          proposals: [
            compactSemanticProposal(row, {
              valueId: 'multi-anchor-value-b',
            }),
          ],
        };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('multi-anchor-admit', 'image')))?.report;
    assert.ok(report);
    const draft = await service.startExtraction(report.id);

    assert.equal(mappedInputs.length, 1);
    const admitted = draft.rows.find((row) =>
      row.source.observationIds.includes('multi-anchor-value-b'),
    );
    assert.ok(admitted);
    assert.deepEqual(admitted.proposedValue, { kind: 'numeric', value: 4.1 });
    assert.equal(admitted.sourceValueString, '4.1');
    assert.equal(
      admitted.source.semantic?.sourceFieldObservationIds?.value,
      'multi-anchor-value-b',
    );
    assert.equal(
      draft.rows.filter((row) =>
        row.source.observationIds.some((id) => id.startsWith('multi-anchor-value-')),
      ).length,
      1,
    );
  });

  test('document VLM replaces one ambiguous fallback with one exact source-grounded row', async () => {
    const observations = [
      v3TableObservation('vlm-label', 'Unmapped marker', 0, 0),
      v3TableObservation('vlm-value-a', '3.8', 0, 1),
      v3TableObservation('vlm-unit', 'mmol/L', 0, 2),
      v3TableObservation('vlm-value-b', '4.1', 0, 3),
    ];
    const lifecycle: string[] = [];
    const documentVLM: DocumentVLMExtractor = {
      adapterVersion: 'alyte.qwen3-vl.document-extractor.v1',
      schemaVersion: 'alyte.document-vlm.flat-rows.v1',
      provenance: {
        modelVersion: 'synthetic-model',
        runtimeVersion: 'synthetic-runtime',
        promptVersion: 'alyte.document-vlm.prompt.v1',
      },
      checkAvailability: async () => {},
      supports: () => {
        lifecycle.push('supports');
        return true;
      },
      prepare: async () => {
        lifecycle.push('prepare');
        return { release: async () => void lifecycle.push('release') };
      },
      extract: async () => {
        lifecycle.push('extract');
        return [
          {
            label: 'Unmapped marker',
            value: '4.1',
            unit: 'mmol/L',
            referenceInterval: null,
            flag: null,
          },
        ];
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, {
      visionOCR: {
        async recognize(): Promise<VisionOCRResult> {
          lifecycle.push('ocr');
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      documentVLM,
    });
    assert.deepEqual(lifecycle, []);
    const report = (await service.importImages(source('document-vlm-grounding', 'image')))!.report;
    const draft = await service.startExtraction(report.id);

    assert.deepEqual(lifecycle, ['ocr', 'supports', 'prepare', 'extract', 'release']);
    const physicalRows = draft.rows.filter((row) =>
      row.source.observationIds.some((id) => id.startsWith('vlm-value-')),
    );
    assert.equal(physicalRows.length, 1);
    assert.equal(physicalRows[0]?.sourceValueString, '4.1');
    assert.ok(physicalRows[0]?.source.observationIds.includes('vlm-value-b'));
    assert.equal(physicalRows[0]?.reviewState, 'needs-review');
  });

  test('deletes a rendered private band when source integrity changes before VLM inference', async () => {
    const pdf = new BandTextLayerPdf([
      { pageIndex: 0, width: 612, height: 792, hasTextLayer: true },
    ]);
    pdf.textLayerResults.set(
      0,
      decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v4',
        pageIndex: 0,
        orientation: 0,
        observations: [
          v3TableObservation('mutation-label', 'Unmapped marker', 0, 0),
          v3TableObservation('mutation-value', '4.1', 0, 1),
          v3TableObservation('mutation-unit', 'mmol/L', 0, 2),
        ],
      }),
    );
    const lifecycle: string[] = [];
    const documentVLM: DocumentVLMExtractor = {
      adapterVersion: 'alyte.qwen3-vl.document-extractor.v1',
      schemaVersion: 'alyte.document-vlm.flat-rows.v1',
      provenance: {
        modelVersion: 'synthetic-model',
        runtimeVersion: 'synthetic-runtime',
        promptVersion: 'alyte.document-vlm.prompt.v1',
      },
      checkAvailability: async () => {},
      supports: () => true,
      prepare: async () => {
        lifecycle.push('prepare');
        return { release: async () => void lifecycle.push('release') };
      },
      extract: async () => {
        lifecycle.push('extract');
        return [];
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    pdf.onRender = (path) => {
      const retained = files.files.get(path);
      assert.ok(retained);
      files.files.set(path, { ...retained, hash: 'mutated-after-band-render' });
    };
    const service = createService(repository, files, { pdf, documentVLM });
    const report = (await service.importPdf(source('document-vlm-source-mutation')))!.report;

    await assert.rejects(service.startExtraction(report.id), (error: unknown) => {
      assert.ok(error instanceof LabReportExtractionError);
      assert.equal(error.reason, 'original-source');
      return true;
    });
    assert.deepEqual(lifecycle, ['prepare', 'release']);
    assert.equal(pdf.renderedRects.length, 1);
    assert.deepEqual(pdf.deletedBandURIs, ['file:///synthetic-band-1.jpg']);
  });

  test('stops dense-page VLM work after a post-inference source mutation', async () => {
    const pdf = new BandTextLayerPdf([
      { pageIndex: 0, width: 612, height: 792, hasTextLayer: true },
    ]);
    const observations = Array.from({ length: 14 }, (_, rowIndex) => [
      v3TableObservationAtY(
        `dense-label-${rowIndex}`,
        `Marker ${rowIndex}`,
        rowIndex,
        0,
        0.05 + rowIndex * 0.06,
      ),
      v3TableObservationAtY(
        `dense-value-${rowIndex}`,
        `${rowIndex + 1}.1`,
        rowIndex,
        1,
        0.05 + rowIndex * 0.06,
      ),
      v3TableObservationAtY(
        `dense-unit-${rowIndex}`,
        'mmol/L',
        rowIndex,
        2,
        0.05 + rowIndex * 0.06,
      ),
    ]).flat();
    pdf.textLayerResults.set(
      0,
      decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v4',
        pageIndex: 0,
        orientation: 0,
        observations,
      }),
    );
    const repository = createRepository();
    const files = new FakeFiles();
    let retainedPath = '';
    let inferenceCalls = 0;
    const documentVLM: DocumentVLMExtractor = {
      adapterVersion: 'alyte.qwen3-vl.document-extractor.v1',
      schemaVersion: 'alyte.document-vlm.flat-rows.v1',
      provenance: {
        modelVersion: 'synthetic-model',
        runtimeVersion: 'synthetic-runtime',
        promptVersion: 'alyte.document-vlm.prompt.v1',
      },
      checkAvailability: async () => {},
      supports: () => true,
      prepare: async () => ({ release: async () => {} }),
      extract: async () => {
        inferenceCalls += 1;
        const retained = files.files.get(retainedPath);
        assert.ok(retained);
        files.files.set(retainedPath, { ...retained, hash: 'mutated-during-inference' });
        return [];
      },
    };
    const service = createService(repository, files, { pdf, documentVLM });
    const report = (await service.importPdf(source('document-vlm-inference-mutation')))!.report;
    retainedPath = [...files.files.keys()].find((path) => path.includes('/originals/')) ?? '';
    assert.notEqual(retainedPath, '');

    await assert.rejects(service.startExtraction(report.id), (error: unknown) => {
      assert.ok(error instanceof LabReportExtractionError);
      assert.equal(error.reason, 'original-source');
      return true;
    });
    assert.equal(inferenceCalls, 1);
    assert.deepEqual(pdf.renderedRects, [{ x: 0, y: 0, width: 1, height: 0.54 }]);
    assert.deepEqual(pdf.deletedBandURIs, ['file:///synthetic-band-1.jpg']);
  });

  test('keeps duplicate multi-anchor proposals as one reviewable physical-row fallback', async () => {
    const observations = [
      v3TableObservation('multi-duplicate-label', 'Unmapped marker', 0, 0),
      v3TableObservation('multi-duplicate-value-a', '3.8', 0, 1),
      v3TableObservation('multi-duplicate-unit', 'mmol/L', 0, 2),
      v3TableObservation('multi-duplicate-value-b', '4.1', 0, 3),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'multi-duplicate.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        const row = rows[0]!;
        return {
          proposals: [
            compactSemanticProposal(row, { valueId: 'multi-duplicate-value-a' }),
            compactSemanticProposal(row, { valueId: 'multi-duplicate-value-b' }),
          ],
        };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('multi-anchor-duplicate', 'image')))?.report;
    assert.ok(report);
    const draft = await service.startExtraction(report.id);

    assert.equal(draft.rows.length, 1);
    assert.equal(draft.rows[0]?.source.semantic, null);
    assert.ok(draft.rows[0]?.reviewReasons.includes('unsupported-layout'));
    assert.ok(draft.rows[0]?.reviewReasons.includes('unsupported-alias'));
    assert.equal(
      draft.rows.filter((row) =>
        row.source.observationIds.some((id) => id.startsWith('multi-duplicate-value-')),
      ).length,
      1,
    );
  });

  test('keeps a supported alias on a multi-anchor fallback without claiming it is unsupported', async () => {
    const observations = [
      v3TableObservation('multi-supported-label', 'LDL-C', 0, 0),
      v3TableObservation('multi-supported-value-a', '3.8', 0, 1),
      v3TableObservation('multi-supported-unit', 'mmol/L', 0, 2),
      v3TableObservation('multi-supported-value-b', '4.1', 0, 3),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'multi-supported-fallback.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map() {
        throw new Error('synthetic multi-anchor mapping failure');
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('multi-anchor-supported', 'image')))?.report;
    assert.ok(report);
    const draft = await service.startExtraction(report.id);
    const fallback = draft.rows[0];

    assert.ok(fallback);
    assert.equal(fallback.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(fallback.reviewReasons.includes('unsupported-alias'), false);
    assert.ok(fallback.reviewReasons.includes('unsupported-layout'));
    assert.ok(fallback.reviewReasons.includes('unparseable-value'));
  });

  test('preserves an edited multi-anchor fallback across a cached start', async () => {
    const observations = [
      v3TableObservation('multi-retry-label', 'Unmapped marker', 0, 0),
      v3TableObservation('multi-retry-value-a', '3.8', 0, 1),
      v3TableObservation('multi-retry-unit', 'mmol/L', 0, 2),
      v3TableObservation('multi-retry-value-b', '4.1', 0, 3),
    ];
    let shouldFail = true;
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'multi-retry.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        if (shouldFail) throw new Error('synthetic multi-anchor retry failure');
        return {
          proposals: [
            compactSemanticProposal(rows[0]!, {
              valueId: 'multi-retry-value-a',
            }),
          ],
        };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('multi-anchor-retry', 'image')))?.report;
    assert.ok(report);
    const first = await service.startExtraction(report.id);
    assert.equal(first.rows.length, 1);
    assert.equal(first.rows[0]?.source.semantic, null);
    const edited = await service.updateExtractionRow(first.rows[0]!.id, { decision: 'skip' });

    shouldFail = false;
    const retried = await service.startExtraction(report.id);
    assert.equal(retried.rows.length, 1);
    assert.equal(retried.rows[0]?.id, edited.id);
    assert.equal(retried.rows[0]?.decision, 'skip');
    assert.equal(retried.rows[0]?.editState, 'user-edited');
  });

  test('keeps deterministic rows and unsupported windows when refinement has no accepted proposal', async () => {
    const observations = [
      v3TableObservation('fallback-heading', 'Serum', 0, 0),
      v3TableObservation('fallback-label', 'LDL-C', 1, 0),
      {
        ...v3TableObservation('fallback-value', '3.8', 2, 1),
        boundingBox: { ...v3TableObservation('fallback-value', '3.8', 2, 1).boundingBox, y: 0.2 },
      },
      {
        ...v3TableObservation('fallback-unit', 'mmol/L', 2, 2),
        boundingBox: { ...v3TableObservation('fallback-unit', 'mmol/L', 2, 2).boundingBox, y: 0.2 },
      },
      v3TableObservation('fallback-known-label', 'Glucose', 4, 0),
      v3TableObservation('fallback-known-value', '5.7', 4, 1),
      v3TableObservation('fallback-known-unit', 'mmol/L', 4, 2),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-empty.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      supports: () => true,
      async map() {
        return { proposals: [] };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-empty', 'image')))!.report;
    const draft = await service.startExtraction(report.id);

    assert.equal(draft.rows.length, 2);
    assert.equal(
      draft.rows.some((row) => row.source.observationIds.includes('fallback-known-label')),
      true,
    );
    assert.equal(
      draft.rows.some((row) => row.id.startsWith('gw-')),
      false,
    );
  });

  test('persists an accepted unsupported window as a reviewable preserve row', async () => {
    const observations = [
      v3TableObservation('preserve-heading', 'Serum', 0, 0),
      v3TableObservation('preserve-label', 'Novel marker', 1, 0),
      v3TableObservationAtY('preserve-value', '4.2', 2, 1, 0.2),
      v3TableObservationAtY('preserve-unit', 'mg/L', 2, 2, 0.2),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-preserve.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      supports: () => true,
      async map({ rows }) {
        const row = rows[0]!;
        if (row.observations.some((observation) => observation.text === 'Novel marker'))
          return {
            proposals: [compactSemanticProposal(row, { role: 'preserve', biomarkerId: null })],
          };
        return { proposals: [] };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-preserve', 'image')))!
      .report;
    const draft = await service.startExtraction(report.id);
    const preserved = draft.rows.find((row) =>
      row.source.observationIds.includes('preserve-label'),
    );

    assert.ok(preserved);
    assert.equal(preserved.proposedBiomarkerId, null);
    assert.equal(preserved.decision, 'preserve');
    assert.ok(preserved.reviewReasons.includes('unsupported-alias'));
    assert.deepEqual(preserved.source.semantic?.sourceObservationIds, [
      'preserve-label',
      'preserve-value',
      'preserve-unit',
    ]);
    assert.equal(
      draft.rows.filter((row) => row.source.observationIds.includes('preserve-value')).length,
      1,
    );
  });

  test('rejects an accepted window with an incompatible unit or specimen', async () => {
    const run = async (prefix: string, heading: string, unit: string) => {
      const observations = [
        v3TableObservation(`${prefix}-heading`, heading, 0, 0),
        v3TableObservation(`${prefix}-label`, 'LDL-C', 1, 0),
        v3TableObservationAtY(`${prefix}-value`, '3.8', 2, 1, 0.2),
        v3TableObservationAtY(`${prefix}-unit`, unit, 2, 2, 0.2),
      ];
      const mapper: ExtractionSemanticMapper = {
        adapterVersion: `${prefix}.test.v2`,
        schemaVersion: 'alyte.semantic-mapper.v2',
        maxRowsPerChunk: 1,
        supports: () => true,
        async map({ rows }) {
          const row = rows.find((candidate) =>
            candidate.observations.some((observation) => observation.text === 'LDL-C'),
          );
          return row === undefined
            ? { proposals: [] }
            : { proposals: [compactSemanticProposal(row)] };
        },
      };
      const repository = createRepository();
      const files = new FakeFiles();
      const service = createService(
        repository,
        files,
        new FakePdf(),
        {
          async recognize(): Promise<VisionOCRResult> {
            return decodeVisionOCRResult({
              contractVersion: 'alyte.vision.document.v4',
              pageIndex: 0,
              orientation: 0,
              observations,
            });
          },
        },
        mapper,
      );
      const report = (await service.importImages(source(`geometry-window-${prefix}`, 'image')))!
        .report;
      const draft = await service.startExtraction(report.id);
      return draft;
    };

    const incompatibleUnit = await run('incompatible-unit', 'Serum', 'µg/L');
    const incompatibleSpecimen = await run('incompatible-specimen', 'Urine', 'mmol/L');
    assert.equal(
      incompatibleUnit.rows.some((row) => row.id.startsWith('gw-')),
      false,
    );
    assert.equal(
      incompatibleSpecimen.rows.some((row) => row.id.startsWith('gw-')),
      false,
    );
  });

  test('does not send a duplicate geometry window for a complete deterministic row', async () => {
    const observations = [
      v3TableObservation('dedupe-heading', 'Serum', 0, 0),
      v3TableObservation('dedupe-label', 'LDL-C', 1, 0),
      v3TableObservation('dedupe-value', '3.8', 1, 1),
      v3TableObservation('dedupe-unit', 'mmol/L', 1, 2),
    ];
    let mapperCalls = 0;
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-dedupe.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      supports: () => true,
      async map() {
        mapperCalls += 1;
        throw new Error('complete deterministic rows must not be mapped');
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-dedupe', 'image')))!.report;
    const draft = await service.startExtraction(report.id);

    assert.equal(mapperCalls, 0);
    assert.equal(draft.rows.length, 1);
    assert.deepEqual(draft.rows[0]?.source.observationIds, [
      'dedupe-label',
      'dedupe-value',
      'dedupe-unit',
    ]);
    assert.equal(draft.rows[0]?.source.semantic, null);
  });

  test('rejects invented, wrong-anchor, and cross-window source selections', async () => {
    const observations = [
      v3TableObservation('reject-heading', 'Serum', 0, 0),
      v3TableObservation('reject-label-a', 'LDL-C', 1, 0),
      {
        ...v3TableObservation('reject-value-a', '3.8', 2, 1),
        boundingBox: { ...v3TableObservation('reject-value-a', '3.8', 2, 1).boundingBox, y: 0.2 },
      },
      {
        ...v3TableObservation('reject-unit-a', 'mmol/L', 2, 2),
        boundingBox: { ...v3TableObservation('reject-unit-a', 'mmol/L', 2, 2).boundingBox, y: 0.2 },
      },
      v3TableObservation('reject-label-b', 'Glucose', 5, 0),
      {
        ...v3TableObservation('reject-value-b', '5.7', 6, 1),
        boundingBox: { ...v3TableObservation('reject-value-b', '5.7', 6, 1).boundingBox, y: 0.52 },
      },
      {
        ...v3TableObservation('reject-unit-b', 'mmol/L', 6, 2),
        boundingBox: {
          ...v3TableObservation('reject-unit-b', 'mmol/L', 6, 2).boundingBox,
          y: 0.52,
        },
      },
      v3TableObservation('reject-known-label', 'Ferritin', 8, 0),
      v3TableObservation('reject-known-value', '42', 8, 1),
      v3TableObservation('reject-known-unit', 'ng/mL', 8, 2),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-reject.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      supports: () => true,
      async map({ rows }) {
        const row = rows[0]!;
        const value = row.observations.find((observation) => /^\d/iu.test(observation.text));
        const wrongValueId = row.observations[0]?.id ?? 'missing-source-id';
        return {
          proposals: [
            {
              ...compactSemanticProposal(row, { valueId: wrongValueId }),
              labelKey: 'c99',
              valueKey: `c${row.observations.findIndex((observation) => observation.id === value?.id)}`,
            },
          ],
        };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-reject', 'image')))!.report;
    const draft = await service.startExtraction(report.id);

    assert.equal(
      draft.rows.some((row) => row.id.startsWith('gw-')),
      false,
    );
    assert.equal(
      draft.rows.filter((row) => row.source.observationIds.includes('reject-value-a')).length,
      1,
    );
    assert.equal(
      draft.rows.filter((row) => row.source.observationIds.includes('reject-value-b')).length,
      1,
    );
    assert.equal(
      draft.rows.some((row) => row.source.observationIds.includes('reject-known-label')),
      true,
    );
  });

  test('does not promote a window after a semantic model failure', async () => {
    const observations = [
      v3TableObservation('failure-heading', 'Serum', 0, 0),
      v3TableObservation('failure-label', 'LDL-C', 1, 0),
      {
        ...v3TableObservation('failure-value', '3.8', 2, 1),
        boundingBox: { ...v3TableObservation('failure-value', '3.8', 2, 1).boundingBox, y: 0.2 },
      },
      {
        ...v3TableObservation('failure-unit', 'mmol/L', 2, 2),
        boundingBox: { ...v3TableObservation('failure-unit', 'mmol/L', 2, 2).boundingBox, y: 0.2 },
      },
      v3TableObservation('failure-known-label', 'Glucose', 4, 0),
      v3TableObservation('failure-known-value', '5.7', 4, 1),
      v3TableObservation('failure-known-unit', 'mmol/L', 4, 2),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-failure.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      supports: () => true,
      async map() {
        throw new Error('synthetic model failure');
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-failure', 'image')))!.report;
    const draft = await service.startExtraction(report.id);

    assert.equal(
      draft.rows.some((row) => row.id.startsWith('gw-')),
      false,
    );
    assert.equal(
      draft.rows.some((row) => row.source.observationIds.includes('failure-known-label')),
      true,
    );
  });

  test('keeps an independently accepted window when another semantic chunk fails', async () => {
    const observations = [
      v3TableObservation('partial-heading', 'Serum', 0, 0),
      v3TableObservation('partial-label-a', 'Novel marker A', 1, 0),
      v3TableObservationAtY('partial-value-a', '3.8', 2, 1, 0.2),
      v3TableObservationAtY('partial-unit-a', 'mmol/L', 2, 2, 0.2),
      v3TableObservation('partial-label-b', 'Novel marker B', 4, 0),
      v3TableObservationAtY('partial-value-b', '5.7', 5, 1, 0.4),
      v3TableObservationAtY('partial-unit-b', 'mmol/L', 5, 2, 0.4),
    ];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-partial.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      supports: () => true,
      async map({ rows }) {
        const row = rows[0]!;
        if (row.observations.some((observation) => observation.text === 'Novel marker A'))
          throw new Error('synthetic sibling chunk failure');
        return {
          proposals: [compactSemanticProposal(row, { role: 'preserve', biomarkerId: null })],
        };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-partial', 'image')))?.report;
    assert.ok(report);
    const draft = await service.startExtraction(report.id);

    assert.equal(
      draft.rows.some((row) => row.source.observationIds.includes('partial-label-b')),
      true,
    );
    assert.equal((await service.loadExtractionProgress(report.id))?.status, 'complete');
    assert.equal((await service.loadExtractionProgress(report.id))?.stage, 'review');
  });

  test('keeps a deterministic first-import fallback without an automatic model retry', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    let mapperCalls = 0;
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'semantic-retry-source',
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
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-retry.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map() {
        mapperCalls += 1;
        if (mapperCalls === 1) throw new Error('synthetic semantic timeout');
        return [];
      },
    };
    const service = createService(repository, files, new FakePdf(), ocr, mapper);
    const report = (await service.importImages(source('semantic-retry', 'image')))?.report;
    assert.ok(report);

    const first = await service.startExtraction(report.id);
    const failed = await service.loadExtractionProgress(report.id);
    assert.equal(mapperCalls, 1);
    assert.ok(first.rows.length > 0);
    const edited = await service.updateExtractionRow(first.rows[0]!.id, { decision: 'skip' });
    assert.deepEqual(failed, {
      reportId: report.id,
      mode: 'start',
      stage: 'review',
      status: 'complete',
      completed: 1,
      total: 1,
    });

    const retried = await service.startExtraction(report.id);
    const complete = await service.loadExtractionProgress(report.id);
    assert.equal(mapperCalls, 1);
    assert.equal(complete?.status, 'complete');
    assert.equal(retried.rows.length, first.rows.length);
    const retriedEdited = retried.rows.find((row) => row.id === edited.id);
    assert.ok(retriedEdited);
    assert.equal(retriedEdited.decision, edited.decision);
    assert.equal(retriedEdited.editState, edited.editState);
    assert.equal(await service.countOpenExtractionDrafts(), 1);
  });

  test('cached start preserves edited deterministic rows without retrying optional refinement', async () => {
    const observations = [
      v3TableObservation('retry-window-heading', 'Serum', 0, 0),
      v3TableObservation('retry-window-label', 'LDL-C', 1, 0),
      v3TableObservationAtY('retry-window-value', '3.8', 2, 1, 0.2),
      v3TableObservationAtY('retry-window-unit', 'mmol/L', 2, 2, 0.2),
      v3TableObservation('retry-known-label', 'Glucose', 4, 0),
      v3TableObservation('retry-known-value', '5.7', 4, 1),
      v3TableObservation('retry-known-unit', 'mmol/L', 4, 2),
    ];
    let shouldFail = true;
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'geometry-window-retry.test.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 6,
      supports: () => true,
      async map({ rows }) {
        if (shouldFail) throw new Error('synthetic first-attempt failure');
        const row = rows[0]!;
        return row.observations.some((observation) => observation.text === 'LDL-C')
          ? { proposals: [compactSemanticProposal(row)] }
          : { proposals: [] };
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(
      repository,
      files,
      new FakePdf(),
      {
        async recognize(): Promise<VisionOCRResult> {
          return decodeVisionOCRResult({
            contractVersion: 'alyte.vision.document.v4',
            pageIndex: 0,
            orientation: 0,
            observations,
          });
        },
      },
      mapper,
    );
    const report = (await service.importImages(source('geometry-window-retry', 'image')))?.report;
    assert.ok(report);
    const first = await service.startExtraction(report.id);
    const deterministic = first.rows.find((row) =>
      row.source.observationIds.includes('retry-known-label'),
    );
    assert.ok(deterministic);
    const edited = await service.updateExtractionRow(deterministic.id, { decision: 'skip' });
    shouldFail = false;

    const retried = await service.startExtraction(report.id);
    const retriedEdited = retried.rows.find((row) => row.id === edited.id);
    assert.ok(retriedEdited);
    assert.equal(retriedEdited.decision, edited.decision);
    assert.equal(retriedEdited.editState, edited.editState);
    assert.equal(shouldFail, false);
    assert.equal(
      retried.rows.some((row) => row.source.observationIds.includes('retry-window-label')),
      false,
    );
    assert.equal((await service.loadExtractionProgress(report.id))?.status, 'complete');
  });

  test('relaunching a report keeps a complete deterministic draft without model retry', async () => {
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
              id: 'semantic-relaunch-source',
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
    const failingMapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-relaunch.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map() {
        throw new Error('synthetic semantic runtime failure');
      },
    };
    const firstService = createService(repository, files, new FakePdf(), ocr, failingMapper);
    const report = (await firstService.importImages(source('semantic-relaunch', 'image')))?.report;
    assert.ok(report);
    await firstService.startExtraction(report.id);

    let relaunchedMapperCalls = 0;
    const relaunchedMapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-relaunch.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map() {
        relaunchedMapperCalls += 1;
        return [];
      },
    };
    const relaunched = createService(repository, files, new FakePdf(), ocr, relaunchedMapper);
    const restored = await relaunched.loadExtractionProgress(report.id);
    assert.equal(restored?.status, 'complete');
    assert.equal(restored?.stage, 'review');
    assert.equal((await relaunched.startExtraction(report.id)) !== null, true);
    assert.equal(relaunchedMapperCalls, 0);
    assert.equal((await relaunched.loadExtractionProgress(report.id))?.status, 'complete');
  });

  test('keeps an explicit mapper-incomplete result as deterministic review work', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-explicit-incomplete.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v2',
      supports: () => true,
      async map() {
        return { proposals: [], incomplete: true };
      },
    };
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.document.v2',
          pageIndex: 0,
          orientation: 0,
          observations: [
            {
              id: 'explicit-incomplete-source',
              text: 'LDL-C 3.8 mmol/L',
              alternatives: [],
              boundingBox: { x: 0.1, y: 0.2, width: 0.6, height: 0.04 },
              pageIndex: 0,
              orientation: 0,
              recognition: { level: 'accurate', language: 'en', internalConfidence: null },
            },
          ],
        };
      },
    };
    const service = createService(repository, files, new FakePdf(), ocr, mapper);
    const report = (await service.importImages(source('semantic-explicit-incomplete', 'image')))
      ?.report;
    assert.ok(report);

    const draft = await service.startExtraction(report.id);
    assert.ok(draft.rows.length > 0);
    assert.deepEqual(
      {
        status: (await service.loadExtractionProgress(report.id))?.status,
        stage: (await service.loadExtractionProgress(report.id))?.stage,
      },
      { status: 'complete', stage: 'review' },
    );
  });

  test('relaunching an older duplicate physical-row draft reconciles it without losing exclusion', async () => {
    const observations = [
      v3TableObservation('stale-row-label', 'LDL-C', 0, 0),
      v3TableObservation('stale-row-value-a', '3.8', 0, 1),
      v3TableObservation('stale-row-unit', 'mmol/L', 0, 2),
      v3TableObservation('stale-row-value-b', '4.1', 0, 3),
    ];
    const failingMapper: ExtractionSemanticMapper = {
      adapterVersion: 'stale-row.mapper.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map() {
        throw new Error('synthetic initial mapping failure');
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v4',
          pageIndex: 0,
          orientation: 0,
          observations,
        });
      },
    };
    const firstService = createService(repository, files, new FakePdf(), ocr, failingMapper);
    const report = (await firstService.importImages(source('stale-row-duplicate', 'image')))
      ?.report;
    assert.ok(report);
    const first = await firstService.startExtraction(report.id);
    assert.equal(first.rows.length, 1);

    await repository.deleteExtractionDraft(first.id);
    const staleFingerprint = createExtractionPipelineFingerprint(
      {
        sourceHash: report.sourceHash,
        ocrContractVersion: 'alyte.vision.document.v4',
        rowSegmentationVersion: 'alyte.row-segmentation.v2',
        parserVersion: EXTRACTION_PARSER_VERSION,
        semanticAdapterVersion: failingMapper.adapterVersion,
        semanticSchemaVersion: failingMapper.schemaVersion,
        semanticChunkVersion: null,
        semanticPromptVersion: null,
        modelVersion: null,
        runtimeVersion: null,
        catalogueVersion: null,
      },
      1,
    );
    const stale = await repository.createExtractionDraft({
      id: first.id,
      reportId: report.id,
      collectionDate: first.collectionDate,
      rows: [first.rows[0]!, { ...first.rows[0]!, order: 1 }],
      sourceArtifact: first.sourceArtifact ?? null,
      pipelineFingerprint: staleFingerprint,
      revision: 1,
    });
    const edited = await repository.updateExtractionDraftRow(
      stale.rows[0]!.id,
      { decision: 'skip' },
      createDefaultExtractionAliases(),
    );

    const acceptedMapper: ExtractionSemanticMapper = {
      ...failingMapper,
      async map({ rows }) {
        return { proposals: [compactSemanticProposal(rows[0]!, { valueId: 'stale-row-value-b' })] };
      },
    };
    const relaunched = createService(repository, files, new FakePdf(), ocr, acceptedMapper);
    const reconciled = await relaunched.startExtraction(report.id);

    assert.equal(reconciled.pipelineStatus, 'current');
    assert.equal(reconciled.rows.length, 1);
    assert.equal(reconciled.rows[0]?.id, edited.id);
    assert.equal(reconciled.rows[0]?.decision, 'skip');
    assert.equal(reconciled.rows[0]?.editState, 'user-edited');
    assert.deepEqual(reconciled.rows[0]?.source.observationIds, [
      'stale-row-label',
      'stale-row-value-a',
      'stale-row-unit',
      'stale-row-value-b',
    ]);
  });

  test('relaunching competing edits keeps one honest physical-row review exception', async () => {
    const observations = [
      v3TableObservation('competing-row-label', 'LDL-C', 0, 0),
      v3TableObservation('competing-row-value-a', '3.8', 0, 1),
      v3TableObservation('competing-row-unit', 'mmol/L', 0, 2),
      v3TableObservation('competing-row-value-b', '4.1', 0, 3),
    ];
    const failingMapper: ExtractionSemanticMapper = {
      adapterVersion: 'competing-row.mapper.v2',
      schemaVersion: 'alyte.semantic-mapper.v2',
      maxRowsPerChunk: 1,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map() {
        throw new Error('synthetic initial mapping failure');
      },
    };
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return decodeVisionOCRResult({
          contractVersion: 'alyte.vision.document.v4',
          pageIndex: 0,
          orientation: 0,
          observations,
        });
      },
    };
    const firstService = createService(repository, files, new FakePdf(), ocr, failingMapper);
    const report = (await firstService.importImages(source('competing-row-duplicate', 'image')))
      ?.report;
    assert.ok(report);
    const first = await firstService.startExtraction(report.id);
    await repository.deleteExtractionDraft(first.id);
    const staleFingerprint = createExtractionPipelineFingerprint(
      {
        sourceHash: report.sourceHash,
        ocrContractVersion: 'alyte.vision.document.v4',
        rowSegmentationVersion: 'alyte.row-segmentation.v2',
        parserVersion: EXTRACTION_PARSER_VERSION,
        semanticAdapterVersion: failingMapper.adapterVersion,
        semanticSchemaVersion: failingMapper.schemaVersion,
        semanticChunkVersion: null,
        semanticPromptVersion: null,
        modelVersion: null,
        runtimeVersion: null,
        catalogueVersion: null,
      },
      1,
    );
    const stale = await repository.createExtractionDraft({
      id: first.id,
      reportId: report.id,
      collectionDate: first.collectionDate,
      rows: [first.rows[0]!, { ...first.rows[0]!, order: 1 }],
      sourceArtifact: first.sourceArtifact ?? null,
      pipelineFingerprint: staleFingerprint,
      revision: 1,
    });
    const skipped = await repository.updateExtractionDraftRow(
      stale.rows[0]!.id,
      { decision: 'skip' },
      createDefaultExtractionAliases(),
    );
    await repository.updateExtractionDraftRow(
      stale.rows[1]!.id,
      { proposedLabel: 'Glucose' },
      createDefaultExtractionAliases(),
    );

    const acceptedMapper: ExtractionSemanticMapper = {
      ...failingMapper,
      async map({ rows }) {
        return {
          proposals: [compactSemanticProposal(rows[0]!, { valueId: 'competing-row-value-b' })],
        };
      },
    };
    const relaunched = createService(repository, files, new FakePdf(), ocr, acceptedMapper);
    const reconciled = await relaunched.startExtraction(report.id);

    assert.equal(reconciled.rows.length, 1);
    assert.equal(
      reconciled.rows[0]?.id === skipped.id || reconciled.rows[0]?.id === stale.rows[1]?.id,
      true,
    );
    assert.equal(reconciled.rows[0]?.decision, 'preserve');
    assert.equal(reconciled.rows[0]?.editState, 'user-edited');
    assert.equal(reconciled.rows[0]?.reviewState, 'needs-review');
    assert.equal(reconciled.rows[0]?.source.semantic, null);
    assert.ok(reconciled.rows[0]?.reviewReasons.includes('unsupported-layout'));
    assert.ok(reconciled.rows[0]?.reviewReasons.includes('unparseable-value'));
    assert.deepEqual(reconciled.rows[0]?.source.observationIds, [
      'competing-row-label',
      'competing-row-value-a',
      'competing-row-unit',
      'competing-row-value-b',
    ]);
  });

  test('preserves an edited open draft when reprocess semantic work fails', async () => {
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
              id: 'semantic-edited-source',
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
    let shouldFail = false;
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'semantic-edited.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: () => true,
      async map() {
        if (shouldFail) throw new Error('synthetic reprocess semantic failure');
        return [];
      },
    };
    const service = createService(repository, files, new FakePdf(), ocr, mapper);
    const report = (await service.importImages(source('semantic-edited', 'image')))?.report;
    assert.ok(report);
    const original = await service.startExtraction(report.id);
    const edited = await service.updateExtractionRow(original.rows[0]!.id, { decision: 'skip' });
    shouldFail = true;

    const preserved = await service.reprocessExtraction(report.id);
    assert.equal(preserved.id, original.id);
    assert.deepEqual(preserved.rows[0], edited);
    assert.deepEqual((await service.getExtractionDraft(original.id))?.rows[0], edited);
    const failed = await service.loadExtractionProgress(report.id);
    assert.equal(failed?.status, 'complete');
    assert.equal(failed?.stage, 'review');
    assert.equal(failed?.error, undefined);
  });

  test('does not gate OCR on an optional semantic mapper', async () => {
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
    const draft = await service.startExtraction(report.id);
    assert.ok(recognitionCalls > 0);
    assert.equal(draft.rows.length, 1);
  });

  test('keeps deterministic rows when optional semantic refinement fails', async () => {
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
    const unavailableProgress = await unavailableService.loadExtractionProgress(
      unavailableReport.id,
    );
    assert.equal(unavailableProgress?.status, 'complete');
    assert.equal(unavailableProgress?.stage, 'review');
    assert.equal(unavailableProgress?.error, undefined);

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
    const runtimeProgress = await runtimeService.loadExtractionProgress(runtimeReport.id);
    assert.equal(runtimeProgress?.status, 'complete');
    assert.equal(runtimeProgress?.stage, 'review');
    assert.equal(runtimeProgress?.error, undefined);
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

  test('keeps the collection date when a same-line report date is also present', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      syntheticDateObservation(
        'same-line-date-header',
        'Collected: 22.08.2026 Reported: 23.08.2026',
        0.08,
        0.1,
      ),
      syntheticDateObservation('same-line-measurement', 'LDL-C 3,8 mmol/L', 0.08, 0.22),
      syntheticDateObservation('same-line-model-row', 'Unmapped marker 4,2 mg/dL', 0.08, 0.34),
    ];
    const modelInputs: string[][][] = [];
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
      {
        adapterVersion: 'date-context-test.mapper.v1',
        schemaVersion: 'alyte.semantic-mapper.v1',
        supports: () => true,
        async map({ rows }) {
          modelInputs.push(rows.map((row) => [...row.sourceObservationIds]));
          return rows.map((row) => ({
            sourceObservationIds: row.sourceObservationIds,
            proposedBiomarkerId: null,
            role: 'preserve' as const,
          }));
        },
      },
    );
    const report = (await service.importPdf(source('same-line-date-context')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    const measurement = draft.rows.find((row) =>
      row.source.observationIds.includes('same-line-measurement'),
    );
    const modelRow = draft.rows.find((row) =>
      row.source.observationIds.includes('same-line-model-row'),
    );

    assert.deepEqual(draft.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.ok(measurement);
    assert.deepEqual(measurement.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.equal(measurement.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.deepEqual(measurement.proposedValue, { kind: 'numeric', value: 3.8 });
    assert.equal(measurement.sourceValueString, '3,8');
    assert.equal(measurement.sourceUnit, 'mmol/L');
    assert.deepEqual(measurement.source.observationIds, ['same-line-measurement']);
    assert.equal(measurement.collectionDateContext?.observationId, 'same-line-date-header');
    assert.equal(measurement.collectionDateContext?.locale, 'de-DE');
    assert.equal(measurement.collectionDateContext?.sourceText, observations[0]?.text);
    assert.equal(measurement.collectionDateContext?.sourceDate, '22.08.2026');
    assert.equal(measurement.collectionDateContext?.labelObservationId, 'same-line-date-header');
    assert.equal(measurement.collectionDateContext?.labelText, observations[0]?.text);
    assert.equal(measurement.source.raw?.collectionDate, observations[0]?.text);
    assert.ok(modelRow);
    assert.deepEqual(modelInputs, [[['same-line-model-row']]]);
  });

  test('associates reversed label/date order across one visual row', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      syntheticDateObservation('reversed-collection-date', '22.08.2026', 0.08, 0.1),
      syntheticDateObservation('reversed-collection-label', 'Collected', 0.3, 0.1),
      syntheticDateObservation('reversed-issued-date', '23.08.2026', 0.52, 0.1),
      syntheticDateObservation('reversed-issued-label', 'Reported', 0.74, 0.1),
      syntheticDateObservation('reversed-measurement', 'LDL-C 3,8 mmol/L', 0.08, 0.22),
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
    const report = (await service.importPdf(source('reversed-date-context')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    const row = draft.rows[0];

    assert.equal(draft.rows.length, 1);
    assert.deepEqual(draft.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.deepEqual(row?.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.equal(row?.collectionDateContext?.observationId, 'reversed-collection-date');
    assert.equal(row?.collectionDateContext?.labelObservationId, 'reversed-collection-label');
    assert.equal(row?.collectionDateContext?.labelText, 'Collected');
    assert.deepEqual(row?.source.observationIds, ['reversed-measurement']);
  });

  test('keeps same-row collection dates separate across side-by-side tables', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      syntheticTableDateObservation(
        'left-table-date',
        'Collection date 22.08.2026',
        0.08,
        0.1,
        'left-table',
        0,
      ),
      syntheticTableDateObservation(
        'left-table-measurement',
        'LDL-C 3,8 mmol/L',
        0.08,
        0.2,
        'left-table',
        1,
      ),
      syntheticTableDateObservation(
        'right-table-date',
        'Collection date 23.08.2026',
        0.6,
        0.1,
        'right-table',
        0,
      ),
      syntheticTableDateObservation(
        'right-table-measurement',
        'LDL-C 4,0 mmol/L',
        0.6,
        0.2,
        'right-table',
        1,
      ),
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
    const report = (await service.importPdf(source('side-by-side-table-dates')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    const rows = new Map(draft.rows.map((row) => [row.source.observationIds[0], row]));

    assert.deepEqual(draft.collectionDate, { kind: 'missing' });
    assert.deepEqual(rows.get('left-table-measurement')?.collectionDate, {
      kind: 'known',
      value: '2026-08-22',
    });
    assert.deepEqual(rows.get('right-table-measurement')?.collectionDate, {
      kind: 'known',
      value: '2026-08-23',
    });
    assert.equal(rows.get('left-table-measurement')?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(rows.get('right-table-measurement')?.proposedBiomarkerId, 'biomarker.ldl_c');
    assert.equal(rows.get('left-table-measurement')?.sourceUnit, 'mmol/L');
    assert.equal(rows.get('right-table-measurement')?.sourceUnit, 'mmol/L');
  });

  test('leaves a single date between collection and report labels ambiguous', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const observations = [
      syntheticDateObservation('tie-collection-label', 'Collected', 0.1),
      syntheticDateObservation('tie-date', '22.08.2026', 0.35),
      syntheticDateObservation('tie-report-label', 'Reported', 0.6),
      syntheticDateObservation('tie-measurement', 'LDL-C 3,8 mmol/L', 0.08, 0.22),
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
    const report = (await service.importPdf(source('tied-date-context')))!.report;
    await prepareSanitizedExtraction(service, report.id);
    const draft = await service.startExtraction(report.id);
    const row = draft.rows[0];

    assert.deepEqual(draft.collectionDate, { kind: 'missing' });
    assert.deepEqual(row?.collectionDate, { kind: 'missing' });
    assert.equal(row?.collectionDateContext?.ambiguous, true);
    assert.equal(row?.collectionDateContext?.labelObservationId, undefined);
    assert.deepEqual(row?.source.observationIds, ['tie-measurement']);
  });

  test('leaves report, birth, conflicting, ambiguous, invalid, and unlabeled dates missing', async () => {
    const cases = [
      {
        name: 'report-and-birth',
        header: 'Report date 2026-08-28  Date of birth 1990-01-01',
        expectedReason: 'defaulted-collection-date',
      },
      {
        name: 'conflicting-collection',
        header: 'Collected 22.08.2026 Collected 23.08.2026',
        expectedReason: 'ambiguous-date',
      },
      {
        name: 'ambiguous-collection',
        header: 'Collected 01/02/2026',
        expectedReason: 'ambiguous-date',
      },
      {
        name: 'invalid-collection',
        header: 'Collected 31.02.2026',
        expectedReason: 'ambiguous-date',
      },
      {
        name: 'missing-collection-label',
        header: '22.08.2026',
        expectedReason: 'defaulted-collection-date',
      },
    ] as const;

    for (const testCase of cases) {
      const repository = createRepository();
      const files = new FakeFiles();
      const observations = [
        syntheticDateObservation(`missing-${testCase.name}-header`, testCase.header, 0.08, 0.1),
        syntheticDateObservation(
          `missing-${testCase.name}-measurement`,
          'LDL-C 3,8 mmol/L',
          0.08,
          0.22,
        ),
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
      const report = (await service.importPdf(source(`missing-${testCase.name}`)))!.report;
      await prepareSanitizedExtraction(service, report.id);
      const draft = await service.startExtraction(report.id);
      const row = draft.rows[0];

      const expectedDate =
        testCase.expectedReason === 'defaulted-collection-date'
          ? {
              kind: 'known' as const,
              value: draft.collectionDate.kind === 'known' ? draft.collectionDate.value : '',
            }
          : { kind: 'missing' as const };
      assert.equal(draft.collectionDate.kind, expectedDate.kind, testCase.name);
      assert.equal(row?.collectionDate.kind, expectedDate.kind, testCase.name);
      assert.ok(row?.reviewReasons.includes(testCase.expectedReason), testCase.name);
      if (testCase.expectedReason === 'defaulted-collection-date') {
        assert.equal(row?.collectionDateContext, null, testCase.name);
        assert.equal(row?.source.raw?.collectionDate, null, testCase.name);
      } else {
        assert.equal(row?.collectionDateContext?.ambiguous, true, testCase.name);
      }
      assert.deepEqual(
        row?.source.observationIds,
        [`missing-${testCase.name}-measurement`],
        testCase.name,
      );
      assert.equal(row?.proposedBiomarkerId, 'biomarker.ldl_c', testCase.name);
      assert.deepEqual(row?.proposedValue, { kind: 'numeric', value: 3.8 }, testCase.name);
      assert.equal(row?.proposedUnit, 'mmol/L', testCase.name);
    }
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

  test('uses trusted PDF text per page and falls back to Vision only for unavailable pages', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf();
    pdf.textLayerResults.set(0, syntheticExtractionResult(0, 'pdf-trusted', 'LDL-C 3.8 mmol/L'));
    pdf.textLayerResults.set(1, null);
    const visionPages: number[] = [];
    const service = createService(repository, files, pdf, {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        visionPages.push(pageIndex);
        return syntheticExtractionResult(pageIndex, 'vision-fallback', 'HDL-C 1.2 mmol/L');
      },
    });
    const report = (await service.importPdf(source('pdf-text-layer-fallback')))!.report;

    const draft = await service.startExtraction(report.id);

    assert.deepEqual(pdf.textLayerCalls, [0, 1]);
    assert.deepEqual(visionPages, [1]);
    assert.deepEqual(
      draft.rows.map((row) => row.source.pageIndex),
      [0, 1],
    );
    assert.deepEqual(
      draft.rows.map((row) => row.source.observationIds[0]),
      ['pdf-trusted', 'vision-fallback'],
    );
  });

  test('uses a trusted PDF page language for model support without substituting device locale', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf();
    pdf.textLayerResults.set(
      0,
      syntheticExtractionResult(0, 'pdf-german', 'Unbekannte Analyse 3,8 mmol/L', 'de'),
    );
    pdf.textLayerResults.set(
      1,
      decodeVisionOCRResult({
        contractVersion: 'alyte.vision.document.v2',
        pageIndex: 1,
        orientation: 0,
        observations: [
          {
            id: 'pdf-unknown-date-label',
            text: 'Collection date',
            alternatives: [],
            boundingBox: { x: 0.1, y: 0.05, width: 0.2, height: 0.04 },
            pageIndex: 1,
            orientation: 0,
            recognition: { level: 'accurate', language: null, internalConfidence: null },
          },
          {
            id: 'pdf-unknown-date-value',
            text: '2026-08-22',
            alternatives: [],
            boundingBox: { x: 0.32, y: 0.05, width: 0.2, height: 0.04 },
            pageIndex: 1,
            orientation: 0,
            recognition: { level: 'accurate', language: null, internalConfidence: null },
          },
          {
            id: 'pdf-unknown',
            text: 'Novel assay 4.2 mmol/L',
            alternatives: [],
            boundingBox: { x: 0.1, y: 0.2, width: 0.5, height: 0.04 },
            pageIndex: 1,
            orientation: 0,
            recognition: { level: 'accurate', language: null, internalConfidence: null },
          },
        ],
      }),
    );
    const supportedLocales: Array<string | null> = [];
    const mappedLanguages: Array<string | null> = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'language-probe.mapper.v1',
      schemaVersion: 'alyte.semantic-mapper.v1',
      supports: (locale) => {
        supportedLocales.push(locale);
        return locale === 'de';
      },
      async map(input) {
        mappedLanguages.push(input.rows[0]?.observations[0]?.recognition.language ?? null);
        return [];
      },
    };
    const service = createService(repository, files, pdf, undefined, mapper);
    const report = (await service.importPdf(source('pdf-page-language')))!.report;

    const draft = await service.startExtraction(report.id);

    assert.equal(draft.rows.length, 2);
    assert.deepEqual(supportedLocales, ['de', null]);
    assert.deepEqual(mappedLanguages, ['de']);
    assert.equal(
      draft.rows.find((row) => row.source.observationIds.includes('pdf-unknown'))
        ?.collectionDateContext?.locale,
      null,
    );
  });

  test('independently lattices trusted PDF spans while retaining parent provenance and context', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf([{ pageIndex: 0, width: 612, height: 792, hasTextLayer: true }]);
    pdf.textLayerResults.set(0, syntheticTrustedTextLayerResult(0));
    let visionCalls = 0;
    const service = createService(repository, files, pdf, {
      async recognize(): Promise<VisionOCRResult> {
        visionCalls += 1;
        return syntheticExtractionResult(0, 'must-not-run', 'LDL-C 3.8 mmol/L');
      },
    });
    const report = (await service.importPdf(source('trusted-independent-spans')))!.report;

    const draft = await service.startExtraction(report.id);

    assert.deepEqual(pdf.textLayerCalls, [0]);
    assert.equal(visionCalls, 0);
    assert.deepEqual(draft.collectionDate, { kind: 'known', value: '2026-08-22' });
    assert.equal(draft.rows.length, 1);
    const row = draft.rows[0]!;
    assert.equal(row.proposedSpecimenType, 'serum');
    assert.equal(row.collectionDateContext?.observationId, 'trusted-pdf-collection-date');
    assert.equal(row.collectionDateContext?.locale, 'de-DE');
    assert.deepEqual(row.collectionDateContext?.collectionDate, {
      kind: 'known',
      value: '2026-08-22',
    });
    assert.equal(row.collectionDateContext?.sourceText, 'Collection date 22.08.2026');
    assert.equal(row.collectionDateContext?.sourceDate, '22.08.2026');
    assert.equal(row.collectionDateContext?.labelObservationId, 'trusted-pdf-collection-date');
    assert.equal(row.collectionDateContext?.labelText, 'Collection date 22.08.2026');

    const expectedCells = [
      { id: 'trusted-pdf-parent:0:5', start: 0, end: 5, text: 'Serum' },
      { id: 'trusted-pdf-parent:6:11', start: 6, end: 11, text: 'LDL-C' },
      { id: 'trusted-pdf-parent:12:15', start: 12, end: 15, text: '3.8' },
      { id: 'trusted-pdf-parent:16:22', start: 16, end: 22, text: 'mmol/L' },
    ];
    assert.deepEqual(
      row.source.observationIds,
      expectedCells.map((cell) => cell.id),
    );
    assert.deepEqual(
      row.source.observations?.map((observation) => ({
        id: observation.id,
        text: observation.text,
        sourceSpan:
          observation.sourceSpan === undefined
            ? null
            : {
                parentObservationId: observation.sourceSpan.parentObservationId,
                start: observation.sourceSpan.start,
                end: observation.sourceSpan.end,
                text: observation.sourceSpan.text,
                parentText: observation.sourceSpan.parentText,
              },
      })),
      expectedCells.map((cell) => ({
        id: cell.id,
        text: cell.text,
        sourceSpan: {
          parentObservationId: 'trusted-pdf-parent',
          start: cell.start,
          end: cell.end,
          text: cell.text,
          parentText: 'Serum LDL-C 3.8 mmol/L',
        },
      })),
    );
    assert.equal(row.source.raw?.collectionDate, 'Collection date 22.08.2026');
  });

  test('uses a trusted PDF Result header to exclude reference-column numbers', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf([{ pageIndex: 0, width: 612, height: 792, hasTextLayer: true }]);
    pdf.textLayerResults.set(0, syntheticResultColumnPage(0));
    const mappedAnchors: string[] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'trusted-result-column.mapper.v1',
      schemaVersion: 'alyte.geometry-variant-selector.v2',
      maxRowsPerChunk: 2,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        return rows.flatMap((row) => {
          const group = row as GeometryCandidateWindowGroup;
          const variant = group.variants[0];
          if (variant === undefined) return [];
          mappedAnchors.push(variant.anchorCellId);
          return [
            {
              sourceObservationIds: [...group.sourceObservationIds],
              sourceFields: { ...variant.provisionalSourceFields },
              proposedBiomarkerId: null,
              role: 'preserve' as const,
            },
          ];
        });
      },
    };
    const service = createService(repository, files, { pdf, semanticMapper: mapper });
    const report = (await service.importPdf(source('trusted-result-column')))!.report;

    const draft = await service.startExtraction(report.id);

    assert.equal(draft.rows.length, 2);
    assert.deepEqual(mappedAnchors, ['column-a-result', 'column-b-result']);
    assert.deepEqual(
      draft.rows.map((row) => row.sourceValueString),
      ['3.8', '1.2'],
    );
    assert.ok(draft.rows.every((row) => row.sourceValue.kind === 'numeric'));
    assert.ok(draft.rows.every((row) => !['2.0', '0.9'].includes(row.sourceValueString)));
  });

  test('keeps dense trusted PDF source lines separate before Result-column admission', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf([{ pageIndex: 0, width: 612, height: 792, hasTextLayer: true }]);
    pdf.textLayerResults.set(0, syntheticDenseTrustedResultColumnPage(0));
    const mappedAnchors: string[] = [];
    const mapper: ExtractionSemanticMapper = {
      adapterVersion: 'dense-trusted-result-column.mapper.v1',
      schemaVersion: 'alyte.geometry-variant-selector.v2',
      maxRowsPerChunk: 2,
      maxObservationsPerChunk: 24,
      supports: () => true,
      async map({ rows }) {
        return rows.flatMap((row) => {
          const group = row as GeometryCandidateWindowGroup;
          const variant = group.variants[0];
          if (variant === undefined) return [];
          mappedAnchors.push(variant.anchorCellId);
          return [
            {
              sourceObservationIds: [...group.sourceObservationIds],
              sourceFields: { ...variant.provisionalSourceFields },
              proposedBiomarkerId: null,
              role: 'preserve' as const,
            },
          ];
        });
      },
    };
    const service = createService(repository, files, { pdf, semanticMapper: mapper });
    const report = (await service.importPdf(source('dense-trusted-result-lines')))!.report;

    const draft = await service.startExtraction(report.id);

    assert.equal(draft.rows.length, 2);
    assert.deepEqual(mappedAnchors, ['dense-column-a:6:9', 'dense-column-b:6:9']);
    assert.deepEqual(
      draft.rows.map((row) => row.sourceValueString),
      ['3.8', '1.2'],
    );
    assert.ok(draft.rows.every((row) => row.sourceValue.kind === 'numeric'));
    assert.ok(draft.rows.every((row) => !['2.0', '0.9'].includes(row.sourceValueString)));
  });

  test('preserves an unrepresented trusted Result-column row as focused review work', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf([{ pageIndex: 0, width: 612, height: 792, hasTextLayer: true }]);
    pdf.textLayerResults.set(0, syntheticResultColumnPage(0, true));
    const service = createService(repository, files, pdf);
    const report = (await service.importPdf(source('trusted-unrepresented-result')))!.report;

    const draft = await service.startExtraction(report.id);

    const review = draft.rows.find((row) =>
      row.source.observationIds.includes('column-unrepresented-result'),
    );
    assert.ok(review);
    assert.equal(review.reviewState, 'needs-review');
    assert.equal(review.decision, 'preserve');
    assert.equal(review.sourceValue.kind, 'free_text');
    assert.ok(review.reviewReasons.includes('unsupported-layout'));
  });

  test('keeps an admitted but label-ambiguous Result-column row review-only', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf([{ pageIndex: 0, width: 612, height: 792, hasTextLayer: true }]);
    pdf.textLayerResults.set(0, syntheticResultColumnPage(0, false, true));
    const service = createService(repository, files, pdf);
    const report = (await service.importPdf(source('trusted-ambiguous-result')))!.report;

    const draft = await service.startExtraction(report.id);

    const review = draft.rows.find((row) =>
      row.source.observationIds.includes('column-ambiguous-result'),
    );
    assert.ok(review);
    assert.equal(review.reviewState, 'needs-review');
    assert.equal(review.decision, 'preserve');
    assert.ok(
      [
        'column-ambiguous-label-a',
        'column-ambiguous-label-b',
        'column-ambiguous-label-c',
        'column-ambiguous-label-d',
        'column-ambiguous-result',
      ].every((id) => review.source.observationIds.includes(id)),
    );
  });

  test('does not apply the PDF-only Result corridor to a Vision image page', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const service = createService(repository, files, new FakePdf(), {
      async recognize(): Promise<VisionOCRResult> {
        return syntheticResultColumnPage(0);
      },
    });
    const report = (await service.importImages(source('vision-result-column', 'image')))!.report;

    const draft = await service.startExtraction(report.id);

    assert.equal(draft.rows.length, 2);
    assert.ok(draft.rows.every((row) => row.reviewState === 'needs-review'));
    assert.ok(draft.rows.every((row) => row.sourceValue.kind === 'free_text'));
  });

  test('does not call PDFKit for an absent adapter or a page without a text layer', async () => {
    const pagesWithoutText = pdfInspection.pages.map((page) => ({ ...page, hasTextLayer: false }));
    for (const pdf of [new FakePdf(), new TextLayerPdf(pagesWithoutText)]) {
      const repository = createRepository();
      const files = new FakeFiles();
      const visionPages: number[] = [];
      const service = createService(repository, files, pdf, {
        async recognize(_path, pageIndex): Promise<VisionOCRResult> {
          visionPages.push(pageIndex);
          return syntheticExtractionResult(
            pageIndex,
            `vision-only-${pageIndex}`,
            'LDL-C 3.8 mmol/L',
          );
        },
      });
      const report = (await service.importPdf(source(`pdf-vision-only-${visionPages.length}`)))!
        .report;

      const draft = await service.startExtraction(report.id);

      if (pdf instanceof TextLayerPdf) assert.deepEqual(pdf.textLayerCalls, []);
      assert.deepEqual(visionPages, [0, 1]);
      assert.deepEqual(
        draft.rows.map((row) => row.source.pageIndex),
        [0, 1],
      );
    }
  });

  test('keeps a locked PDF session open through page reads and closes it on success and error', async () => {
    const successRepository = createRepository();
    const successFiles = new FakeFiles();
    const successPdf = new LockedTextLayerPdf();
    successPdf.textLayerResults.set(
      0,
      syntheticExtractionResult(0, 'locked-0', 'LDL-C 3.8 mmol/L'),
    );
    successPdf.textLayerResults.set(
      1,
      syntheticExtractionResult(1, 'locked-1', 'HDL-C 1.2 mmol/L'),
    );
    const successService = createService(successRepository, successFiles, successPdf);
    const successReport = (await successService.importPdf(
      source('locked-session-success'),
      async () => 'correct horse',
    ))!.report;

    await successService.startExtraction(successReport.id, async () => 'correct horse');

    const successSession = successPdf.sessions[successPdf.sessions.length - 1]!;
    assert.deepEqual(successSession.reads, [0, 1]);
    assert.equal(successSession.readWhileClosed, false);
    assert.equal(successSession.closed, true);
    assert.equal(successSession.closeCalls, 1);

    const errorRepository = createRepository();
    const errorFiles = new FakeFiles();
    const errorPdf = new LockedTextLayerPdf();
    errorPdf.sessionTextLayerError = new Error('malformed trusted page');
    const errorService = createService(errorRepository, errorFiles, errorPdf);
    const errorReport = (await errorService.importPdf(
      source('locked-session-error'),
      async () => 'correct horse',
    ))!.report;

    await assert.rejects(
      errorService.startExtraction(errorReport.id, async () => 'correct horse'),
      (error: unknown) =>
        error instanceof LabReportExtractionError && error.reason === 'recognition',
    );
    const errorSession = errorPdf.sessions[errorPdf.sessions.length - 1]!;
    assert.deepEqual(errorSession.reads, [0]);
    assert.equal(errorSession.readWhileClosed, false);
    assert.equal(errorSession.closed, true);
    assert.equal(errorSession.closeCalls, 1);
  });

  test('discards all page results when the Original changes after PDFKit or Vision', async () => {
    const pdfRepository = createRepository();
    const pdfFiles = new FakeFiles();
    const pdf = new TextLayerPdf();
    pdf.textLayerResults.set(0, syntheticExtractionResult(0, 'mutated-pdf', 'LDL-C 3.8 mmol/L'));
    let pdfVisionCalls = 0;
    const pdfService = createService(pdfRepository, pdfFiles, pdf, {
      async recognize(): Promise<VisionOCRResult> {
        pdfVisionCalls += 1;
        return syntheticExtractionResult(0, 'must-not-run', 'LDL-C 3.8 mmol/L');
      },
    });
    const pdfReport = (await pdfService.importPdf(source('mutated-after-pdfkit')))!.report;
    pdf.onTextLayerRead = () => {
      pdfFiles.files.set(pdfReport.originalPath!, { hash: 'tampered-pdfkit', size: 42 });
    };

    await assert.rejects(
      pdfService.startExtraction(pdfReport.id),
      (error: unknown) =>
        error instanceof LabReportExtractionError && error.reason === 'original-source',
    );
    assert.deepEqual(pdf.textLayerCalls, [0]);
    assert.equal(pdfVisionCalls, 0);
    assert.equal(await pdfRepository.getExtractionDraftForReport(pdfReport.id), null);

    const visionRepository = createRepository();
    const visionFiles = new FakeFiles();
    const visionPdf = new FakePdf();
    let visionCalls = 0;
    let visionOriginalPath: string | null = null;
    const visionService = createService(visionRepository, visionFiles, visionPdf, {
      async recognize(): Promise<VisionOCRResult> {
        visionCalls += 1;
        if (visionOriginalPath !== null)
          visionFiles.files.set(visionOriginalPath, { hash: 'tampered-vision', size: 42 });
        return syntheticExtractionResult(0, 'mutated-vision', 'LDL-C 3.8 mmol/L');
      },
    });
    const visionReport = (await visionService.importPdf(source('mutated-after-vision')))!.report;
    visionOriginalPath = visionReport.originalPath;

    await assert.rejects(
      visionService.startExtraction(visionReport.id),
      (error: unknown) =>
        error instanceof LabReportExtractionError && error.reason === 'original-source',
    );
    assert.equal(visionCalls, 1);
    assert.equal(await visionRepository.getExtractionDraftForReport(visionReport.id), null);
  });

  test('treats a thrown PDFKit result as recognition failure without Vision fallback', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new TextLayerPdf();
    pdf.textLayerError = new Error('malformed trusted envelope');
    let visionCalls = 0;
    const service = createService(repository, files, pdf, {
      async recognize(): Promise<VisionOCRResult> {
        visionCalls += 1;
        return syntheticExtractionResult(0, 'must-not-run', 'LDL-C 3.8 mmol/L');
      },
    });
    const report = (await service.importPdf(source('malformed-pdfkit-result')))!.report;

    await assert.rejects(
      service.startExtraction(report.id),
      (error: unknown) =>
        error instanceof LabReportExtractionError && error.reason === 'recognition',
    );
    assert.equal(visionCalls, 0);
    assert.equal(await repository.getExtractionDraftForReport(report.id), null);
  });

  test('uses the PDF text-layer adapter in PDF fingerprints but not image fingerprints', async () => {
    const pdfRepository = createRepository();
    const pdfFiles = new FakeFiles();
    const pdf = new TextLayerPdf();
    const pdfService = createService(pdfRepository, pdfFiles, pdf, {
      async recognize(_path, pageIndex): Promise<VisionOCRResult> {
        return syntheticExtractionResult(
          pageIndex,
          `pdf-fingerprint-${pageIndex}`,
          'LDL-C 3.8 mmol/L',
        );
      },
    });
    const pdfReport = (await pdfService.importPdf(source('pdf-fingerprint')))!.report;
    const pdfDraft = await pdfService.startExtraction(pdfReport.id);
    assert.equal(
      pdfDraft.pipelineFingerprint?.pdfTextLayerAdapterVersion,
      'alyte.pdf.text-layer.v3',
    );

    const imageRepository = createRepository();
    const imageFiles = new FakeFiles();
    const imageService = createService(imageRepository, imageFiles, new FakePdf(), {
      async recognize(): Promise<VisionOCRResult> {
        return syntheticExtractionResult(0, 'image-fingerprint', 'LDL-C 3.8 mmol/L');
      },
    });
    const imageReport = (await imageService.importImages(source('image-fingerprint', 'image')))!
      .report;
    const imageDraft = await imageService.startExtraction(imageReport.id);
    assert.equal(imageDraft.pipelineFingerprint?.pdfTextLayerAdapterVersion, null);
  });

  test('fingerprints a trusted PDF adapter exposed only by an unlocked session', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const pdf = new SessionOnlyTextLayerPdf();
    const service = createService(repository, files, pdf);
    const report = (await service.importPdf(
      source('session-only-fingerprint'),
      async () => 'correct horse',
    ))!.report;

    const draft = await service.startExtraction(report.id, async () => 'correct horse');

    assert.equal(draft.pipelineFingerprint?.pdfTextLayerAdapterVersion, 'alyte.pdf.text-layer.v3');
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
      ['import', 'ocr', 'review'],
    );
    assert.equal(
      events.some((event) => event.stage === 'ocr' && event.status === 'complete'),
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
      pipelineFingerprint: createExtractionPipelineFingerprint(
        {
          sourceHash: report.sourceHash,
          ocrContractVersion: VISION_OCR_CONTRACT_VERSION,
          rowSegmentationVersion: EXTRACTION_ROW_SEGMENTATION_VERSION,
          parserVersion: EXTRACTION_PARSER_VERSION,
          semanticAdapterVersion: null,
          semanticSchemaVersion: null,
          semanticChunkVersion: null,
          semanticPromptVersion: null,
          modelVersion: null,
          runtimeVersion: null,
          catalogueVersion: CATALOGUE_VERSION,
          pdfTextLayerAdapterVersion: null,
        },
        1,
      ),
      revision: 1,
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

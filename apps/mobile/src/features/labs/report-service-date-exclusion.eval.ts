import {
  createSortableOpaqueId,
  createSanitizationRecipe,
  type LabReport,
  type LabDateState,
  type LabRecord,
  type LabReportSourceIntegrity,
  type LabSourceArtifact,
  type SanitizationRecipe,
  type SanitizedReport,
  type SanitizedReportVerification,
  type SensitiveRegionSuggestion,
  normalizePageRotation,
  sanitizationRecipeHash,
} from '../../../../../packages/domain/src/index-date-exclusion.eval';
import {
  groupObservationsIntoRows,
  extractOCRDateContexts,
  buildGeometryCandidateWindows,
  groupGeometryCandidateWindows,
  admitGeometryCandidateGroupsByResultColumn,
  isNonMeasurementMetadataText,
  parseGeometryCandidateVariantAsProvisional,
  enumerateGeometryFieldCandidates,
  proposeBiomarkerId,
  reconstructGeometryLattice,
  reparseExtractionRowFromSemanticFields,
  revalidateExtractionRow,
  sortExtractionSemanticCandidateRows,
  validateSemanticProposals,
  type ExtractionAliasEntry,
  type ExtractionDraft,
  type ExtractionDraftRow,
  type ExtractionDraftRowPatch,
  type ExtractionDateContext,
  type ExtractionSemanticCandidateRow,
  type ExtractionSemanticCancellation,
  type ExtractionSemanticFieldSelection,
  type ExtractionSemanticLease,
  type ExtractionSemanticMapper,
  type ExtractionSemanticProposal,
  type VisionTextObservation,
  type VisionOCRResult,
  type SpecimenType,
  type ExtractionPipelineFingerprint,
  type OCRDateContextObservation,
  type GeometryRow,
  type GeometryCandidateWindowGroup,
  type GeometrySourceObservation,
  type NormalizedBoundingBox,
  type VisionSourceSpan,
  createExtractionPipelineFingerprint,
  PDF_TEXT_LAYER_ADAPTER_VERSION,
  EXTRACTION_ROW_SEGMENTATION_VERSION,
  EXTRACTION_PARSER_VERSION,
  VISION_OCR_CONTRACT_VERSION,
} from '../../../../../packages/domain/src/index-date-exclusion.eval';
import { CATALOGUE_VERSION, comparableBiomarkers } from '@alyte/catalogue';
import {
  openProtectedLabDatabase,
  type ExtractionDraftRowUpdateOptions,
  type LabReportExtractionOperation,
  type LabRepository,
} from './persistence';
import {
  createProtectedReportFileService,
  deleteProtectedReportArtifacts,
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import {
  createSystemLabSourcePicker,
  LabSourceSelectionError,
  type LabSourcePicker,
} from './pickers';
import {
  nativePdfInspector,
  type PdfInspection,
  type PdfInspector,
  type PdfInspectionSession,
  type PdfSanitizationResult,
  type PdfSanitizedVerification,
  type PdfViewerSession,
} from './pdf';
import {
  nativeImageInspector,
  type ImageInspector,
  type ImageSanitizationResult,
  type ImageSanitizedVerification,
} from './image';
import { nativeVisionOCR, type VisionOCR } from './vision';
import {
  createSemanticMapperPrompt,
  serializeSemanticMapperChunk,
} from '../local-models/semantic-contract';
import {
  createGeometryVariantSelectorPrompt,
  GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION,
  serializeGeometryVariantSelectorChunk,
} from '../local-models/geometry-variant-contract';
import {
  DocumentVLMUnavailableError,
  type DocumentVLMExtractor,
  type DocumentVLMRow,
} from '../local-models/document-vlm';
import { groundDocumentVLMRows } from '../local-models/document-vlm-grounding';

export type PasswordRequest = (context: {
  readonly report: LabReport;
  readonly attempt: number;
}) => Promise<string | null>;

type ExtractionOperationToken = {
  readonly generation: number;
  cancelled: boolean;
  readonly cancellationListeners: Set<() => void>;
};

function cancelExtractionOperation(token: ExtractionOperationToken): void {
  if (token.cancelled) return;
  token.cancelled = true;
  const listeners = [...token.cancellationListeners];
  token.cancellationListeners.clear();
  for (const listener of listeners) {
    try {
      listener();
    } catch {
      // Cancellation is best-effort; the extraction still observes the token at its next seam.
    }
  }
}

export type LabReportImportResult = {
  readonly report: LabReport;
  readonly duplicate: boolean;
  /**
   * The next local destination for this import. Duplicate sources resolve against the existing
   * draft state so the UI never re-enters extraction just to discover that work already exists.
   */
  readonly destination: LabReportImportDestination;
};

export type LabReportImportDestination =
  | { readonly kind: 'extraction-progress' }
  | { readonly kind: 'extraction-draft'; readonly draftId: string }
  | { readonly kind: 'report-detail' };

export type LabReportExtractionDraftReference = {
  readonly reportId: string;
  readonly draftId: string;
};

/**
 * Decide where an import should land without treating a confirmed draft as open review work.
 * This is intentionally pure so the duplicate-source state boundary stays easy to verify.
 */
export function resolveLabReportImportDestination(
  duplicate: boolean,
  existingDraft: Pick<ExtractionDraft, 'id' | 'state'> | null,
): LabReportImportDestination {
  if (!duplicate) return { kind: 'extraction-progress' };
  if (existingDraft?.state === 'draft') {
    return { kind: 'extraction-draft', draftId: existingDraft.id };
  }
  return { kind: 'report-detail' };
}

export type LabReportPreview = {
  readonly sourceType: LabReport['sourceType'];
  /** A protected file URI for images or short-lived local data URIs for rendered PDF pages. */
  readonly uris: readonly string[];
};

/**
 * A read-only native viewer capability. The protected path never crosses into the screen; the
 * native PDFKit/UIKit view resolves this opaque session lazily and releases it on close.
 */
export type OriginalReportViewerSession = {
  readonly sourceType: LabReport['sourceType'];
  readonly pageCount: number;
  readonly sessionId: string;
  close(): Promise<void>;
};

export type SanitizedReportPreview = {
  readonly sourceType: LabReport['sourceType'];
  readonly artifactPath: string;
  readonly artifactHash: string;
  /** Rendered from the same verified artifactPath that upload/export receives. */
  readonly uris: readonly string[];
  readonly verification: PdfSanitizedVerification | ImageSanitizedVerification;
};

export type LabReportExtractionReadiness = {
  /** True only when previewSanitizedReport completed the full current-artifact verification. */
  readonly ready: boolean;
  readonly status: 'verified' | 'missing' | 'unverified' | 'failed';
};

export type LabReportExtractionProgress = {
  readonly reportId: string;
  readonly mode: LabReportExtractionMode;
  readonly stage: 'import' | 'ocr' | 'organize' | 'refine' | 'review';
  readonly status: 'active' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  readonly completed: number;
  readonly total: number;
  readonly error?: LabReportExtractionError['reason'];
};

export type LabReportExtractionMode = 'start' | 'reprocess' | 'improve';

export type SanitizationEditorState = {
  readonly report: LabReport;
  /** Resolved protected source path used only by the native PDFKit workspace. */
  readonly sourcePath: string;
  readonly recipe: SanitizationRecipe;
  readonly suggestions: readonly SensitiveRegionSuggestion[];
  readonly pagePreviewUris: readonly string[];
  readonly current: SanitizedReport | null;
};

export class LabReportImportError extends Error {
  override readonly name = 'LabReportImportError';
  readonly report: LabReport;
  readonly reason: 'cancelled' | 'wrong-password' | 'malformed' | 'protection' | 'failed';

  constructor(
    report: LabReport,
    reason: LabReportImportError['reason'],
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.report = report;
    this.reason = reason;
  }
}

/**
 * Selection validation happens before a Lab Report is created. This keeps hostile or stale
 * picker adapters from turning an unsupported multi-image result into hidden local reports.
 */
export { LabSourceSelectionError as LabReportSelectionError } from './pickers';

export class LabReportSanitizationError extends Error {
  override readonly name = 'LabReportSanitizationError';
  readonly reportId: string;

  constructor(reportId: string, message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.reportId = reportId;
  }
}

export class LabReportExtractionError extends Error {
  override readonly name = 'LabReportExtractionError';

  constructor(
    readonly reason:
      | 'sanitized-source'
      | 'recognition'
      | 'no-reviewable-measurements'
      | 'original-source'
      | 'persistence'
      | 'wrong-password'
      | 'model-unavailable'
      | 'cancelled'
      | 'interrupted'
      | 'improve-deferred',
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
  }
}

export type LabReportsService = {
  listReports(): Promise<readonly LabReport[]>;
  getReport(id: string): Promise<LabReport | null>;
  importPdf(
    source?: LabSourceSelection,
    passwordRequest?: PasswordRequest,
  ): Promise<LabReportImportResult | null>;
  importImages(
    source?: LabSourceSelection,
    passwordRequest?: PasswordRequest,
  ): Promise<LabReportImportResult | null>;
  retryImport(id: string, passwordRequest?: PasswordRequest): Promise<LabReport>;
  verifySource(id: string): Promise<LabReportSourceIntegrity>;
  openOriginal(id: string): Promise<string>;
  previewOriginal(id: string, passwordRequest?: PasswordRequest): Promise<LabReportPreview>;
  openOriginalViewer(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<OriginalReportViewerSession>;
  openSanitizationEditor(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<SanitizationEditorState>;
  closeSanitizationEditor(id: string): Promise<void>;
  saveSanitizedReport(id: string, recipe: SanitizationRecipe): Promise<SanitizedReport>;
  saveSanitizationDraft(id: string, recipe: SanitizationRecipe): Promise<void>;
  discardSanitizationDraft(id: string): Promise<void>;
  previewSanitizedReport(id: string): Promise<SanitizedReportPreview>;
  getExtractionReadiness(id: string): Promise<LabReportExtractionReadiness>;
  subscribeExtractionProgress(
    listener: (progress: LabReportExtractionProgress) => void,
  ): () => void;
  getExtractionProgress(id: string): LabReportExtractionProgress | null;
  loadExtractionProgress(id: string): Promise<LabReportExtractionProgress | null>;
  cancelExtraction(id: string): Promise<void>;
  getSanitizedReport(id: string): Promise<SanitizedReport | null>;
  deleteSanitizedReport(id: string): Promise<void>;
  deleteReport(id: string): Promise<void>;
  startExtraction(id: string, passwordRequest?: PasswordRequest): Promise<ExtractionDraft>;
  /** Explicitly rebuilds the review revision from the immutable Original Report. */
  reprocessExtraction(id: string, passwordRequest?: PasswordRequest): Promise<ExtractionDraft>;
  /** Refines only stored, unresolved, automatic source-cell rows; never reruns OCR. */
  improveExtraction(id: string): Promise<ExtractionDraft>;
  listOpenExtractionDrafts(): Promise<readonly LabReportExtractionDraftReference[]>;
  countOpenExtractionDrafts(): Promise<number>;
  getExtractionDraft(id: string): Promise<ExtractionDraft | null>;
  /** Discards only an open extraction draft; the immutable Original Report remains available. */
  discardExtractionDraft(id: string): Promise<void>;
  updateExtractionRow(
    id: string,
    patch: ExtractionDraftRowPatch,
    options?: ExtractionDraftRowUpdateOptions,
  ): Promise<ExtractionDraftRow>;
  updateExtractionGroupDate(
    draftId: string,
    currentDate: LabDateState,
    specimenType: SpecimenType,
    collectionDate: LabDateState,
  ): Promise<ExtractionDraft>;
  confirmExtraction(id: string): Promise<readonly LabRecord[]>;
};

export type LabReportsServiceOptions = {
  readonly repositoryFactory?: () => Promise<LabRepository>;
  readonly fileService?: ProtectedReportFileService;
  readonly picker?: LabSourcePicker;
  readonly pdfInspector?: PdfInspector;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
  readonly passwordRequest?: PasswordRequest;
  readonly visionOCR?: VisionOCR;
  readonly imageInspector?: ImageInspector;
  readonly extractionAliases?: readonly ExtractionAliasEntry[];
  readonly semanticMapper?: ExtractionSemanticMapper;
  readonly documentVLM?: DocumentVLMExtractor;
  /** Test seam for the bounded document-model stage. */
  readonly documentRefinementBudgetMs?: number;
  /** Elapsed-time clock; unlike `now`, this value is never persisted. */
  readonly elapsedTimeNow?: () => number;
};

/**
 * The app's one catalogue-to-extraction adapter. Tests and semantic adapters must use the same
 * projection as the running service so an alias or method-policy change cannot silently leave
 * fixture coverage behind.
 */
export function createDefaultExtractionAliases(): readonly ExtractionAliasEntry[] {
  return comparableBiomarkers.map((entry) => ({
    id: entry.id,
    ...(entry.canonicalLabel === undefined ? {} : { canonicalLabel: entry.canonicalLabel }),
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
  }));
}

type ImportOutcome = LabReportImportResult;

type ExtractionPageResultOrigin = 'trusted-pdf-text-layer' | 'vision';

type ExtractionPageResult = {
  readonly result: VisionOCRResult;
  readonly origin: ExtractionPageResultOrigin;
};

const DOCUMENT_REFINEMENT_BUDGET_MS = 90_000;
const DOCUMENT_REFINEMENT_MIN_REQUEST_MS = 2_000;
const DOCUMENT_REFINEMENT_MIN_OUTPUT_TOKENS = 384;
const DOCUMENT_REFINEMENT_TOKENS_PER_ANCHOR = 80;

function extractionObservationKey(
  observation: Pick<VisionTextObservation, 'pageIndex' | 'id'>,
): string {
  return `${observation.pageIndex}:${observation.id}`;
}

function isLabSourceSelection(value: unknown): value is LabSourceSelection {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<LabSourceSelection>;
  return (
    typeof candidate.uri === 'string' &&
    candidate.uri.length > 0 &&
    typeof candidate.name === 'string' &&
    candidate.name.length > 0 &&
    typeof candidate.mimeType === 'string' &&
    candidate.mimeType.length > 0 &&
    (candidate.sourceType === 'image' || candidate.sourceType === 'pdf')
  );
}

function singleImageSelection(value: unknown): LabSourceSelection | null {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.length !== 1) {
      throw new LabSourceSelectionError(
        'multiple-images',
        'Choose one report image at a time; each image becomes one Lab Report',
      );
    }
    return singleImageSelection(value[0]);
  }
  if (!isLabSourceSelection(value) || value.sourceType !== 'image') {
    throw new LabSourceSelectionError('invalid-image', 'The selected item is not a report image');
  }
  return value;
}

function isoNow(): string {
  return new Date().toISOString();
}

/**
 * Derive the fallback from the device's local calendar. UTC slicing would move the Lab Record
 * across a day for users west or east of Greenwich around local midnight.
 */
export function localCalendarDateFromInstant(instant: string): LabDateState {
  const date = new Date(instant);
  if (Number.isNaN(date.getTime())) return { kind: 'missing' };
  return {
    kind: 'known',
    value: `${date.getFullYear().toString().padStart(4, '0')}-${(date.getMonth() + 1)
      .toString()
      .padStart(2, '0')}-${date.getDate().toString().padStart(2, '0')}`,
  };
}

/**
 * Removes only rows replaced by a promoted physical group. Shared labels or adjacent source
 * observations are not enough: the complete immutable source sequence must match, or a
 * deterministic subset must contain the group's exact selected anchor.
 */
export function retainRowsOutsidePromotedPhysicalGroups<
  T extends { readonly source: { readonly observationIds: readonly string[] } },
>(rows: readonly T[], promotedRows: readonly T[]): readonly T[] {
  type PromotedSource = {
    readonly observationIds: readonly string[];
    readonly semantic?: {
      readonly sourceFieldObservationIds?: { readonly value?: string };
    } | null;
  };
  const promotedGroups = promotedRows.map((row) => {
    const source = row.source as PromotedSource;
    return {
      sourceIds: new Set(source.observationIds),
      sourceKey: JSON.stringify(source.observationIds),
      anchorIds: new Set(
        source.semantic?.sourceFieldObservationIds?.value === undefined
          ? []
          : [source.semantic.sourceFieldObservationIds.value],
      ),
    };
  });
  return rows.filter((row) => {
    const sourceIds = row.source.observationIds;
    const sourceKey = JSON.stringify(sourceIds);
    return !promotedGroups.some((group) => {
      if (group.sourceKey === sourceKey) return true;
      // Deterministic parsing can leave a value/unit subset beside a promoted semantic group.
      // Remove that subset only when it contains the exact selected anchor; an adjacent row that
      // merely shares a label observation remains independently reviewable.
      return (
        group.anchorIds.size > 0 &&
        sourceIds.length < group.sourceIds.size &&
        sourceIds.every((sourceId) => group.sourceIds.has(sourceId)) &&
        sourceIds.some((sourceId) => group.anchorIds.has(sourceId))
      );
    });
  });
}

function isCancellation(error: unknown): boolean {
  return error instanceof LabReportImportError && error.reason === 'cancelled';
}

function classifyFailure(error: unknown): LabReportImportError['reason'] {
  if (isCancellation(error)) return 'cancelled';
  if (error instanceof LabReportImportError) return error.reason;
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  if (message.includes('password') || message.includes('unlock')) return 'wrong-password';
  if (message.includes('pdf') || message.includes('readable') || message.includes('malformed')) {
    return 'malformed';
  }
  if (message.includes('protect') || message.includes('storage')) return 'protection';
  return 'failed';
}

function isPdfPasswordFailure(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return message.includes('password') || message.includes('unlock') || message.includes('locked');
}

function isSemanticModelUnavailable(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { readonly code?: unknown }).code === 'semantic-model-unavailable'
  );
}

function viewerPageCount(value: number): number {
  if (!Number.isInteger(value) || value < 1) throw new Error('The PDF has no pages');
  return value;
}

function pageInputs(inspection: PdfInspection) {
  return inspection.pages.map((page) => ({
    pageIndex: page.pageIndex,
    width: page.width,
    height: page.height,
    rotation: 0,
    crop: null,
    derivedPath: null,
  }));
}

function recipeForReport(report: LabReport): SanitizationRecipe {
  return createSanitizationRecipe(
    report.id,
    report.pages.map((page) => ({
      pageIndex: page.pageIndex,
      selected: true,
      crop: page.crop === null ? null : JSON.parse(page.crop),
      rotation: normalizePageRotation(page.rotation),
      redactions: [],
    })),
  );
}

function verificationForSanitizedReport(
  verification: PdfSanitizedVerification | ImageSanitizedVerification,
): SanitizedReportVerification {
  return {
    selectableText: verification.selectableText,
    annotations: verification.annotations,
    attachments: verification.attachments,
    metadata: verification.metadata,
    removableRedactions: verification.removableRedactions,
    reloadChecked: verification.reloadChecked,
    sourceAwareChecked: verification.sourceAwareChecked,
    sourceContentRemoved: verification.sourceContentRemoved,
    verificationVersion: verification.verificationVersion,
  };
}

type StructuralVerificationFacts = Pick<
  PdfSanitizedVerification,
  | 'selectableText'
  | 'annotations'
  | 'attachments'
  | 'metadata'
  | 'removableRedactions'
  | 'reloadChecked'
>;

function structuralFactsPassed(verification: StructuralVerificationFacts): boolean {
  return (
    verification.selectableText === false &&
    verification.annotations === false &&
    verification.attachments === false &&
    verification.metadata === false &&
    verification.removableRedactions === false &&
    verification.reloadChecked === true
  );
}

function verificationPassed(
  verification: PdfSanitizedVerification | ImageSanitizedVerification,
  sourceType: LabReport['sourceType'],
): boolean {
  return (
    verification.verified === true &&
    structuralFactsPassed(verification) &&
    verification.sourceAwareChecked === true &&
    verification.sourceContentRemoved === true &&
    verification.verificationVersion ===
      (sourceType === 'image' ? 'image-source-aware-v2' : 'source-aware-v1') &&
    verification.failureReasons.length === 0
  );
}

/**
 * A standalone PDF recheck has no Original Report evidence to compare against. The persisted
 * source-aware result remains the authoritative render-time gate; this predicate only confirms
 * that the current derivative is still structurally safe to preview.
 */
function structuralVerificationPassed(verification: PdfSanitizedVerification): boolean {
  return (
    verification.verified === true &&
    structuralFactsPassed(verification) &&
    verification.failureReasons.length === 0
  );
}

function persistedVerificationPassed(
  verification: SanitizedReportVerification | null,
  sourceType: LabReport['sourceType'],
): boolean {
  return (
    verification !== null &&
    structuralFactsPassed(verification) &&
    verification.sourceAwareChecked === true &&
    verification.sourceContentRemoved === true &&
    verification.verificationVersion ===
      (sourceType === 'image' ? 'image-source-aware-v2' : 'source-aware-v1')
  );
}

export function createLabReportsService(options: LabReportsServiceOptions = {}): LabReportsService {
  let repositoryPromise: Promise<LabRepository> | null = null;
  let initialized = false;
  let initializationPromise: Promise<void> | null = null;
  let operation: Promise<void> = Promise.resolve();
  const repositoryFactory = options.repositoryFactory ?? (() => openProtectedLabDatabase());
  const fileService = options.fileService ?? createProtectedReportFileService();
  const picker = options.picker ?? createSystemLabSourcePicker();
  const pdfInspector = options.pdfInspector ?? nativePdfInspector;
  const imageInspector = options.imageInspector ?? nativeImageInspector;
  const visionOCR = options.visionOCR ?? nativeVisionOCR;
  const extractionAliases = options.extractionAliases ?? createDefaultExtractionAliases();
  const semanticMapper = options.semanticMapper;
  const documentVLM = options.documentVLM;
  const documentRefinementBudgetMs =
    options.documentRefinementBudgetMs ?? DOCUMENT_REFINEMENT_BUDGET_MS;
  const elapsedTimeNow =
    options.elapsedTimeNow ?? (() => globalThis.performance?.now?.() ?? Date.now());
  if (!Number.isFinite(documentRefinementBudgetMs) || documentRefinementBudgetMs <= 0) {
    throw new Error('The document refinement budget must be positive');
  }
  const extractionProgress = new Map<string, LabReportExtractionProgress>();
  const extractionProgressListeners = new Set<(progress: LabReportExtractionProgress) => void>();
  let nextExtractionOperation = 0;
  const extractionOperations = new Map<string, ExtractionOperationToken>();
  const now = options.now ?? isoNow;
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));
  const sanitizationSessions = new Map<string, Awaited<ReturnType<PdfInspector['unlock']>>>();
  const sanitizationWorkspaceArtifacts = new Map<string, string>();

  function publishExtractionProgress(progress: LabReportExtractionProgress): void {
    extractionProgress.set(progress.reportId, progress);
    // A screen is an observer, never part of the extraction transaction. One malformed or
    // unmounted subscriber must not turn a written draft into a failed extraction.
    for (const listener of extractionProgressListeners) {
      try {
        listener(progress);
      } catch {
        // Observers are best-effort and must not affect the operation.
      }
    }
  }

  function extractionProgressEvent(
    reportId: string,
    mode: LabReportExtractionMode,
    stage: LabReportExtractionProgress['stage'],
    status: LabReportExtractionProgress['status'],
    completed: number,
    total: number,
    error?: LabReportExtractionProgress['error'],
  ): void {
    publishExtractionProgress({
      reportId,
      mode,
      stage,
      status,
      completed,
      total,
      ...(error === undefined ? {} : { error }),
    });
  }

  function progressError(
    value: string | null,
    state: LabReportExtractionOperation['state'],
  ): LabReportExtractionError['reason'] | undefined {
    if (state === 'interrupted') return 'interrupted';
    const supported: readonly LabReportExtractionError['reason'][] = [
      'sanitized-source',
      'recognition',
      'no-reviewable-measurements',
      'original-source',
      'persistence',
      'wrong-password',
      'model-unavailable',
      'cancelled',
      'interrupted',
      'improve-deferred',
    ];
    return value !== null && supported.includes(value as LabReportExtractionError['reason'])
      ? (value as LabReportExtractionError['reason'])
      : undefined;
  }

  async function persistExtractionOperation(
    repo: LabRepository,
    reportId: string,
    mode: LabReportExtractionMode,
    state: LabReportExtractionOperation['state'],
    stage: LabReportExtractionProgress['stage'],
    completed: number,
    total: number,
    error: string | null = null,
    pipelineFingerprint: ExtractionPipelineFingerprint | null = null,
    revision = pipelineFingerprint?.revision ?? 1,
  ): Promise<void> {
    const current = await repo.getExtractionOperation(reportId);
    await repo.upsertExtractionOperation({
      reportId,
      mode,
      state,
      stage,
      completed,
      total,
      error,
      createdAt: current?.createdAt ?? now(),
      updatedAt: now(),
      pipelineFingerprint,
      pipelineFingerprintHash: pipelineFingerprint?.hash ?? null,
      revision,
    });
  }

  function currentExtractionPipelineFingerprint(
    sourceHash: string | null,
    revision = 1,
    sourceType?: LabReport['sourceType'],
  ): ExtractionPipelineFingerprint {
    return createExtractionPipelineFingerprint(
      {
        sourceHash,
        ocrContractVersion: VISION_OCR_CONTRACT_VERSION,
        rowSegmentationVersion: EXTRACTION_ROW_SEGMENTATION_VERSION,
        parserVersion: EXTRACTION_PARSER_VERSION,
        semanticAdapterVersion:
          documentVLM?.adapterVersion ?? semanticMapper?.adapterVersion ?? null,
        semanticSchemaVersion: documentVLM?.schemaVersion ?? semanticMapper?.schemaVersion ?? null,
        semanticChunkVersion: semanticMapper?.provenance?.chunkVersion ?? null,
        semanticPromptVersion:
          documentVLM?.provenance.promptVersion ??
          semanticMapper?.provenance?.promptVersion ??
          null,
        modelVersion:
          documentVLM?.provenance.modelVersion ?? semanticMapper?.provenance?.modelVersion ?? null,
        runtimeVersion:
          documentVLM?.provenance.runtimeVersion ??
          semanticMapper?.provenance?.runtimeVersion ??
          null,
        catalogueVersion: semanticMapper?.provenance?.catalogueVersion ?? CATALOGUE_VERSION,
        pdfTextLayerAdapterVersion:
          sourceType === 'pdf' &&
          (pdfInspector.textLayerAdapterVersion === PDF_TEXT_LAYER_ADAPTER_VERSION ||
            pdfInspector.readTextLayerPage !== undefined)
            ? PDF_TEXT_LAYER_ADAPTER_VERSION
            : null,
      },
      revision,
    );
  }

  function persistedPath(path: string): string {
    return fileService.portablePath === undefined ? path : fileService.portablePath(path);
  }

  async function nativePath(path: string): Promise<string> {
    return fileService.resolvePath === undefined ? path : fileService.resolvePath(path);
  }

  async function reconcileOriginalOrphans(repo: LabRepository): Promise<void> {
    if (fileService.listOwnedFiles === undefined || fileService.removeOwnedFile === undefined) {
      return;
    }
    const referencedOriginals = new Set<string>();
    for (const report of await repo.listReports()) {
      if (report.originalPath === null) continue;
      try {
        referencedOriginals.add(persistedPath(report.originalPath));
      } catch {
        // An unowned legacy path cannot authorize touching any protected file.
      }
    }
    for (const path of await fileService.listOwnedFiles()) {
      let portable: string;
      try {
        portable = persistedPath(path);
      } catch {
        continue;
      }
      if (!portable.startsWith('protected://original-reports/')) continue;
      if (referencedOriginals.has(portable)) continue;
      try {
        await fileService.removeOwnedFile(path);
      } catch {
        // Keep the orphan for the next launch. It remains within the protected owner boundary and
        // is retried here instead of becoming an undiscoverable permanent artifact.
      }
    }
  }

  async function repository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    const pending = repositoryPromise;
    try {
      return await pending;
    } catch (error) {
      if (repositoryPromise === pending) repositoryPromise = null;
      throw error;
    }
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    initializationPromise ??= (async () => {
      const repo = await repository();
      await fileService.initialize();
      // iOS may assign a new UUID to the app's data container during an update. Rebase every
      // validated app-owned reference before any preview, cleanup, or deletion work uses it.
      if (fileService.portablePath !== undefined) {
        for (const report of await repo.listReports()) {
          if (report.originalPath !== null) {
            try {
              const nextPath = persistedPath(report.originalPath);
              if (nextPath !== report.originalPath) {
                await repo.rebaseOriginalPath(report.id, nextPath);
              }
            } catch {
              // An unowned or hostile legacy row is preserved for review; it is never rebased.
            }
          }
          const pages = report.pages.map((page) => {
            if (page.derivedPath === null) return page;
            try {
              const nextPath = persistedPath(page.derivedPath);
              return nextPath === page.derivedPath ? page : { ...page, derivedPath: nextPath };
            } catch {
              return page;
            }
          });
          if (pages.some((page, index) => page.derivedPath !== report.pages[index]?.derivedPath)) {
            await repo.updateReport(report.id, { pages });
          }
          const derivative = await repo.getSanitizedReport(report.id);
          if (derivative?.artifactPath !== null && derivative?.artifactPath !== undefined) {
            try {
              const nextPath = persistedPath(derivative.artifactPath);
              if (nextPath !== derivative.artifactPath) {
                await repo.rebaseSanitizedArtifactPath(derivative.id, nextPath);
              }
            } catch {
              // Preserve an unowned derivative row; the file adapter will refuse to open it.
            }
          }
        }
      }
      await fileService.cleanupTransientImports();
      const interrupted = (await repo.listReports()).filter(
        (report) => report.importState === 'importing' && report.originalPath === null,
      );
      for (const report of interrupted) {
        let recovered: ProtectedCopy | null = null;
        try {
          recovered = await fileService.recoverPromoted(report.id, {
            uri: '',
            name: report.originalFilename,
            mimeType: report.mimeType,
            sourceType: report.sourceType,
            byteSize: report.byteSize,
          });
        } catch {
          // Keep the durable row actionable even when a promoted artifact is unreadable. The
          // source path remains recorded only after a successful recovery and can be retried or
          // deleted from detail without silently treating corrupt bytes as a usable duplicate.
          await repo.updateReport(report.id, {
            importState: 'failed',
            failureReason: 'interrupted-source-unreadable',
          });
        }
        if (recovered !== null) {
          await repo.updateReport(report.id, {
            sourceHash: recovered.sourceHash,
            originalPath: persistedPath(recovered.path),
            importState: 'interrupted',
            failureReason: 'interrupted-after-promotion',
          });
        }
      }
      await repo.reconcileInterruptedReports();
      await reconcileOriginalOrphans(repo);
      for (const candidate of await repo.listDeletionCandidates()) {
        if (candidate.deletionState === 'requested') {
          try {
            await processDeletion(candidate.id, repo);
          } catch {
            // A failed cleanup is durable and actionable from report detail; it must not prevent
            // the rest of the local Labs library from opening after relaunch.
          }
        }
      }
      // A crash during independent derivative deletion leaves an actionable row. Reconcile it
      // on relaunch before exposing the library so a stale health artifact cannot linger silently.
      for (const report of await repo.listReports()) {
        const derivative = await repo.getSanitizedReport(report.id);
        if (derivative?.failureReason !== 'sanitized-delete-pending') continue;
        try {
          if (
            derivative.artifactPath !== null &&
            (await fileService.exists(derivative.artifactPath))
          ) {
            await fileService.remove(derivative.artifactPath);
          }
          if (
            derivative.artifactPath === null ||
            !(await fileService.exists(derivative.artifactPath))
          ) {
            await repo.deleteSanitizedReport(derivative.id);
          }
        } catch {
          // Keep the failure state and artifact path for an actionable retry.
        }
      }
      // A derivative is promoted by replacing the database pointer only after its bytes have
      // passed protection and verification. Any staged or superseded sanitized artifact left by
      // a crash is therefore safe to remove when it has no live database reference.
      if (fileService.listOwnedFiles !== undefined && fileService.removeOwnedFile !== undefined) {
        const referencedSanitized = new Set<string>();
        for (const report of await repo.listReports()) {
          const derivative = await repo.getSanitizedReport(report.id);
          if (derivative?.artifactPath !== null && derivative?.artifactPath !== undefined) {
            try {
              referencedSanitized.add(persistedPath(derivative.artifactPath));
            } catch {
              // The repository row remains visible, but an unowned path is never matched for
              // cleanup. The protected-file adapter will reject it if opened.
            }
          }
        }
        for (const path of await fileService.listOwnedFiles()) {
          let portable: string;
          try {
            portable = persistedPath(path);
          } catch {
            continue;
          }
          if (!portable.startsWith('protected://sanitized/')) continue;
          if (!portable.endsWith('.partial') && referencedSanitized.has(portable)) continue;
          try {
            await fileService.removeOwnedFile(path);
          } catch {
            // Keep the orphan for the next launch; never hide a cleanup failure by deleting a
            // database reference or touching another protected directory.
          }
        }
      }
      initialized = true;
    })();
    try {
      await initializationPromise;
    } catch (error) {
      initializationPromise = null;
      throw error;
    }
  }

  async function processDeletion(reportId: string, repo?: LabRepository): Promise<void> {
    const reportRepository = repo ?? (await repository());
    let report = await reportRepository.getReport(reportId);
    if (report === null || report.importState === 'deleted') return;
    if (report.deletionState !== 'requested') {
      report = await reportRepository.requestReportDeletion(reportId);
    }
    try {
      const sanitized = await reportRepository.getSanitizedReport(report.id);
      const protectedPaths = [
        report.originalPath,
        ...report.pages.map((page) => page.derivedPath),
        sanitized?.artifactPath ?? null,
      ];
      if (sanitized?.artifactPath !== null && sanitized?.artifactPath !== undefined) {
        await reportRepository.updateSanitizedReport(sanitized.id, {
          verificationState: 'failed',
          failureReason: 'sanitized-delete-pending',
          deletedAt: now(),
        });
      }
      await deleteProtectedReportArtifacts(fileService, protectedPaths, (path) =>
        reportRepository.countProtectedPathReferences(path, report.id),
      );
      if (sanitized !== null) await reportRepository.deleteSanitizedReport(sanitized.id);
      await reportRepository.completeReportDeletion(report.id);
    } catch (error) {
      await reportRepository.failReportDeletion(report.id, 'source-cleanup-failed');
      throw error;
    }
  }

  async function serialized<T>(work: () => Promise<T>): Promise<T> {
    const previous = operation;
    let release!: () => void;
    operation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }

  async function listReports(): Promise<readonly LabReport[]> {
    await ensureInitialized();
    return (await repository()).listReports();
  }

  async function getReport(id: string): Promise<LabReport | null> {
    await ensureInitialized();
    return (await repository()).getReport(id);
  }

  async function sourceInspection(
    report: LabReport,
    path: string,
    passwordRequest?: PasswordRequest,
  ): Promise<{ readonly inspection: PdfInspection; readonly encrypted: boolean }> {
    const initial = await pdfInspector.inspect(path);
    if (!initial.locked) return { inspection: initial, encrypted: initial.encrypted };
    if (passwordRequest === undefined) {
      throw new LabReportImportError(
        report,
        'wrong-password',
        'A password is required to inspect this PDF',
      );
    }
    const entered = await passwordRequest({ report, attempt: 1 });
    if (entered === null || entered.length === 0) {
      throw new LabReportImportError(report, 'cancelled', 'Password entry was cancelled');
    }
    let password = entered;
    let session: Awaited<ReturnType<PdfInspector['unlock']>> | null = null;
    try {
      session = await pdfInspector.unlock(path, password);
      return { inspection: session.inspection, encrypted: true };
    } catch (error) {
      throw new LabReportImportError(
        report,
        'wrong-password',
        'The PDF password was not accepted',
        { cause: error },
      );
    } finally {
      password = '';
      if (session !== null) await session.close();
    }
  }

  async function cleanupUncommittedImport(
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy | null> {
    // A native copy can fail after creating its destination but before returning its ProtectedCopy.
    // Ask the protected-file owner to reconcile that deterministic destination, then clear any
    // transient source. If removal is interrupted, return the verified copy so the durable report
    // retains a discoverable source and can be retried or deleted instead of hiding the orphan.
    let retained: ProtectedCopy | null = null;
    try {
      const recovered = await fileService.recoverPromoted(reportId, source);
      if (recovered !== null) {
        try {
          await fileService.remove(recovered.path);
        } catch {
          // A failed remove may still have completed before throwing. Preserve the source only
          // when the protected owner confirms that the path remains (or cannot verify it).
          try {
            if (await fileService.exists(recovered.path)) retained = recovered;
          } catch {
            retained = recovered;
          }
        }
      }
    } catch {
      // Original-orphan reconciliation on the next launch handles a destination whose recovery
      // itself was interrupted and could not be verified here.
    }
    try {
      await fileService.cleanupTransientImports();
    } catch {
      // Keep the durable failed report; the next service initialization retries transient cleanup.
    }
    return retained;
  }

  async function importOne(
    source: LabSourceSelection,
    passwordRequest?: PasswordRequest,
  ): Promise<ImportOutcome> {
    const repo = await repository();
    const reportId = makeId('lab-report');
    let report = await repo.createReport({
      id: reportId,
      sourceType: source.sourceType,
      originalFilename: source.name,
      mimeType: source.mimeType,
      byteSize: source.byteSize ?? null,
      importState: 'importing',
      pageCount: null,
      encrypted: false,
      pages: [],
    });
    let staged: ProtectedCopy | null = null;
    let promoted: ProtectedCopy | null = null;
    try {
      staged = await fileService.stage(source, reportId);
      const duplicate = await repo.findReportByHash(staged.sourceHash);
      if (duplicate !== null) {
        await repo.updateReport(reportId, {
          sourceHash: staged.sourceHash,
          importState: 'deleted',
          failureReason: 'duplicate-source',
        });
        const existingDraft = await repo.getExtractionDraftForReport(
          duplicate.id,
          extractionAliases,
        );
        return {
          report: duplicate,
          duplicate: true,
          destination: resolveLabReportImportDestination(true, existingDraft),
        };
      }
      promoted = await fileService.promote(staged, reportId, source);
      // Persist the protected promotion before inspection. If the process dies after this point,
      // relaunch can recover the source and present an actionable interrupted state.
      report = await repo.updateReport(reportId, {
        sourceHash: promoted.sourceHash,
        originalPath: persistedPath(promoted.path),
        importState: 'importing',
        failureReason: null,
      });
      const inspection =
        source.sourceType === 'pdf'
          ? await sourceInspection(
              report,
              promoted.path,
              passwordRequest ?? options.passwordRequest,
            )
          : {
              inspection: {
                encrypted: false,
                locked: false,
                pageCount: 1,
                metadata: {},
                pages: [
                  {
                    pageIndex: 0,
                    width: source.width ?? 0,
                    height: source.height ?? 0,
                    hasTextLayer: false,
                  },
                ],
              },
              encrypted: false,
            };
      report = await repo.updateReport(reportId, {
        sourceHash: promoted.sourceHash,
        originalPath: persistedPath(promoted.path),
        importState: 'imported',
        failureReason: null,
        encrypted: inspection.encrypted,
        pageCount: inspection.inspection.pageCount,
        importedAt: now(),
        pages: pageInputs(inspection.inspection),
      });
      return {
        report,
        duplicate: false,
        destination: resolveLabReportImportDestination(false, null),
      };
    } catch (error) {
      const reason = classifyFailure(error);
      const retained = promoted === null ? await cleanupUncommittedImport(reportId, source) : null;
      const preservedPath =
        promoted === null
          ? retained === null
            ? null
            : persistedPath(retained.path)
          : persistedPath(promoted.path);
      const preservedHash =
        promoted?.sourceHash ?? retained?.sourceHash ?? staged?.sourceHash ?? null;

      // A user cancellation before promotion must not leave a pathless Lab Report in the
      // library. There is no protected source to retry or delete in that state, so finish the
      // just-created row as deleted. If a protected copy was retained, keep the interrupted row
      // instead: it is a real, recoverable import that the user can retry or remove later.
      if (reason === 'cancelled' && preservedPath === null) {
        try {
          await processDeletion(reportId, repo);
        } catch {
          // The row remains actionable if database cleanup itself fails. Do not claim that a
          // missing source is retryable when cleanup could not complete.
          report = await repo.updateReport(reportId, {
            sourceHash: preservedHash,
            originalPath: null,
            importState: 'failed',
            failureReason: 'source-cleanup-failed',
          });
        }
        const deleted = await repo.getReport(reportId);
        if (deleted !== null) report = deleted;
      } else {
        report = await repo.updateReport(reportId, {
          sourceHash: preservedHash,
          originalPath: preservedPath,
          importState: reason === 'cancelled' ? 'interrupted' : 'failed',
          failureReason: reason,
        });
      }
      if (error instanceof LabReportImportError) {
        throw new LabReportImportError(report, reason, error.message, { cause: error });
      }
      throw new LabReportImportError(report, reason, 'The Lab Report could not be imported', {
        cause: error,
      });
    } finally {
      if (staged !== null) await fileService.remove(staged.path);
    }
  }

  async function importPdf(
    source?: LabSourceSelection,
    passwordRequest?: PasswordRequest,
  ): Promise<LabReportImportResult | null> {
    return serialized(async () => {
      await ensureInitialized();
      const selected = source ?? (await picker.pickPdf());
      if (selected === null || selected === undefined) return null;
      return importOne(selected, passwordRequest);
    });
  }

  async function importImages(
    source?: LabSourceSelection,
    passwordRequest?: PasswordRequest,
  ): Promise<LabReportImportResult | null> {
    return serialized(async () => {
      await ensureInitialized();
      const picked = source === undefined ? await picker.pickImages() : source;
      const selected = singleImageSelection(picked);
      if (selected === null) return null;
      return importOne(selected, passwordRequest);
    });
  }

  async function retryImport(id: string, passwordRequest?: PasswordRequest): Promise<LabReport> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const report = await repo.getReport(id);
      if (report === null) throw new Error('Lab Report was not found');
      if (report.originalPath === null || report.sourceHash === null) {
        throw new Error('This Lab Report has no protected source to retry');
      }
      const actualHash = await fileService.hashFile(report.originalPath);
      if (actualHash !== report.sourceHash) throw new Error('Original Report hash mismatch');
      if (report.sourceType !== 'pdf') {
        return repo.updateReport(id, {
          importState: 'imported',
          failureReason: null,
          importedAt: now(),
          pageCount: report.pageCount ?? 1,
        });
      }
      const result = await sourceInspection(
        report,
        await nativePath(report.originalPath),
        passwordRequest,
      );
      return repo.updateReport(id, {
        importState: 'imported',
        failureReason: null,
        encrypted: result.encrypted,
        pageCount: result.inspection.pageCount,
        importedAt: now(),
        pages: pageInputs(result.inspection),
      });
    });
  }

  async function verifySource(id: string): Promise<LabReportSourceIntegrity> {
    await ensureInitialized();
    const report = await (await repository()).getReport(id);
    if (report === null || report.originalPath === null || report.sourceHash === null)
      return 'missing';
    try {
      if (!(await fileService.exists(report.originalPath))) return 'missing';
      return (await fileService.hashFile(report.originalPath)) === report.sourceHash
        ? 'verified'
        : 'mismatch';
    } catch {
      return 'missing';
    }
  }

  async function openOriginal(id: string): Promise<string> {
    const report = await getReport(id);
    if (report === null) throw new Error('Lab Report was not found');
    const integrity = await verifySource(id);
    if (integrity !== 'verified' || report.originalPath === null) {
      throw new Error('Original Report integrity could not be verified');
    }
    return nativePath(report.originalPath);
  }

  async function previewOriginal(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<LabReportPreview> {
    const report = await getReport(id);
    if (report === null) throw new Error('Lab Report was not found');
    const path = await openOriginal(id);
    if (report.sourceType === 'image') return { sourceType: 'image', uris: [path] };

    const initial = await pdfInspector.inspect(path);
    if (!initial.locked) {
      return { sourceType: 'pdf', uris: await pdfInspector.renderPreview(path) };
    }
    const request = passwordRequest ?? options.passwordRequest;
    if (request === undefined) {
      throw new LabReportImportError(
        report,
        'wrong-password',
        'A password is required to preview this PDF',
      );
    }
    const entered = await request({ report, attempt: 1 });
    if (entered === null || entered.length === 0) {
      throw new LabReportImportError(report, 'cancelled', 'Password entry was cancelled');
    }
    let password = entered;
    let session: Awaited<ReturnType<PdfInspector['unlock']>> | null = null;
    try {
      session = await pdfInspector.unlock(path, password);
      return { sourceType: 'pdf', uris: await session.renderPreview() };
    } catch (error) {
      throw new LabReportImportError(
        report,
        'wrong-password',
        'The PDF password was not accepted',
        { cause: error },
      );
    } finally {
      password = '';
      if (session !== null) await session.close();
    }
  }

  async function openOriginalViewer(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<OriginalReportViewerSession> {
    const report = await getReport(id);
    if (report === null) throw new Error('Lab Report was not found');
    // This is the only service boundary that resolves the protected source. The returned value
    // is an opaque native capability; the screen never receives this path.
    const path = await openOriginal(id);

    if (report.sourceType === 'image') {
      const openViewer = imageInspector.openViewer;
      const closeViewer = imageInspector.closeViewer;
      if (openViewer === undefined || closeViewer === undefined) {
        throw new Error('AlyteImage is unavailable for local image viewing');
      }
      const session = await openViewer.call(imageInspector, path);
      return {
        sourceType: 'image',
        pageCount: 1,
        sessionId: session.sessionId,
        close: async () => {
          await closeViewer.call(imageInspector, session.sessionId);
        },
      };
    }

    if (pdfInspector.openViewer === undefined) {
      throw new Error('AlytePDF is unavailable for local PDF viewing');
    }
    const opened = await pdfInspector.openViewer(path);
    let session: PdfViewerSession;
    if (opened.locked) {
      const request = passwordRequest ?? options.passwordRequest;
      if (request === undefined) {
        throw new LabReportImportError(
          report,
          'wrong-password',
          'A password is required to view this PDF',
        );
      }
      const entered = await request({ report, attempt: 1 });
      if (entered === null || entered.length === 0) {
        throw new LabReportImportError(report, 'cancelled', 'Password entry was cancelled');
      }
      let password = entered;
      try {
        if (pdfInspector.unlockViewer === undefined) {
          throw new Error('AlytePDF is unavailable for local PDF viewing');
        }
        session = await pdfInspector.unlockViewer(path, password);
      } catch (error) {
        if (!isPdfPasswordFailure(error)) throw error;
        throw new LabReportImportError(
          report,
          'wrong-password',
          'The PDF password was not accepted',
          { cause: error },
        );
      } finally {
        password = '';
      }
    } else {
      if (opened.session === null) {
        throw new Error('AlytePDF did not return a viewer capability');
      }
      session = opened.session;
    }

    let pageCount: number;
    try {
      pageCount = viewerPageCount(session.pageCount);
    } catch (error) {
      try {
        await session.close();
      } catch {
        // Preserve the corrupt-source state even if native cleanup is already unavailable.
      }
      throw error;
    }

    return {
      sourceType: 'pdf',
      pageCount,
      sessionId: session.sessionId,
      close: () => session.close(),
    };
  }

  async function openSanitizationEditor(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<SanitizationEditorState> {
    await ensureInitialized();
    const repo = await repository();
    const report = await repo.getReport(id);
    if (report === null) throw new Error('Lab Report was not found');
    const path = await openOriginal(id);
    const current = await repo.getSanitizedReport(id);
    const recipe =
      (await repo.getSanitizationDraft(id)) ?? current?.recipe ?? recipeForReport(report);

    if (report.sourceType === 'image') {
      await imageInspector.inspect(path);
      const pagePreviewUris = [path];
      return {
        report,
        sourcePath: path,
        recipe,
        suggestions: [],
        pagePreviewUris,
        current,
      };
    }

    let session = sanitizationSessions.get(id) ?? null;
    if (session === null) {
      const inspection = await pdfInspector.inspect(path);
      if (inspection.locked) {
        const request = passwordRequest ?? options.passwordRequest;
        if (request === undefined) {
          throw new LabReportSanitizationError(id, 'A password is required to edit this PDF');
        }
        const entered = await request({ report, attempt: 1 });
        if (entered === null || entered.length === 0) {
          throw new LabReportSanitizationError(id, 'Password entry was cancelled');
        }
        let password = entered;
        try {
          session = await pdfInspector.unlock(path, password);
          sanitizationSessions.set(id, session);
          if (
            fileService.sanitizedDestination === undefined ||
            fileService.protectArtifact === undefined
          ) {
            throw new Error('Protected workspace storage is unavailable');
          }
          const workspacePath = await fileService.sanitizedDestination(id, 'unlocked-workspace');
          await session.exportUnlocked(workspacePath);
          const protectedWorkspace = await fileService.protectArtifact(workspacePath);
          sanitizationWorkspaceArtifacts.set(id, protectedWorkspace.path);
        } catch (error) {
          throw new LabReportSanitizationError(id, 'The PDF password was not accepted', {
            cause: error,
          });
        } finally {
          password = '';
        }
      }
    }
    const pagePreviewUris = session
      ? await session.renderPreview()
      : await pdfInspector.renderPreview(path);
    const suggestions = session?.suggestSensitiveRegions
      ? await session.suggestSensitiveRegions()
      : pdfInspector.suggestSensitiveRegions === undefined
        ? []
        : await pdfInspector.suggestSensitiveRegions(path);
    return {
      report,
      sourcePath: sanitizationWorkspaceArtifacts.get(id) ?? path,
      recipe,
      suggestions,
      pagePreviewUris,
      current,
    };
  }

  async function closeSanitizationEditor(id: string): Promise<void> {
    const session = sanitizationSessions.get(id);
    sanitizationSessions.delete(id);
    if (session !== undefined) await session.close();
    const workspaceArtifact = sanitizationWorkspaceArtifacts.get(id);
    sanitizationWorkspaceArtifacts.delete(id);
    if (workspaceArtifact !== undefined) await fileService.remove(workspaceArtifact);
  }

  async function saveSanitizationDraft(id: string, recipe: SanitizationRecipe): Promise<void> {
    await serialized(async () => {
      await ensureInitialized();
      await (await repository()).saveSanitizationDraft(id, recipe);
    });
  }
  async function discardSanitizationDraft(id: string): Promise<void> {
    await serialized(async () => {
      await ensureInitialized();
      await (await repository()).clearSanitizationDraft(id);
    });
  }

  async function saveSanitizedReport(
    id: string,
    recipe: SanitizationRecipe,
  ): Promise<SanitizedReport> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const report = await repo.getReport(id);
      if (report === null) throw new Error('Lab Report was not found');
      if (recipe.reportId !== id) {
        throw new LabReportSanitizationError(id, 'Sanitization recipe belongs to another report');
      }
      if (
        report.sourceType === 'pdf' &&
        (pdfInspector.sanitize === undefined || pdfInspector.verifySanitized === undefined)
      ) {
        throw new LabReportSanitizationError(id, 'PDF sanitization is unavailable on this device');
      }
      const sourcePath = await openOriginal(id);
      const recipeHash = sanitizationRecipeHash(recipe);
      const current = await repo.getSanitizedReport(id);
      const currentVerificationVersion =
        report.sourceType === 'image' ? 'image-source-aware-v2' : 'source-aware-v1';
      if (
        current?.verificationState === 'verified' &&
        current.verification?.sourceAwareChecked === true &&
        current.verification.sourceContentRemoved === true &&
        current.verification.verificationVersion === currentVerificationVersion &&
        current.recipeHash === recipeHash &&
        current.artifactPath !== null &&
        current.artifactHash !== null &&
        (await fileService.exists(current.artifactPath))
      ) {
        return current;
      }
      // Every replacement gets a fresh identity and destination. The current verified derivative
      // remains readable until the replacement has rendered, been source-aware verified, been
      // protected, and been durably promoted in the repository.
      const derivativeId = makeId('sanitized-report');
      const destination =
        report.sourceType === 'image'
          ? fileService.sanitizedImageDestination === undefined
            ? fileService.sanitizedDestination === undefined
              ? `${sourcePath}.alyte-sanitized-${derivativeId}.jpg`
              : await fileService.sanitizedDestination(id, derivativeId)
            : await fileService.sanitizedImageDestination(id, derivativeId)
          : fileService.sanitizedDestination === undefined
            ? `${sourcePath}.alyte-sanitized-${derivativeId}.pdf`
            : await fileService.sanitizedDestination(id, derivativeId);
      let promoted = false;
      try {
        const session = sanitizationSessions.get(id);
        let rendered: PdfSanitizationResult | ImageSanitizationResult;
        let structural: PdfSanitizedVerification | ImageSanitizedVerification;
        if (report.sourceType === 'image') {
          rendered = await imageInspector.sanitize(sourcePath, destination, recipe);
          structural = await imageInspector.verifySanitized(destination, sourcePath, recipe);
        } else {
          rendered =
            session?.sanitize !== undefined
              ? await session.sanitize(destination, recipe)
              : await pdfInspector.sanitize!(sourcePath, destination, recipe);
          structural = await pdfInspector.verifySanitized!(destination);
        }
        const verification =
          rendered.verification === undefined
            ? structural
            : {
                ...structural,
                sourceAwareChecked: rendered.verification.sourceAwareChecked,
                sourceContentRemoved: rendered.verification.sourceContentRemoved,
                verificationVersion: rendered.verification.verificationVersion,
                failureReasons: [
                  ...new Set([
                    ...structural.failureReasons,
                    ...rendered.verification.failureReasons,
                  ]),
                ],
              };
        if (!verificationPassed(verification, report.sourceType)) {
          await fileService.remove(destination);
          const failureReason =
            verification.failureReasons.join('; ') || 'sanitized-verification-failed';
          if (current !== null) {
            throw new LabReportSanitizationError(
              id,
              'The replacement Sanitized Report could not be verified',
            );
          }
          return repo.saveSanitizedReport({
            id: derivativeId,
            reportId: id,
            recipe,
            recipeHash,
            artifactPath: null,
            artifactHash: null,
            byteSize: null,
            verificationState: 'failed',
            verification: verificationForSanitizedReport(verification),
            failureReason,
            deletedAt: null,
          });
        }
        if (fileService.protectArtifact === undefined) {
          throw new Error('Protected derivative storage is unavailable');
        }
        const protectedArtifact = await fileService.protectArtifact(destination);
        const verified = await repo.saveSanitizedReport({
          id: derivativeId,
          reportId: id,
          recipe,
          recipeHash,
          artifactPath: persistedPath(protectedArtifact.path),
          artifactHash: protectedArtifact.sourceHash,
          byteSize: protectedArtifact.byteSize,
          verificationState: 'verified',
          verification: verificationForSanitizedReport(verification),
          failureReason: null,
          deletedAt: null,
        });
        promoted = true;
        if (current?.artifactPath !== null && current?.artifactPath !== undefined) {
          try {
            await deleteProtectedReportArtifacts(fileService, [current.artifactPath], (path) =>
              repo.countProtectedPathReferences(path, id),
            );
          } catch {
            // The new pointer is already durable. Startup reconciliation removes this stale
            // unreferenced artifact after a transient cleanup failure.
          }
        }
        await repo.clearSanitizationDraft(id).catch(() => undefined);
        return verified;
      } catch (error) {
        if (!promoted) await fileService.remove(destination).catch(() => undefined);
        if (current === null && !(error instanceof LabReportSanitizationError)) {
          await repo
            .saveSanitizedReport({
              id: derivativeId,
              reportId: id,
              recipe,
              recipeHash,
              artifactPath: null,
              artifactHash: null,
              byteSize: null,
              verificationState: 'failed',
              verification: null,
              failureReason: error instanceof Error ? error.message : 'sanitized-render-failed',
              deletedAt: null,
            })
            .catch(() => undefined);
        }
        if (error instanceof LabReportSanitizationError) throw error;
        throw new LabReportSanitizationError(id, 'The Sanitized Report could not be verified', {
          cause: error,
        });
      }
    });
  }

  async function getSanitizedReport(id: string): Promise<SanitizedReport | null> {
    await ensureInitialized();
    return (await repository()).getSanitizedReport(id);
  }

  async function previewSanitizedReport(id: string): Promise<SanitizedReportPreview> {
    await ensureInitialized();
    const report = await (await repository()).getReport(id);
    if (report === null) throw new LabReportSanitizationError(id, 'Lab Report was not found');
    const derivative = await (await repository()).getSanitizedReport(id);
    if (
      derivative === null ||
      derivative.verificationState !== 'verified' ||
      derivative.artifactPath === null ||
      derivative.artifactHash === null ||
      derivative.verification?.sourceAwareChecked !== true ||
      !persistedVerificationPassed(derivative.verification, report.sourceType)
    ) {
      throw new LabReportSanitizationError(id, 'This Sanitized Report is not verified');
    }
    if (!(await fileService.exists(derivative.artifactPath))) {
      await (
        await repository()
      ).updateSanitizedReport(derivative.id, {
        artifactPath: null,
        artifactHash: null,
        byteSize: null,
        verificationState: 'failed',
        failureReason: 'sanitized-artifact-missing',
      });
      throw new LabReportSanitizationError(id, 'The verified Sanitized Report is missing');
    }
    const artifactPath = await nativePath(derivative.artifactPath);
    const actualHash = await fileService.hashFile(artifactPath);
    if (actualHash !== derivative.artifactHash) {
      await fileService.remove(derivative.artifactPath);
      await (
        await repository()
      ).updateSanitizedReport(derivative.id, {
        artifactPath: null,
        artifactHash: null,
        byteSize: null,
        verificationState: 'failed',
        failureReason: 'sanitized-artifact-hash-mismatch',
      });
      throw new LabReportSanitizationError(id, 'The verified Sanitized Report hash changed');
    }
    const sourcePath = await openOriginal(id);
    let verification: PdfSanitizedVerification | ImageSanitizedVerification;
    let passesVerification = false;
    if (report.sourceType === 'image') {
      // Image verification receives the Original Report and recipe, so it remains source-aware.
      verification = await imageInspector.verifySanitized(
        artifactPath,
        sourcePath,
        derivative.recipe,
      );
      passesVerification = verificationPassed(verification, 'image');
    } else {
      if (pdfInspector.verifySanitized === undefined) {
        throw new LabReportSanitizationError(
          id,
          'Sanitized verification is unavailable on this device',
        );
      }
      verification = await pdfInspector.verifySanitized(artifactPath);
      passesVerification = structuralVerificationPassed(verification);
    }
    if (!passesVerification) {
      await fileService.remove(derivative.artifactPath);
      await (
        await repository()
      ).updateSanitizedReport(derivative.id, {
        artifactPath: null,
        artifactHash: null,
        byteSize: null,
        verificationState: 'failed',
        verification: verificationForSanitizedReport(verification),
        failureReason: verification.failureReasons.join('; ') || 'sanitized-verification-failed',
      });
      throw new LabReportSanitizationError(
        id,
        'The Sanitized Report no longer passes verification',
      );
    }
    return {
      sourceType: report.sourceType,
      artifactPath,
      artifactHash: derivative.artifactHash,
      uris:
        report.sourceType === 'image'
          ? [artifactPath]
          : await pdfInspector.renderPreview(artifactPath),
      verification,
    };
  }

  async function getExtractionReadiness(id: string): Promise<LabReportExtractionReadiness> {
    await ensureInitialized();
    const repo = await repository();
    const derivative = await repo.getSanitizedReport(id);
    if (derivative === null) return { ready: false, status: 'missing' };
    try {
      await previewSanitizedReport(id);
      return { ready: true, status: 'verified' };
    } catch {
      const current = await repo.getSanitizedReport(id);
      return {
        ready: false,
        status: current?.verificationState === 'failed' ? 'failed' : 'unverified',
      };
    }
  }

  function subscribeExtractionProgress(
    listener: (progress: LabReportExtractionProgress) => void,
  ): () => void {
    extractionProgressListeners.add(listener);
    return () => extractionProgressListeners.delete(listener);
  }

  function getExtractionProgress(id: string): LabReportExtractionProgress | null {
    return extractionProgress.get(id) ?? null;
  }

  async function loadExtractionProgress(id: string): Promise<LabReportExtractionProgress | null> {
    await ensureInitialized();
    const durable = await (await repository()).getExtractionOperation(id);
    if (durable === null) return extractionProgress.get(id) ?? null;
    const durableError = progressError(durable.error, durable.state);
    const progress: LabReportExtractionProgress = {
      reportId: id,
      mode: durable.mode ?? 'start',
      stage: durable.stage,
      status:
        durable.state === 'active'
          ? 'active'
          : durable.state === 'complete'
            ? 'complete'
            : durable.state === 'cancelled'
              ? 'cancelled'
              : durable.state === 'interrupted'
                ? 'interrupted'
                : 'failed',
      completed: durable.completed,
      total: durable.total,
      ...(durableError === undefined ? {} : { error: durableError }),
    };
    extractionProgress.set(id, progress);
    return progress;
  }

  async function cancelExtraction(id: string): Promise<void> {
    const operationToken = extractionOperations.get(id);
    if (operationToken !== undefined) cancelExtractionOperation(operationToken);
  }

  async function deleteSanitizedReport(id: string): Promise<void> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const derivative = await repo.getSanitizedReport(id);
      if (derivative === null) return;
      if (derivative.artifactPath !== null) {
        // Phase one is durable: once this succeeds the row can never claim a verified artifact
        // while phase two removes bytes. A crash or DB failure after removal is reconciled on
        // relaunch from this failed cleanup state.
        await repo.updateSanitizedReport(derivative.id, {
          verificationState: 'failed',
          failureReason: 'sanitized-delete-pending',
          deletedAt: now(),
        });
        try {
          await fileService.remove(derivative.artifactPath);
          if (await fileService.exists(derivative.artifactPath)) {
            throw new Error('Sanitized Report remained after deletion');
          }
        } catch (error) {
          await repo.updateSanitizedReport(derivative.id, {
            verificationState: 'failed',
            failureReason: 'sanitized-delete-pending',
            deletedAt: now(),
          });
          throw new LabReportSanitizationError(id, 'The Sanitized Report could not be deleted', {
            cause: error,
          });
        }
      }
      await repo.deleteSanitizedReport(derivative.id);
      await closeSanitizationEditor(id);
    });
  }

  async function deleteReport(id: string): Promise<void> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const report = await repo.getReport(id);
      if (report === null) return;
      if (report.importState === 'deleted') return;
      await repo.requestReportDeletion(id);
      await processDeletion(id, repo);
    });
  }

  function localeForRecognitionLanguage(languageTag: string | null): string | null {
    const language = languageTag?.toLowerCase().split(/[-_]/u)[0];
    const languageLocales: Readonly<Record<string, string>> = {
      de: 'de-DE',
      fr: 'fr-FR',
      es: 'es-ES',
      it: 'it-IT',
      pt: 'pt-PT',
      nl: 'nl-NL',
      pl: 'pl-PL',
      lt: 'lt-LT',
      en: 'en-US',
    };
    return languageLocales[language ?? ''] ?? null;
  }

  function localeForObservation(observation: VisionTextObservation): string | null {
    return localeForRecognitionLanguage(observation.recognition.language);
  }

  function extractionLocaleFromOCR(results: readonly VisionOCRResult[]): string {
    const locales = new Set(
      results
        .flatMap((result) => result.observations)
        .map(localeForObservation)
        .filter((locale): locale is string => locale !== null),
    );
    // Mixed or unknown attribution is intentionally stable and independent of the phone locale.
    // Per-observation date contexts retain their own locale (or null) above.
    return locales.size === 1 ? ([...locales][0] ?? 'en-US') : 'en-US';
  }

  function dateContextFromOCR(results: readonly VisionOCRResult[]) {
    const observations = [
      ...new Map(
        results
          .flatMap((result) => result.observations)
          .map((observation) => [observation.id, observation] as const),
      ).values(),
    ].map((observation): OCRDateContextObservation => ({
      ...observation,
      locale: localeForObservation(observation),
    }));
    return extractOCRDateContexts(observations);
  }

  function specimenTypeFromText(text: string): SpecimenType | null {
    const candidates = specimenTypesFromText(text);
    return candidates.size === 1 ? [...candidates][0]! : null;
  }

  /**
   * A geometry row may inherit a table context, but an explicit row mention is more specific
   * only when it names one specimen. Keep the candidate set separate from the convenience helper
   * so a conflicting row mention cannot accidentally fall back to an inherited table context.
   */
  function specimenTypesFromText(text: string): ReadonlySet<SpecimenType> {
    const candidates = new Set<SpecimenType>();
    if (/\bplasma\b/iu.test(text)) candidates.add('plasma');
    if (/\b(?:serum|sérum|serumas)\b/iu.test(text)) candidates.add('serum');
    if (/\b(?:urine|urin|orina|urina)\b/iu.test(text)) candidates.add('urine');
    if (
      /\b(?:blood|whole blood|blut|vollblut|sang|sangue|bloed|krew|kraujas|kraujo)\b/iu.test(text)
    )
      candidates.add('blood');
    return candidates;
  }

  function specimenTypeForGeometryRow(
    row: GeometryRow,
    observations: readonly VisionTextObservation[],
  ): SpecimenType {
    const rowSpecimens = specimenTypesFromText(observations.map((item) => item.text).join(' '));
    if (rowSpecimens.size === 1) return [...rowSpecimens][0]!;
    if (rowSpecimens.size > 1) return 'unknown';
    return isKnownSpecimenType(row.specimenKey) ? row.specimenKey : 'unknown';
  }

  function isKnownSpecimenType(value: string | null): value is SpecimenType {
    return (
      value === 'blood' ||
      value === 'serum' ||
      value === 'plasma' ||
      value === 'urine' ||
      value === 'stool' ||
      value === 'saliva' ||
      value === 'unknown'
    );
  }

  function specimenContextGroups(
    observations: readonly VisionTextObservation[],
    options: {
      /** v3 geometry context is inherited from heading rows, never from other measurement rows. */
      readonly deriveTableContextFromHeadings?: boolean;
      readonly aliases?: readonly ExtractionAliasEntry[];
    } = {},
  ): readonly {
    readonly specimenType: SpecimenType;
    readonly observations: readonly VisionTextObservation[];
  }[] {
    const tableGroups = new Map<string, VisionTextObservation[]>();
    const rowGroups = new Map<string, VisionTextObservation[]>();
    const deriveLoosePageContext = options.deriveTableContextFromHeadings === true;
    for (const observation of observations) {
      const structure = observation.structure;
      const tableKey =
        structure?.kind === 'table-cell' && structure.tableId !== null
          ? `${observation.pageIndex}:${structure.tableId}`
          : deriveLoosePageContext
            ? `${observation.pageIndex}:loose`
            : `${observation.pageIndex}:loose:${observation.id}`;
      const rowKey =
        structure?.kind === 'table-cell' &&
        structure.tableId !== null &&
        structure.rowIndex !== null
          ? `${observation.pageIndex}:${structure.tableId}:${structure.rowIndex}`
          : `${observation.pageIndex}:loose:${observation.id}`;
      const table = tableGroups.get(tableKey) ?? [];
      table.push(observation);
      tableGroups.set(tableKey, table);
      const row = rowGroups.get(rowKey) ?? [];
      row.push(observation);
      rowGroups.set(rowKey, row);
    }

    const tableSpecimens = new Map<string, SpecimenType | null>();
    for (const [tableKey, group] of tableGroups) {
      if (options.deriveTableContextFromHeadings !== true) {
        tableSpecimens.set(
          tableKey,
          specimenTypeFromText(group.map((item) => item.text).join(' ')),
        );
        continue;
      }

      // A table can contain an explicit specimen on one Measurement row while the remaining
      // rows inherit a heading-level specimen. Scanning the whole table would make that valid
      // combination look conflicting. Only rows that are not measurement-shaped can establish
      // inherited context; explicit row mentions are resolved below, per row.
      const headingSpecimens = new Set<SpecimenType>();
      for (const row of rowGroups.values()) {
        const first = row[0];
        if (first === undefined) continue;
        const structure = first.structure;
        const rowTableKey =
          structure?.kind === 'table-cell' && structure.tableId !== null
            ? `${first.pageIndex}:${structure.tableId}`
            : deriveLoosePageContext
              ? `${first.pageIndex}:loose`
              : null;
        if (rowTableKey !== tableKey) continue;
        const rowSpecimens = specimenTypesFromText(row.map((item) => item.text).join(' '));
        if (rowSpecimens.size !== 1) continue;
        const parsedMeasurements = groupObservationsIntoRows(row, {
          specimenType: 'unknown',
          aliases: options.aliases ?? [],
        });
        if (parsedMeasurements.length === 0) headingSpecimens.add([...rowSpecimens][0]!);
      }
      tableSpecimens.set(tableKey, headingSpecimens.size === 1 ? [...headingSpecimens][0]! : null);
    }

    // Trusted PDF text commonly has no table identity. If one specimen heading is found, carry
    // it across continuation pages that omit the repeated label. Multiple headings disable this
    // document fallback so mixed-specimen reports remain visibly ambiguous.
    const documentSpecimens = new Set(
      [...tableSpecimens.entries()]
        .filter(([tableKey]) => tableKey.endsWith(':loose'))
        .flatMap(([, specimen]) => (specimen === null ? [] : [specimen])),
    );
    const documentSpecimen =
      deriveLoosePageContext && documentSpecimens.size === 1 ? [...documentSpecimens][0]! : null;

    const grouped = new Map<SpecimenType, VisionTextObservation[]>();
    for (const observation of observations) {
      const structure = observation.structure;
      const tableKey =
        structure?.kind === 'table-cell' && structure.tableId !== null
          ? `${observation.pageIndex}:${structure.tableId}`
          : deriveLoosePageContext
            ? `${observation.pageIndex}:loose`
            : `${observation.pageIndex}:loose:${observation.id}`;
      const rowKey =
        structure?.kind === 'table-cell' &&
        structure.tableId !== null &&
        structure.rowIndex !== null
          ? `${observation.pageIndex}:${structure.tableId}:${structure.rowIndex}`
          : `${observation.pageIndex}:loose:${observation.id}`;
      const rowSpecimen = specimenTypeFromText(
        (rowGroups.get(rowKey) ?? [observation]).map((item) => item.text).join(' '),
      );
      const specimenType =
        rowSpecimen ?? tableSpecimens.get(tableKey) ?? documentSpecimen ?? 'unknown';
      const context = grouped.get(specimenType) ?? [];
      context.push(observation);
      grouped.set(specimenType, context);
    }
    return [...grouped.entries()].map(([specimenType, context]) => ({
      specimenType,
      observations: context,
    }));
  }

  type GeometryExtractionRows = {
    readonly rows: readonly ExtractionDraftRow[];
    readonly semanticCandidateRowIds: ReadonlySet<string>;
    readonly candidateWindows: readonly GeometryCandidateWindowGroup[];
  };

  /**
   * Converts native v3 observations into exact source-cell observations before deterministic
   * parsing. The synthetic cell keeps the parent's complete text and UTF-16 offsets, so a model
   * can select a source cell without ever authoring or normalizing a value.
   */
  function geometryCellObservation(
    cell: GeometryRow['cells'][number],
    parent: VisionTextObservation,
  ): VisionTextObservation {
    const parentStructure = parent.structure;
    return {
      id: cell.id,
      text: cell.text,
      alternatives: parent.alternatives,
      boundingBox: cell.boundingBox,
      pageIndex: cell.pageIndex,
      orientation: parent.orientation,
      structure:
        parentStructure?.kind === 'table-cell'
          ? {
              kind: 'table-cell',
              tableId: parentStructure.tableId,
              rowIndex: parentStructure.rowIndex,
              columnIndex: parentStructure.columnIndex,
            }
          : {
              kind: 'text',
              tableId: parentStructure?.tableId ?? null,
              rowIndex: null,
              columnIndex: cell.columnIndex,
            },
      sourceSpan: {
        id: `${cell.id}:source`,
        parentObservationId: cell.parentId,
        start: cell.sourceStart,
        end: cell.sourceEnd,
        text: cell.text,
        boundingBox: cell.boundingBox,
        parentText: parent.text,
      } satisfies VisionSourceSpan,
      recognition: parent.recognition,
    };
  }

  function geometryRowsForExtraction(
    observations: readonly VisionTextObservation[],
    options: {
      readonly locale: string;
      readonly collectionDate: LabDateState;
      readonly collectionDateDefaulted: boolean;
      readonly collectionDateContexts: readonly ExtractionDateContext[];
      readonly aliases: readonly ExtractionAliasEntry[];
      readonly artifact: LabSourceArtifact;
      /** Ephemeral origin marker; only trusted PDFKit observations opt into independent spans. */
      readonly trustedPdfTextLayerObservationKeys?: ReadonlySet<string>;
    },
  ): GeometryExtractionRows {
    const sourceById = new Map(observations.map((observation) => [observation.id, observation]));
    const specimenByObservationId = new Map<string, SpecimenType>();
    for (const group of specimenContextGroups(observations, {
      deriveTableContextFromHeadings: true,
      aliases: options.aliases,
    })) {
      for (const observation of group.observations)
        specimenByObservationId.set(observation.id, group.specimenType);
    }
    const dateKeyFor = (observation: VisionTextObservation): string => {
      const nearest = options.collectionDateContexts
        .filter((context) => context.pageIndex === observation.pageIndex)
        .sort(
          (left, right) =>
            Math.abs(left.centerY - observation.boundingBox.y) -
            Math.abs(right.centerY - observation.boundingBox.y),
        )[0];
      if (nearest === undefined) return options.collectionDateDefaulted ? 'defaulted' : 'unscoped';
      return `${nearest.pageIndex}:${nearest.observationId}:${nearest.collectionDate.kind === 'known' ? nearest.collectionDate.value : 'missing'}`;
    };
    const lattice = reconstructGeometryLattice(
      observations.map((observation): GeometrySourceObservation => {
        const tableId = observation.structure?.tableId ?? null;
        return {
          id: observation.id,
          text: observation.text,
          boundingBox: observation.boundingBox,
          pageIndex: observation.pageIndex,
          ...(observation.orientation === undefined
            ? {}
            : { orientation: observation.orientation }),
          ...(observation.structure === undefined ? {} : { structure: observation.structure }),
          ...(observation.spans === undefined ? {} : { spans: observation.spans }),
          context: {
            tableId,
            sectionId:
              tableId === null
                ? `page:${observation.pageIndex}:loose`
                : `${observation.pageIndex}:table:${tableId}`,
            specimenKey: specimenByObservationId.get(observation.id) ?? 'unknown',
            collectionDateKey: dateKeyFor(observation),
          },
          ...(options.trustedPdfTextLayerObservationKeys?.has(extractionObservationKey(observation))
            ? { spanPolicy: 'trusted-independent' as const }
            : {}),
        };
      }),
    );
    const unfilteredCandidateWindows = groupGeometryCandidateWindows(
      buildGeometryCandidateWindows(lattice, observations),
    );
    // PDFKit supplies exact source text but no native table identity. On those pages only, a
    // local Result-header corridor removes reference-range numbers from semantic input. Vision
    // pages retain their native structured-document path until an equally strong scan benchmark
    // exists; mixing the two admission policies would hide that provenance distinction.
    const trustedObservationIds = new Set(
      observations
        .filter((observation) =>
          options.trustedPdfTextLayerObservationKeys?.has(extractionObservationKey(observation)),
        )
        .map((observation) => observation.id),
    );
    const trustedCandidateWindows = unfilteredCandidateWindows.filter((group) =>
      group.physicalRowCells.every((cell) => trustedObservationIds.has(cell.sourceObservationId)),
    );
    const resultColumnAdmission = admitGeometryCandidateGroupsByResultColumn(
      lattice,
      trustedCandidateWindows,
      { scope: 'page-wide' },
    );
    const admittedTrustedById = new Map(
      resultColumnAdmission.groups.map((group) => [group.physicalRowId, group]),
    );
    const trustedCandidateWindowIds = new Set(
      trustedCandidateWindows.map((group) => group.physicalRowId),
    );
    const excludedTrustedIds = new Set(
      resultColumnAdmission.excludedGroups.map((group) => group.physicalRowId),
    );
    const candidateWindows = unfilteredCandidateWindows.flatMap((group) => {
      if (!trustedCandidateWindowIds.has(group.physicalRowId)) return [group];
      const admitted = admittedTrustedById.get(group.physicalRowId);
      return admitted === undefined ? [] : [admitted];
    });
    const rows: ExtractionDraftRow[] = [];
    const semanticCandidateRowIds = new Set<string>();
    for (const physicalRow of lattice.rows) {
      const rowObservations =
        physicalRow.cells.length === 0
          ? physicalRow.sourceObservationIds.flatMap((id) => {
              const source = sourceById.get(id);
              return source === undefined ? [] : [source];
            })
          : physicalRow.cells.flatMap((cell) => {
              const parent = sourceById.get(cell.sourceObservationId);
              return parent === undefined ? [] : [geometryCellObservation(cell, parent)];
            });
      if (rowObservations.length === 0) continue;
      const specimenType = specimenTypeForGeometryRow(physicalRow, rowObservations);
      const parsedRows = groupObservationsIntoRows(rowObservations, {
        locale: options.locale,
        collectionDate: options.collectionDate,
        collectionDateDefaulted: options.collectionDateDefaulted,
        collectionDateContexts: options.collectionDateContexts,
        specimenType,
        aliases: options.aliases,
        artifact: options.artifact,
      });
      const candidates = enumerateGeometryFieldCandidates(physicalRow);
      for (const parsedRow of parsedRows) {
        rows.push(parsedRow);
        // Geometry alone cannot see semantic completeness. A structurally clear row can still
        // carry an unsupported alias, so keep the parsed result in the mapper's bounded input as
        // well. Fully mapped rows with no geometry ambiguity remain out of the model request.
        if (
          candidates.requiresReview ||
          parsedRow.proposedBiomarkerId === null ||
          parsedRow.reviewReasons.includes('unsupported-alias')
        )
          semanticCandidateRowIds.add(parsedRow.id);
      }
    }
    // A multi-anchor physical row must remain visible even when concatenated deterministic
    // parsing cannot produce a measurement-shaped row. Keep one source-backed review exception
    // with an unparsed value rather than selecting an arbitrary anchor or dropping the row.
    const groupsBySourceId = new Map<string, GeometryCandidateWindowGroup[]>();
    for (const group of unfilteredCandidateWindows) {
      for (const sourceId of group.sourceObservationIds) {
        const groups = groupsBySourceId.get(sourceId) ?? [];
        groups.push(group);
        groupsBySourceId.set(sourceId, groups);
      }
    }
    const rowsByGroupId = new Map<string, ExtractionDraftRow[]>();
    for (const row of rows) {
      const groupIds = new Set(
        row.source.observationIds.flatMap((sourceId) =>
          (groupsBySourceId.get(sourceId) ?? []).map((group) => group.physicalRowId),
        ),
      );
      for (const groupId of groupIds) {
        const relatedRows = rowsByGroupId.get(groupId) ?? [];
        relatedRows.push(row);
        rowsByGroupId.set(groupId, relatedRows);
      }
    }
    const rowsToReplace = new Set<ExtractionDraftRow>();
    const fallbackRows: ExtractionDraftRow[] = [];
    for (const group of unfilteredCandidateWindows) {
      if (!excludedTrustedIds.has(group.physicalRowId)) continue;
      for (const row of rowsByGroupId.get(group.physicalRowId) ?? []) rowsToReplace.add(row);
    }
    for (const group of resultColumnAdmission.reviewGroups) {
      for (const row of rowsByGroupId.get(group.physicalRowId) ?? []) rowsToReplace.add(row);
      const fallback = physicalGroupReviewFallback(group, options);
      if (fallback !== null) fallbackRows.push(fallback);
    }
    for (const reviewRow of resultColumnAdmission.unrepresentedRows) {
      const sourceCellIds = new Set(reviewRow.physicalRow.cells.map((cell) => cell.id));
      for (const row of rows)
        if (row.source.observationIds.some((id) => sourceCellIds.has(id))) rowsToReplace.add(row);
      const fallback = physicalRowReviewFallback(reviewRow.physicalRow, options);
      if (fallback !== null) fallbackRows.push(fallback);
    }
    for (const group of candidateWindows) {
      const relatedRows = rowsByGroupId.get(group.physicalRowId) ?? [];
      // A physical row with multiple exact anchors is never safe to admit through deterministic
      // parsing, even if that parser happened to produce one survivor from the concatenated text.
      // Keep the complete source group as one review exception until semantic mapping selects an
      // exact anchor.
      if (group.anchorCellIds.length === 1 && relatedRows.length === 1) {
        continue;
      }
      for (const row of relatedRows) rowsToReplace.add(row);
      const fallback = physicalGroupReviewFallback(group, options);
      if (fallback !== null) fallbackRows.push(fallback);
    }
    rows.splice(0, rows.length, ...rows.filter((row) => !rowsToReplace.has(row)), ...fallbackRows);
    rows.sort((left, right) => {
      const leftSource = left.source.observations?.[0];
      const rightSource = right.source.observations?.[0];
      return (
        (leftSource?.pageIndex ?? 0) - (rightSource?.pageIndex ?? 0) ||
        (leftSource?.boundingBox.y ?? 0) - (rightSource?.boundingBox.y ?? 0) ||
        (leftSource?.boundingBox.x ?? 0) - (rightSource?.boundingBox.x ?? 0)
      );
    });
    return {
      rows: rows.map((row, order) => ({ ...row, order })),
      semanticCandidateRowIds,
      candidateWindows,
    };

    function physicalGroupReviewFallback(
      group: GeometryCandidateWindowGroup,
      extraction: {
        readonly collectionDate: LabDateState;
        readonly collectionDateDefaulted: boolean;
        readonly collectionDateContexts: readonly ExtractionDateContext[];
        readonly artifact: LabSourceArtifact;
      },
    ): ExtractionDraftRow | null {
      return sourceReviewFallback(
        {
          id: group.physicalRowId,
          context: group.context,
          sourceObservations: [...group.observations],
          sourceCells: group.sourceCells,
        },
        extraction,
      );
    }

    function physicalRowReviewFallback(
      physicalRow: GeometryRow,
      extraction: {
        readonly collectionDate: LabDateState;
        readonly collectionDateDefaulted: boolean;
        readonly collectionDateContexts: readonly ExtractionDateContext[];
        readonly artifact: LabSourceArtifact;
      },
    ): ExtractionDraftRow | null {
      const sourceObservations = physicalRow.cells.flatMap((cell) => {
        const parent = sourceById.get(cell.sourceObservationId);
        return parent === undefined ? [] : [geometryCellObservation(cell, parent)];
      });
      if (sourceObservations.length !== physicalRow.cells.length) return null;
      return sourceReviewFallback(
        {
          id: physicalRow.id,
          context: {
            pageIndex: physicalRow.pageIndex,
            tableId: physicalRow.tableId,
            sectionId: physicalRow.sectionId,
            specimenKey: physicalRow.specimenKey,
            collectionDateKey: physicalRow.collectionDateKey,
          },
          sourceObservations,
          sourceCells: physicalRow.cells,
        },
        extraction,
      );
    }

    function sourceReviewFallback(
      reviewSource: {
        readonly id: string;
        readonly context: GeometryCandidateWindowGroup['context'];
        readonly sourceObservations: readonly VisionTextObservation[];
        readonly sourceCells: readonly GeometryRow['cells'][number][];
      },
      extraction: {
        readonly collectionDate: LabDateState;
        readonly collectionDateDefaulted: boolean;
        readonly collectionDateContexts: readonly ExtractionDateContext[];
        readonly artifact: LabSourceArtifact;
      },
    ): ExtractionDraftRow | null {
      const sourceObservations = [...reviewSource.sourceObservations];
      const sourceText = sourceObservations
        .map((observation) => observation.text.trim())
        .join('  ');
      if (isNonMeasurementMetadataText(sourceText)) return null;
      const sourceBox = sourceObservations[0]?.boundingBox ?? {
        x: 0,
        y: 0,
        width: 0.000001,
        height: 0.000001,
      };
      const boundingBox = sourceObservations.slice(1).reduce(
        (box, observation) => ({
          x: Math.min(box.x, observation.boundingBox.x),
          y: Math.min(box.y, observation.boundingBox.y),
          width:
            Math.max(box.x + box.width, observation.boundingBox.x + observation.boundingBox.width) -
            Math.min(box.x, observation.boundingBox.x),
          height:
            Math.max(
              box.y + box.height,
              observation.boundingBox.y + observation.boundingBox.height,
            ) - Math.min(box.y, observation.boundingBox.y),
        }),
        { ...sourceBox },
      );
      const collectionDateContext =
        extraction.collectionDateContexts.find(
          (context) =>
            context.pageIndex === reviewSource.context.pageIndex &&
            reviewSource.context.collectionDateKey === geometryCollectionDateKey(context),
        ) ?? null;
      const value: ExtractionDraftRow['sourceValue'] = { kind: 'free_text', value: sourceText };
      const aliasCandidates = reviewSource.sourceCells.flatMap((cell) => {
        const id = proposeBiomarkerId(cell.text, options.aliases);
        return id === null ? [] : [{ id, text: cell.text }];
      });
      const aliasIds = [...new Set(aliasCandidates.map((candidate) => candidate.id))];
      const supportedAlias =
        aliasIds.length === 1
          ? (aliasCandidates.find((candidate) => candidate.id === aliasIds[0]) ?? null)
          : null;
      const aliasReviewReasons =
        aliasIds.length === 0
          ? (['unsupported-alias'] as const)
          : aliasIds.length > 1
            ? (['ambiguous-assay'] as const)
            : ([] as const);
      const label = supportedAlias?.text ?? sourceText;
      const specimenType = specimenTypeFromGeometryContext(reviewSource.context.specimenKey);
      return {
        id: reviewSource.id,
        order: Number.MAX_SAFE_INTEGER,
        panelLabel: null,
        sourceText,
        sourceLabel: label,
        sourceValue: value,
        sourceValueString: sourceText,
        sourceUnit: null,
        sourceReferenceInterval: null,
        sourceFlag: null,
        source: {
          pageIndex: reviewSource.context.pageIndex,
          orientation: sourceObservations[0]?.orientation ?? 0,
          artifact: extraction.artifact,
          observationIds: sourceObservations.map((observation) => observation.id),
          observations: sourceObservations,
          semantic: null,
          boundingBox,
          raw: {
            label,
            value: null,
            unit: null,
            referenceInterval: null,
            flag: null,
            collectionDate: null,
          },
        },
        collectionDateContext,
        proposedLabel: label,
        proposedValue: value,
        proposedUnit: null,
        proposedReferenceInterval: null,
        proposedFlag: null,
        proposedBiomarkerId: supportedAlias?.id ?? null,
        proposedSpecimenType: specimenType,
        collectionDate: collectionDateContext?.collectionDate ?? extraction.collectionDate,
        reviewReasons: [
          'unsupported-layout',
          'unparseable-value',
          ...aliasReviewReasons,
          ...(extraction.collectionDateDefaulted ? ['defaulted-collection-date' as const] : []),
        ],
        reviewState: 'needs-review',
        decision: 'preserve',
        editState: 'automatic',
      };
    }

    function geometryCollectionDateKey(context: ExtractionDateContext): string {
      return `${context.pageIndex}:${context.observationId}:${context.collectionDate.kind === 'known' ? context.collectionDate.value : 'missing'}`;
    }

    function specimenTypeFromGeometryContext(value: string | null): SpecimenType {
      return value === 'blood' ||
        value === 'serum' ||
        value === 'plasma' ||
        value === 'urine' ||
        value === 'stool' ||
        value === 'saliva'
        ? value
        : 'unknown';
    }
  }

  type SemanticMappingCandidate = {
    readonly candidate: ExtractionSemanticCandidateRow;
    readonly deterministicRow: ExtractionDraftRow | null;
    readonly windowGroup: GeometryCandidateWindowGroup | null;
  };

  type SemanticMappingContext = {
    readonly locale: string;
    readonly collectionDate: LabDateState;
    readonly collectionDateDefaulted: boolean;
    readonly collectionDateContexts: readonly ExtractionDateContext[];
    readonly artifact: LabSourceArtifact;
  };

  type DocumentRefinementInput = {
    readonly report: LabReport;
    readonly sourcePath: string;
    readonly password: string | null;
    readonly pageIndices: readonly number[];
    readonly candidateWindows: readonly GeometryCandidateWindowGroup[];
    readonly locale: string;
    readonly cancellation: ExtractionSemanticCancellation;
    readonly requireVerifiedOriginal: () => Promise<void>;
  };

  function documentRefinementWindows(
    deterministicRows: readonly ExtractionDraftRow[],
    candidateWindows: readonly GeometryCandidateWindowGroup[],
  ): readonly GeometryCandidateWindowGroup[] {
    const exactDeterministicAnchors = new Set(
      deterministicRows.flatMap((row) => {
        if (
          row.reviewReasons.includes('missing-label') ||
          row.reviewReasons.includes('missing-value') ||
          row.reviewReasons.includes('unparseable-value') ||
          row.reviewReasons.includes('missing-unit') ||
          row.reviewReasons.includes('incompatible-unit') ||
          row.reviewReasons.includes('ambiguous-assay') ||
          row.reviewReasons.includes('incompatible-method') ||
          row.reviewReasons.includes('unparseable-reference-interval') ||
          row.reviewReasons.includes('unsupported-layout')
        ) {
          return [];
        }
        const exactValueObservations =
          row.source.observations?.filter(
            (observation) => observation.text.trim() === row.sourceValueString.trim(),
          ) ?? [];
        return exactValueObservations.length === 1 ? [exactValueObservations[0]!.id] : [];
      }),
    );
    return candidateWindows.filter(
      (window) =>
        window.withinInputBounds &&
        window.anchorCellIds.length > 0 &&
        !(
          window.anchorCellIds.length === 1 &&
          exactDeterministicAnchors.has(window.anchorCellIds[0]!)
        ),
    );
  }

  async function extractDocumentVLMRows(
    input: DocumentRefinementInput,
  ): Promise<ReadonlyMap<number, readonly DocumentVLMRow[]>> {
    if (documentVLM === undefined || !documentVLM.supports(input.locale)) return new Map();
    const pages = input.pageIndices.filter((pageIndex) =>
      input.candidateWindows.some(
        (window) =>
          window.context.pageIndex === pageIndex &&
          window.withinInputBounds &&
          window.anchorCellIds.length > 0,
      ),
    );
    if (pages.length === 0) return new Map();

    const refinementStartedAt = elapsedTimeNow();
    const preparation = documentVLM.prepare();
    let preparationTimeout: ReturnType<typeof setTimeout> | undefined;
    let unsubscribeCancellation: () => void = () => undefined;
    const preparationOutcome = await Promise.race([
      preparation.then(
        (lease) => ({ kind: 'ready' as const, lease }),
        (error: unknown) => ({ kind: 'failed' as const, error }),
      ),
      new Promise<{ readonly kind: 'timeout' }>((resolve) => {
        preparationTimeout = setTimeout(
          () => resolve({ kind: 'timeout' }),
          documentRefinementBudgetMs,
        );
      }),
      new Promise<{ readonly kind: 'cancelled' }>((resolve) => {
        unsubscribeCancellation = input.cancellation.subscribe(() =>
          resolve({ kind: 'cancelled' }),
        );
      }),
    ]).finally(() => {
      if (preparationTimeout !== undefined) clearTimeout(preparationTimeout);
      unsubscribeCancellation();
    });
    if (preparationOutcome.kind !== 'ready') {
      // If native loading eventually finishes after our deadline/cancellation, release the late
      // lease instead of silently retaining a multi-gigabyte runtime.
      if (preparationOutcome.kind === 'timeout' || preparationOutcome.kind === 'cancelled') {
        void preparation.then((lateLease) => lateLease.release()).catch(() => undefined);
      }
      if (preparationOutcome.kind === 'cancelled' || input.cancellation.isCancelled()) {
        throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
      }
      // The model improves ambiguous associations; it does not own the source observations.
      // A load failure must leave deterministic OCR rows available for honest manual review.
      return new Map();
    }
    const lease = preparationOutcome.lease;
    const output = new Map<number, DocumentVLMRow[]>();
    let stopRefinement = false;
    try {
      for (const pageIndex of pages) {
        if (stopRefinement) break;
        if (input.cancellation.isCancelled())
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        const anchorCount = input.candidateWindows
          .filter(
            (window) =>
              window.context.pageIndex === pageIndex &&
              window.withinInputBounds &&
              window.anchorCellIds.length > 0,
          )
          .reduce((sum, window) => sum + window.anchorCellIds.length, 0);
        // Dense pages benefit from two overlapping horizontal bands; sparse English/German pages
        // retain the whole-page context that scored better in the accepted benchmark.
        const rects =
          anchorCount >= 14
            ? [
                { x: 0, y: 0, width: 1, height: 0.54 },
                { x: 0, y: 0.46, width: 1, height: 0.54 },
              ]
            : [{ x: 0, y: 0, width: 1, height: 1 }];
        const pageRows: DocumentVLMRow[] = [];
        for (const rect of rects) {
          const remainingBudget =
            documentRefinementBudgetMs - (elapsedTimeNow() - refinementStartedAt);
          if (remainingBudget < DOCUMENT_REFINEMENT_MIN_REQUEST_MS) {
            stopRefinement = true;
            break;
          }
          if (input.cancellation.isCancelled())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
          await input.requireVerifiedOriginal();
          let imageURI: string;
          let cleanup: (() => Promise<void>) | null = null;
          if (input.report.sourceType === 'pdf') {
            if (
              pdfInspector.renderExtractionBand === undefined ||
              pdfInspector.deleteExtractionBand === undefined
            ) {
              stopRefinement = true;
              break;
            }
            let rendered: Awaited<
              ReturnType<NonNullable<typeof pdfInspector.renderExtractionBand>>
            >;
            try {
              rendered = await pdfInspector.renderExtractionBand(
                input.sourcePath,
                pageIndex,
                rect,
                input.password,
              );
            } catch {
              if (input.cancellation.isCancelled())
                throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
              await input.requireVerifiedOriginal();
              stopRefinement = true;
              break;
            }
            imageURI = rendered.uri;
            cleanup = () => pdfInspector.deleteExtractionBand!(rendered.uri);
          } else {
            imageURI = input.sourcePath.startsWith('file://')
              ? input.sourcePath
              : encodeURI(`file://${input.sourcePath}`);
          }
          try {
            // Rendering and both integrity checks share one cleanup scope. A source mutation after
            // the temporary band is created must never strand that private image on disk.
            await input.requireVerifiedOriginal();
            const inferenceBudget =
              documentRefinementBudgetMs - (elapsedTimeNow() - refinementStartedAt);
            if (inferenceBudget < DOCUMENT_REFINEMENT_MIN_REQUEST_MS) {
              stopRefinement = true;
              continue;
            }
            const rows = await documentVLM.extract({
              pageIndex,
              imageURI,
              locale: input.locale,
              timeoutMs: inferenceBudget,
              maxOutputTokens: Math.min(
                2_048,
                Math.max(
                  DOCUMENT_REFINEMENT_MIN_OUTPUT_TOKENS,
                  DOCUMENT_REFINEMENT_MIN_OUTPUT_TOKENS +
                    anchorCount * DOCUMENT_REFINEMENT_TOKENS_PER_ANCHOR,
                ),
              ),
              cancellation: input.cancellation,
            });
            await input.requireVerifiedOriginal();
            pageRows.push(...rows);
          } catch (error) {
            if (
              error instanceof LabReportExtractionError &&
              (error.reason === 'original-source' || error.reason === 'cancelled')
            ) {
              throw error;
            }
            if (input.cancellation.isCancelled())
              throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
            // One malformed/failed band must not discard already source-linked OCR rows. Its
            // unresolved source windows remain visible as ordinary review work.
            if (
              error instanceof DocumentVLMUnavailableError ||
              (error instanceof Error &&
                (error.message === 'document-vlm-timeout' ||
                  error.message === 'document-vlm-runtime-quarantined'))
            ) {
              stopRefinement = true;
            }
          } finally {
            if (cleanup !== null) await cleanup();
          }
        }
        const seen = new Set<string>();
        output.set(
          pageIndex,
          pageRows.filter((row) => {
            const key = JSON.stringify(row);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          }),
        );
      }
      return output;
    } finally {
      try {
        await lease.release();
      } catch {
        // A runtime cleanup failure must not discard source-linked rows. The local-model adapter
        // quarantines unsafe in-flight work and the next import rechecks runtime availability.
      }
    }
  }

  async function applySemanticMappings(
    rows: readonly ExtractionDraftRow[],
    observations: readonly VisionTextObservation[],
    onProgress?: (completed: number, total: number) => void,
    cancellation?: ExtractionSemanticCancellation,
    semanticCandidateRowIds?: ReadonlySet<string>,
    lockSpecimenType = false,
    candidateWindows: readonly GeometryCandidateWindowGroup[] = [],
    mappingContext?: SemanticMappingContext,
    onSemanticFailure?: (reason: 'recognition' | 'model-unavailable') => void,
  ): Promise<readonly ExtractionDraftRow[]> {
    if (semanticMapper === undefined) {
      onProgress?.(0, 0);
      return rows;
    }
    const activeSemanticMapper = semanticMapper;
    const usesGeometryVariantSelector =
      semanticMapper.schemaVersion === GEOMETRY_VARIANT_SELECTOR_SCHEMA_VERSION;
    // Deterministically complete rows do not benefit from semantic mapping. Keep them out of the
    // request entirely; unresolved, ambiguous, and unsupported rows remain eligible for refinement.
    const candidateRowsForMapping = rows.filter((row) =>
      semanticCandidateRowIds === undefined
        ? row.proposedBiomarkerId === null || row.reviewReasons.length > 0
        : semanticCandidateRowIds.has(row.id),
    );
    // A model request is a bounded set of already-filtered candidate rows. Never send the whole
    // page or a raw OCR wall: unrelated headers, addresses, and footers are not model input.
    const observationById = new Map(
      observations.map((observation) => [observation.id, observation]),
    );
    const candidateGroupSourceIds = new Set(
      candidateWindows.flatMap((group) => group.sourceObservationIds),
    );
    const deterministicCandidates = (
      usesGeometryVariantSelector ? [] : candidateRowsForMapping
    ).flatMap((row): SemanticMappingCandidate[] => {
      // A geometry group is the source-row admission unit. The deterministic fallback for the
      // same physical source must remain available as draft data, but it must not be submitted as
      // a second semantic row alongside that group.
      if (row.source.observationIds.some((id) => candidateGroupSourceIds.has(id))) return [];
      const rowObservations =
        row.source.observations === undefined
          ? row.source.observationIds.flatMap((id) => {
              const observation = observationById.get(id);
              return observation === undefined ? [] : [observation];
            })
          : [...row.source.observations];
      return rowObservations.length === row.source.observationIds.length
        ? [
            {
              candidate: {
                rowId: row.id,
                sourceObservationIds: [...row.source.observationIds],
                observations: rowObservations,
              },
              deterministicRow: row,
              windowGroup: null,
            },
          ]
        : [];
    });
    const deterministicSourceAnchors = new Set(
      rows.flatMap((row) => {
        // Only rows excluded from semantic refinement lock an exact anchor. An unsupported row
        // still needs the mapper to identify its biomarker; its exact value remains source-locked
        // by the geometry group below.
        if (semanticCandidateRowIds?.has(row.id)) return [];
        if (
          row.reviewReasons.includes('missing-label') ||
          row.reviewReasons.includes('missing-value') ||
          row.sourceLabel.trim().length === 0 ||
          row.sourceLabel.trim() === row.sourceText.trim() ||
          row.sourceLabel.trim() === row.sourceValueString.trim() ||
          row.sourceLabel.trim() === row.sourceUnit?.trim()
        )
          return [];
        const matchingValueObservations =
          row.source.observations?.filter(
            (observation) => observation.text.trim() === row.sourceValueString.trim(),
          ) ?? [];
        return matchingValueObservations.length === 1 ? [matchingValueObservations[0]!.id] : [];
      }),
    );
    const windowCandidates = candidateWindows.flatMap((windowGroup): SemanticMappingCandidate[] =>
      // A complete deterministic row already owns the single exact anchor. Multi-anchor groups
      // are always retained as one mapper row so they can never be split by chunking.
      windowGroup.anchorCellIds.length === 1 &&
      deterministicSourceAnchors.has(windowGroup.anchorCellIds[0]!)
        ? []
        : [
            {
              candidate: windowGroup,
              deterministicRow: null,
              windowGroup,
            },
          ],
    );
    const mappingCandidates = [...deterministicCandidates, ...windowCandidates];
    if (mappingCandidates.length === 0) {
      onProgress?.(0, 0);
      return rows;
    }
    const physicalOrder = new Map(
      sortExtractionSemanticCandidateRows(mappingCandidates.map(({ candidate }) => candidate)).map(
        (candidate, index) => [candidate, index],
      ),
    );
    const orderedMappingCandidates = mappingCandidates
      .slice()
      .sort(
        (left, right) =>
          (physicalOrder.get(left.candidate) ?? Number.MAX_SAFE_INTEGER) -
          (physicalOrder.get(right.candidate) ?? Number.MAX_SAFE_INTEGER),
      );
    const rowGroups = new Map<string, SemanticMappingCandidate[]>();
    const allRowSourceIds = new Set([
      ...rows.flatMap((row) => row.source.observationIds),
      ...candidateWindows.flatMap((window) => window.sourceObservationIds),
    ]);
    const allRowParentIds = new Set(
      [
        ...rows.flatMap((row) => row.source.observations ?? []),
        ...candidateWindows.flatMap((row) => row.observations),
      ].flatMap((observation) => {
        const parentId = observation.sourceSpan?.parentObservationId;
        return parentId === undefined ? [] : [parentId];
      }),
    );
    // Establish one physical order before page/table grouping. Group iteration may later be
    // table-local, but every group's row sequence and first anchor now share the same ordering
    // source as compact r0/r1 serialization.
    for (const candidate of orderedMappingCandidates) {
      const first = candidate.candidate.observations[0];
      const table = first?.structure?.tableId ?? 'page';
      const key =
        candidate.windowGroup === null
          ? `${first?.pageIndex ?? candidate.deterministicRow?.source.pageIndex ?? 0}:${table}`
          : `${first?.pageIndex ?? 0}:${table}`;
      const group = rowGroups.get(key) ?? [];
      group.push(candidate);
      rowGroups.set(key, group);
    }
    const chunks: {
      readonly candidates: readonly SemanticMappingCandidate[];
      readonly rows: readonly ExtractionSemanticCandidateRow[];
      readonly headings: VisionTextObservation[];
    }[] = [];
    let semanticStageFailed = false;
    // The production adapter advertises the compact-contract bound. Legacy test/provider seams
    // without an explicit bound retain their historical row limit until they migrate to v2.
    const maxRowsPerChunk = Math.max(
      1,
      Math.min(
        semanticMapper.schemaVersion === 'alyte.semantic-mapper.v2' || usesGeometryVariantSelector
          ? 2
          : Number.MAX_SAFE_INTEGER,
        Math.floor(semanticMapper.maxRowsPerChunk ?? 12),
      ),
    );
    const maxObservationsPerChunk = Math.max(
      1,
      Math.floor(semanticMapper.maxObservationsPerChunk ?? 48),
    );
    const candidateRowsFor = (
      rowChunk: readonly SemanticMappingCandidate[],
    ): readonly ExtractionSemanticCandidateRow[] => rowChunk.map(({ candidate }) => candidate);
    const headingsFor = (
      rowChunk: readonly SemanticMappingCandidate[],
    ): VisionTextObservation[] => {
      // Preserve nearby section/table headings as context; they are never added to candidate rows.
      // Derive the anchor through the same converter used for serialization so r0 and heading
      // context cannot disagree.
      const anchor = candidateRowsFor(rowChunk)[0]?.observations[0];
      const anchorY = anchor?.boundingBox.y ?? 0;
      const anchorTableId = anchor?.structure?.tableId ?? null;
      return observations.filter((observation) => {
        const structure = observation.structure;
        if (
          allRowSourceIds.has(observation.id) ||
          allRowParentIds.has(observation.id) ||
          observation.pageIndex !== anchor?.pageIndex
        )
          return false;
        if (structure?.kind === 'table-cell' && structure.tableId === anchorTableId) return true;
        const specimenHeading = specimenTypeFromText(observation.text) !== null;
        const isAbove = observation.boundingBox.y <= anchorY;
        return specimenHeading && isAbove && anchorY - observation.boundingBox.y <= 0.25;
      });
    };
    const fitsProductionWireBudget = (rowChunk: readonly SemanticMappingCandidate[]): boolean => {
      // An explicitly bounded adapter is the production v2 seam. Check the complete prompt and
      // response reserve before handing a chunk to native inference; older custom seams retain
      // their pre-v2 test contract and do not serialize this wire format.
      if (usesGeometryVariantSelector) {
        const groups = rowChunk.flatMap(({ windowGroup }) =>
          windowGroup === null ? [] : [windowGroup],
        );
        if (groups.length !== rowChunk.length) return false;
        const anchor = groups[0]?.observations[0];
        const locale = anchor?.recognition.language ?? 'en';
        try {
          const serialized = serializeGeometryVariantSelectorChunk(
            groups,
            headingsFor(rowChunk),
            locale,
          );
          createGeometryVariantSelectorPrompt(locale, serialized);
          return true;
        } catch {
          return false;
        }
      }
      if (
        semanticMapper.maxRowsPerChunk === undefined ||
        semanticMapper.schemaVersion !== 'alyte.semantic-mapper.v2' ||
        semanticMapper.adapterVersion !== 'alyte.gemma4-e2b.semantic-mapper.v1'
      )
        return true;
      const candidateRows = candidateRowsFor(rowChunk);
      const anchor = candidateRows[0]?.observations[0];
      const locale = anchor?.recognition.language ?? 'en';
      try {
        const serialized = serializeSemanticMapperChunk(
          candidateRows,
          locale,
          headingsFor(rowChunk),
        );
        createSemanticMapperPrompt(locale, serialized);
        return true;
      } catch {
        return false;
      }
    };
    for (const group of rowGroups.values()) {
      let rowChunk: SemanticMappingCandidate[] = [];
      let rowObservationCount = 0;
      const flushChunk = () => {
        if (rowChunk.length === 0) return;
        const candidateRows = candidateRowsFor(rowChunk);
        if (candidateRows.length > 0)
          chunks.push({
            candidates: [...rowChunk],
            rows: candidateRows,
            headings: headingsFor(rowChunk),
          });
        rowChunk = [];
        rowObservationCount = 0;
      };
      for (const candidate of group) {
        const observationCount = candidate.candidate.sourceObservationIds.length;
        if (
          observationCount > maxObservationsPerChunk ||
          candidate.windowGroup?.withinInputBounds === false ||
          !fitsProductionWireBudget([candidate])
        ) {
          // Keep the deterministic row or window, but never hand an oversized row to the model adapter.
          semanticStageFailed = true;
          flushChunk();
          continue;
        }
        if (
          rowChunk.length > 0 &&
          (rowChunk.length >= maxRowsPerChunk ||
            rowObservationCount + observationCount > maxObservationsPerChunk ||
            !fitsProductionWireBudget([...rowChunk, candidate]))
        ) {
          flushChunk();
        }
        rowChunk.push(candidate);
        rowObservationCount += observationCount;
      }
      flushChunk();
    }
    const proposals: ExtractionSemanticProposal[] = [];
    onProgress?.(0, chunks.length);
    let preparationAttempted = false;
    let preparationFailed = false;
    let semanticLease: ExtractionSemanticLease | null = null;
    let semanticStageError: unknown = null;
    let semanticModelUnavailable = false;
    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (cancellation?.isCancelled())
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        const locale = chunk.rows[0]?.observations[0]?.recognition.language ?? null;
        try {
          if (!semanticMapper.supports(locale)) {
            semanticStageFailed = true;
            onProgress?.(chunkIndex + 1, chunks.length);
            continue;
          }
          // Allocate the model immediately before the first supported semantic chunk. OCR and
          // deterministic row filtering therefore complete without the multi-gigabyte runtime,
          // and one loaded session is reused for every subsequent chunk in this stage.
          if (preparationAttempted === false) {
            preparationAttempted = true;
            try {
              semanticLease = (await semanticMapper.prepare?.()) ?? null;
            } catch (error) {
              preparationFailed = true;
              throw error;
            }
          }
          const input = {
            pageIndex: chunk.rows[0]?.observations[0]?.pageIndex ?? 0,
            rows: chunk.rows,
            headings: chunk.headings,
            locale: locale ?? 'en',
            ...(cancellation === undefined ? {} : { cancellation }),
          };
          const mapped = await semanticMapper.map(input);
          if (cancellation?.isCancelled())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
          const mappedRecord =
            typeof mapped === 'object' && mapped !== null && !Array.isArray(mapped)
              ? (mapped as Record<string, unknown>)
              : null;
          const mappedIsWellShaped =
            Array.isArray(mapped) ||
            (mappedRecord !== null &&
              Array.isArray(mappedRecord.proposals) &&
              (mappedRecord.incomplete === undefined ||
                typeof mappedRecord.incomplete === 'boolean'));
          if (!mappedIsWellShaped) {
            semanticStageFailed = true;
          } else {
            proposals.push(...validateSemanticProposals(mapped, chunk.rows, extractionAliases));
            // Contract adapters must keep terminal failure distinct from a valid empty/all-null
            // review result. Accepted siblings remain useful, while the overall stage stays
            // explicitly retryable instead of becoming an empty-success draft.
            if (mappedRecord?.incomplete === true) semanticStageFailed = true;
          }
        } catch (error) {
          if (error instanceof LabReportExtractionError && error.reason === 'cancelled')
            throw error;
          if (isSemanticModelUnavailable(error)) {
            // OCR has already produced a deterministic draft. A pack disappearing during this
            // optional refinement stage must not erase that work or block Review.
            semanticModelUnavailable = true;
          }
          semanticStageFailed = true;
          if (preparationFailed) semanticModelUnavailable = true;
          // Timeouts, runtime failures, and malformed output all preserve the deterministic rows.
          // A later chunk is still allowed to complete independently; explicit cancellation aborts
          // the operation before any draft can be written.
        }
        onProgress?.(chunkIndex + 1, chunks.length);
        if (semanticModelUnavailable) {
          for (let remaining = chunkIndex + 1; remaining < chunks.length; remaining += 1)
            onProgress?.(remaining + 1, chunks.length);
          break;
        }
      }
    } catch (error) {
      semanticStageError = error;
      throw error;
    } finally {
      if (semanticLease !== null) {
        // Release only a lease acquired by this extraction. The mapper may keep a shared runtime
        // alive for another extraction, and a final release failure must remain observable.
        try {
          await semanticLease.release();
        } catch (releaseError) {
          if (semanticStageError instanceof LabReportExtractionError) {
            throw new LabReportExtractionError(
              semanticStageError.reason,
              semanticStageError.message,
              { cause: { extraction: semanticStageError, release: releaseError } },
            );
          }
          throw new Error('The on-device model could not be released after extraction', {
            cause:
              semanticStageError === null
                ? releaseError
                : { extraction: semanticStageError, release: releaseError },
          });
        }
      }
    }
    if (semanticStageFailed)
      onSemanticFailure?.(semanticModelUnavailable ? 'model-unavailable' : 'recognition');
    const proposalsBySourceKey = new Map<string, ExtractionSemanticProposal[]>();
    for (const proposal of proposals) {
      const key = JSON.stringify(proposal.sourceObservationIds);
      const matching = proposalsBySourceKey.get(key) ?? [];
      matching.push(proposal);
      proposalsBySourceKey.set(key, matching);
    }
    const proposalsForSourceIds = (
      sourceObservationIds: readonly string[],
    ): readonly ExtractionSemanticProposal[] =>
      proposalsBySourceKey.get(JSON.stringify(sourceObservationIds)) ?? [];
    const promotedWindowRows: ExtractionDraftRow[] = [];
    // A failed chunk does not invalidate proposals accepted from independent chunks. Those
    // proposals still pass the same exact-source reparse/revalidation gate; the caller records
    // the overall semantic stage as incomplete so the result remains retryable.
    for (const candidate of windowCandidates) {
      const group = candidate.windowGroup;
      if (group === null || !group.withinInputBounds) continue;
      const groupProposals = proposalsForSourceIds(candidate.candidate.sourceObservationIds);
      // Never select an arbitrary survivor. A duplicate response for one physical row is an
      // ambiguity and remains one reviewable fallback group.
      const proposal = groupProposals.length === 1 ? groupProposals[0] : undefined;
      const selectedAnchorIds =
        proposal?.sourceFields === undefined
          ? []
          : group.anchorCellIds.filter((anchorId) => proposal.sourceFields?.value === anchorId);
      if (
        proposal === undefined ||
        (proposal.role !== 'measurement' && proposal.role !== 'preserve') ||
        proposal.sourceFields === undefined ||
        selectedAnchorIds.length !== 1
      )
        continue;
      const provisional = candidateWindowDraftRow(group, proposal.sourceFields);
      if (provisional === null) continue;
      const promoted = applyProposalToRow(provisional, proposal, group.sourceObservationIds);
      if (promoted === null) continue;
      promotedWindowRows.push({
        ...promoted,
        reviewReasons: [
          ...new Set<ExtractionDraftRow['reviewReasons'][number]>([
            ...promoted.reviewReasons,
            ...provisional.reviewReasons,
          ]),
        ],
        // A geometry-qualified candidate remains explicit review work even after the model picks
        // exact source cells. The accepted proposal is extraction, not measured truth.
        reviewState: 'needs-review',
        decision: 'preserve',
      });
    }
    const mappedRows = rows.map((row) => {
      const matchingProposals = proposalsForSourceIds(row.source.observationIds);
      const proposal = matchingProposals.length === 1 ? matchingProposals[0] : undefined;
      if (proposal === undefined) return row;
      if (proposal.role === 'ignore' || proposal.role === 'specimen-context') return row;
      const mappedSpecimenType =
        proposal.proposedSpecimenType === 'other' ? 'unknown' : proposal.proposedSpecimenType;
      // v3 geometry assigns specimen context before semantic mapping. Keep that deterministic
      // result, including unknown, because the local model may not author specimen context.
      // Legacy v2 keeps its historical ability to refine an unknown row.
      const proposedSpecimenType = lockSpecimenType ? undefined : mappedSpecimenType;
      // Deterministic section/row context outranks model context. A model can refine an unknown
      // v2 row, but cannot rewrite an explicitly recognized serum/urine/blood source.
      if (
        proposedSpecimenType !== undefined &&
        row.proposedSpecimenType !== 'unknown' &&
        proposedSpecimenType !== row.proposedSpecimenType
      )
        return row;
      let next = row;
      try {
        // A v2 proposal selects exact OCR cells. Reparse only those cells so accession numbers,
        // method codes, timestamps, and other columns cannot become competing value candidates.
        if (proposal.sourceFields !== undefined) {
          next = reparseExtractionRowFromSemanticFields(
            row,
            proposal.sourceFields,
            extractionAliases,
          );
        }
        next = revalidateExtractionRow(
          next,
          {
            ...(proposal.proposedBiomarkerId === null
              ? {}
              : { proposedBiomarkerId: proposal.proposedBiomarkerId }),
            ...(proposedSpecimenType === undefined ? {} : { proposedSpecimenType }),
          },
          extractionAliases,
          proposal.sourceFields === undefined ? {} : { sourceFields: proposal.sourceFields },
        );
      } catch {
        // A malformed selection never alters the deterministic row.
        return row;
      }
      if (
        next.reviewReasons.includes('incompatible-unit') ||
        next.reviewReasons.includes('incompatible-specimen')
      )
        return row;
      return {
        ...next,
        source: {
          ...row.source,
          semantic: {
            adapterVersion: activeSemanticMapper.adapterVersion,
            schemaVersion: activeSemanticMapper.schemaVersion,
            sourceObservationIds: row.source.observationIds,
            ...(proposal.sourceFields === undefined
              ? {}
              : { sourceFieldObservationIds: proposal.sourceFields }),
            ...activeSemanticMapper.provenance,
          },
        },
      };
    });
    const groupsBySourceId = new Map<string, GeometryCandidateWindowGroup[]>();
    for (const candidate of windowCandidates) {
      const group = candidate.windowGroup;
      if (group === null) continue;
      for (const sourceId of group.sourceObservationIds) {
        const matching = groupsBySourceId.get(sourceId) ?? [];
        matching.push(group);
        groupsBySourceId.set(sourceId, matching);
      }
    }
    const legacyMappedRows = mappedRows.map((row) => {
      // v1 adapters do not return field selections. A single-anchor group can still refine the
      // deterministic fallback's identity, but it cannot select a value. Multi-anchor groups are
      // deliberately left untouched until a v2 adapter selects exactly one source anchor.
      const groups = new Set<GeometryCandidateWindowGroup>();
      for (const sourceId of row.source.observationIds) {
        for (const group of groupsBySourceId.get(sourceId) ?? []) groups.add(group);
      }
      const singleAnchorGroups = [...groups].filter((group) => group.anchorCellIds.length === 1);
      if (singleAnchorGroups.length !== 1) return row;
      const group = singleAnchorGroups[0]!;
      const groupProposals = proposalsForSourceIds(group.sourceObservationIds);
      if (groupProposals.length !== 1 || groupProposals[0]!.sourceFields !== undefined) return row;
      return applyProposalToRow(row, groupProposals[0]!, row.source.observationIds) ?? row;
    });
    if (promotedWindowRows.length === 0) return legacyMappedRows;
    return [
      ...retainRowsOutsidePromotedPhysicalGroups(legacyMappedRows, promotedWindowRows),
      ...promotedWindowRows,
    ]
      .sort((left, right) => {
        const leftSource = left.source.observations?.[0];
        const rightSource = right.source.observations?.[0];
        return (
          (leftSource?.pageIndex ?? 0) - (rightSource?.pageIndex ?? 0) ||
          (leftSource?.boundingBox.y ?? 0) - (rightSource?.boundingBox.y ?? 0) ||
          (leftSource?.boundingBox.x ?? 0) - (rightSource?.boundingBox.x ?? 0) ||
          left.id.localeCompare(right.id)
        );
      })
      .map((row, order) => ({ ...row, order }));

    function candidateWindowDraftRow(
      window: GeometryCandidateWindowGroup,
      sourceFields: ExtractionSemanticFieldSelection,
    ): ExtractionDraftRow | null {
      if (mappingContext === undefined) return null;
      const matchingVariants = window.variants.filter(
        (variant) => variant.anchorCellId === sourceFields.value,
      );
      if (matchingVariants.length !== 1) return null;
      const selectedVariant = matchingVariants[0]!;
      const selectedFieldIds = Object.values(sourceFields).filter(
        (value): value is string => value !== null,
      );
      if (
        new Set(selectedFieldIds).size !== selectedFieldIds.length ||
        selectedFieldIds.some((id) => !selectedVariant.sourceObservationIds.includes(id))
      )
        return null;
      const specimenType = specimenTypeFromGeometryContext(window.context.specimenKey);
      const collectionDateContexts = mappingContext.collectionDateContexts.filter(
        (context) =>
          context.pageIndex === window.context.pageIndex &&
          window.context.collectionDateKey === geometryCollectionDateKey(context),
      );
      const provisional = parseGeometryCandidateVariantAsProvisional(
        { ...selectedVariant, provisionalSourceFields: sourceFields },
        {
          locale: mappingContext.locale,
          collectionDate: mappingContext.collectionDate,
          collectionDateDefaulted: mappingContext.collectionDateDefaulted,
          collectionDateContexts,
          specimenType,
          aliases: extractionAliases,
          artifact: mappingContext.artifact,
          resultTableContext: window.context.tableId !== null,
        },
      );
      if (provisional === null) return null;
      const sourceObservations = [...window.observations];
      const sourceText = sourceObservations
        .map((observation) => observation.text.trim())
        .join('  ');
      return {
        ...provisional.row,
        id: window.physicalRowId,
        sourceText,
        source: {
          ...provisional.row.source,
          observationIds: [...window.sourceObservationIds],
          observations: sourceObservations,
          boundingBox: unionObservationBoxes(sourceObservations),
        },
        collectionDateContext:
          provisional.row.collectionDateContext ??
          mappingContext.collectionDateContexts.find(
            (context) =>
              context.pageIndex === window.context.pageIndex &&
              window.context.collectionDateKey === geometryCollectionDateKey(context),
          ) ??
          null,
      };
    }

    function applyProposalToRow(
      row: ExtractionDraftRow,
      proposal: ExtractionSemanticProposal,
      sourceObservationIds: readonly string[] = row.source.observationIds,
    ): ExtractionDraftRow | null {
      if (proposal.role === 'ignore' || proposal.role === 'specimen-context') return null;
      const mappedSpecimenType =
        proposal.proposedSpecimenType === 'other' ? 'unknown' : proposal.proposedSpecimenType;
      const proposedSpecimenType = lockSpecimenType ? undefined : mappedSpecimenType;
      if (
        proposedSpecimenType !== undefined &&
        row.proposedSpecimenType !== 'unknown' &&
        proposedSpecimenType !== row.proposedSpecimenType
      )
        return null;
      let next = row;
      try {
        if (proposal.sourceFields !== undefined) {
          next = reparseExtractionRowFromSemanticFields(
            row,
            proposal.sourceFields,
            extractionAliases,
          );
        }
        next = revalidateExtractionRow(
          next,
          {
            ...(proposal.proposedBiomarkerId === null
              ? {}
              : { proposedBiomarkerId: proposal.proposedBiomarkerId }),
            ...(proposedSpecimenType === undefined ? {} : { proposedSpecimenType }),
          },
          extractionAliases,
          proposal.sourceFields === undefined
            ? {}
            : {
                sourceFields: proposal.sourceFields,
                ...(mappingContext === undefined
                  ? {}
                  : {
                      collectionDate: mappingContext.collectionDate,
                      collectionDateDefaulted: mappingContext.collectionDateDefaulted,
                    }),
              },
        );
      } catch {
        return null;
      }
      if (
        next.reviewReasons.includes('incompatible-unit') ||
        next.reviewReasons.includes('incompatible-specimen')
      )
        return null;
      return {
        ...next,
        source: {
          ...row.source,
          semantic: {
            adapterVersion: activeSemanticMapper.adapterVersion,
            schemaVersion: activeSemanticMapper.schemaVersion,
            sourceObservationIds: [...sourceObservationIds],
            ...(proposal.sourceFields === undefined
              ? {}
              : { sourceFieldObservationIds: proposal.sourceFields }),
            ...activeSemanticMapper.provenance,
          },
        },
      };
    }

    function specimenTypeFromGeometryContext(value: string | null): SpecimenType {
      return value === 'blood' ||
        value === 'serum' ||
        value === 'plasma' ||
        value === 'urine' ||
        value === 'stool' ||
        value === 'saliva'
        ? value
        : 'unknown';
    }

    function geometryCollectionDateKey(context: ExtractionDateContext): string {
      return `${context.pageIndex}:${context.observationId}:${context.collectionDate.kind === 'known' ? context.collectionDate.value : 'missing'}`;
    }

    function unionObservationBoxes(
      sourceObservations: readonly VisionTextObservation[],
    ): NormalizedBoundingBox {
      const first = sourceObservations[0]?.boundingBox;
      if (first === undefined) return { x: 0, y: 0, width: 0, height: 0 };
      return sourceObservations.slice(1).reduce(
        (box, observation) => ({
          x: Math.min(box.x, observation.boundingBox.x),
          y: Math.min(box.y, observation.boundingBox.y),
          width:
            Math.max(box.x + box.width, observation.boundingBox.x + observation.boundingBox.width) -
            Math.min(box.x, observation.boundingBox.x),
          height:
            Math.max(
              box.y + box.height,
              observation.boundingBox.y + observation.boundingBox.height,
            ) - Math.min(box.y, observation.boundingBox.y),
        }),
        { ...first },
      );
    }
  }

  function extractionSourceKey(row: Pick<ExtractionDraftRow, 'source'>): string {
    // The source observation sequence is immutable provenance. It is the only safe join key for
    // an automatic retry; labels, values, and model output are all editable or untrusted.
    return JSON.stringify(row.source.observationIds);
  }

  function mergeSemanticRetryRows(
    existingRows: readonly ExtractionDraftRow[],
    regeneratedRows: readonly ExtractionDraftRow[],
    physicalGroups: readonly GeometryCandidateWindowGroup[] = [],
  ): readonly ExtractionDraftRow[] {
    const existingBySource = new Map<string, ExtractionDraftRow[]>();
    const existingBySourceId = new Map<string, ExtractionDraftRow[]>();
    for (const row of existingRows) {
      const sourceKey = extractionSourceKey(row);
      const matchingBySource = existingBySource.get(sourceKey) ?? [];
      matchingBySource.push(row);
      existingBySource.set(sourceKey, matchingBySource);
      for (const sourceId of row.source.observationIds) {
        const matchingById = existingBySourceId.get(sourceId) ?? [];
        matchingById.push(row);
        existingBySourceId.set(sourceId, matchingById);
      }
    }
    const physicalGroupsBySource = new Map(
      physicalGroups.map((group) => [JSON.stringify(group.sourceObservationIds), group] as const),
    );
    const promotedWindowRows = regeneratedRows.filter(
      (row) => row.source.semantic?.sourceFieldObservationIds !== undefined,
    );
    const promotedAnchorIds = new Set(
      promotedWindowRows
        .map((row) => row.source.semantic?.sourceFieldObservationIds?.value)
        .filter((id): id is string => id !== undefined),
    );
    const userEditedAnchorIds = new Set(
      existingRows
        .filter((row) => row.editState === 'user-edited')
        .flatMap((row) => row.source.observationIds)
        .filter((id) => promotedAnchorIds.has(id)),
    );
    const regeneratedKeys = new Set<string>();
    const consumedExistingRows = new Set<ExtractionDraftRow>();
    const merged: ExtractionDraftRow[] = [];
    for (const row of regeneratedRows) {
      const key = extractionSourceKey(row);
      const physicalGroup = physicalGroupsBySource.get(key);
      if (physicalGroup !== undefined) {
        const relatedRows = existingRowsForPhysicalGroup(physicalGroup);
        for (const related of relatedRows) consumedExistingRows.add(related);
        regeneratedKeys.add(key);
        merged.push(mergePhysicalGroupRows(row, relatedRows));
        continue;
      }
      const existing = existingBySource.get(key)?.[0];
      if (existing !== undefined) {
        regeneratedKeys.add(key);
        consumedExistingRows.add(existing);
        // Keep user decisions and edits intact. Row order is recomputed below because a retry may
        // add a newly accepted geometry window alongside the retained source row.
        if (existing.editState === 'user-edited' || row.source.semantic === null) {
          merged.push(existing);
        } else {
          merged.push({ ...row, id: existing.id });
        }
        continue;
      }
      // A retry may add a newly accepted geometry window, but never an unlinked deterministic
      // row that was absent from the retained fallback draft.
      if (
        row.source.semantic !== null &&
        row.source.semantic?.sourceFieldObservationIds !== undefined &&
        ![...row.source.observationIds].some((id) => userEditedAnchorIds.has(id))
      )
        merged.push(row);
    }
    for (const row of existingRows) {
      if (
        !consumedExistingRows.has(row) &&
        !regeneratedKeys.has(extractionSourceKey(row)) &&
        (row.editState === 'user-edited' ||
          ![...row.source.observationIds].some((id) => promotedAnchorIds.has(id)))
      )
        merged.push(row);
    }
    return merged
      .sort((left, right) => {
        const leftSource = left.source.observations?.[0];
        const rightSource = right.source.observations?.[0];
        return (
          (leftSource?.pageIndex ?? 0) - (rightSource?.pageIndex ?? 0) ||
          (leftSource?.boundingBox.y ?? 0) - (rightSource?.boundingBox.y ?? 0) ||
          (leftSource?.boundingBox.x ?? 0) - (rightSource?.boundingBox.x ?? 0) ||
          left.id.localeCompare(right.id)
        );
      })
      .map((row, order) => ({ ...row, order }));

    function existingRowsForPhysicalGroup(
      group: GeometryCandidateWindowGroup,
    ): readonly ExtractionDraftRow[] {
      const groupSourceIds = new Set(group.sourceObservationIds);
      const groupAnchorIds = new Set(group.anchorCellIds);
      const related = new Set<ExtractionDraftRow>();
      for (const sourceId of group.anchorCellIds) {
        for (const row of existingBySourceId.get(sourceId) ?? []) {
          if (
            row.source.observationIds.some((id) => groupAnchorIds.has(id)) &&
            row.source.observationIds.every((id) => groupSourceIds.has(id))
          )
            related.add(row);
        }
      }
      return [...related].sort((left, right) => left.id.localeCompare(right.id));
    }

    function mergePhysicalGroupRows(
      regenerated: ExtractionDraftRow,
      existing: readonly ExtractionDraftRow[],
    ): ExtractionDraftRow {
      if (existing.length === 0) return regenerated;
      const userEdited = existing.filter((row) => row.editState === 'user-edited');
      if (userEdited.length === 0) return { ...regenerated, id: existing[0]!.id };
      const editSignatures = new Set(userEdited.map(userEditSignature));
      if (editSignatures.size === 1) return preserveUserEdit(regenerated, userEdited[0]!);

      // Competing edits cannot identify a safe survivor. Keep one deterministic row, preserve its
      // user-edited state, and turn the result into an honest review exception without selecting
      // either value or silently treating the accepted semantic variant as authoritative.
      const sourceValue = { kind: 'free_text' as const, value: regenerated.sourceText };
      return {
        ...regenerated,
        id: userEdited[0]!.id,
        sourceValue,
        sourceValueString: regenerated.sourceText,
        proposedValue: sourceValue,
        proposedUnit: null,
        proposedReferenceInterval: null,
        proposedFlag: null,
        proposedBiomarkerId: regenerated.proposedBiomarkerId,
        reviewReasons: [
          ...new Set<ExtractionDraftRow['reviewReasons'][number]>([
            ...regenerated.reviewReasons,
            'unsupported-layout',
            'unparseable-value',
          ]),
        ],
        reviewState: 'needs-review',
        decision: 'preserve',
        editState: 'user-edited',
        source: { ...regenerated.source, semantic: null },
      };
    }

    function preserveUserEdit(
      regenerated: ExtractionDraftRow,
      existing: ExtractionDraftRow,
    ): ExtractionDraftRow {
      return {
        ...regenerated,
        id: existing.id,
        proposedLabel: existing.proposedLabel,
        proposedValue: existing.proposedValue,
        proposedUnit: existing.proposedUnit,
        proposedReferenceInterval: existing.proposedReferenceInterval,
        proposedFlag: existing.proposedFlag,
        proposedBiomarkerId: existing.proposedBiomarkerId,
        proposedSpecimenType: existing.proposedSpecimenType,
        collectionDate: existing.collectionDate,
        collectionDateContext: existing.collectionDateContext,
        reviewReasons: existing.reviewReasons,
        reviewState: existing.reviewState,
        decision: existing.decision,
        editState: 'user-edited',
        source: { ...regenerated.source, semantic: null },
      };
    }

    function userEditSignature(row: ExtractionDraftRow): string {
      return JSON.stringify([
        row.proposedLabel,
        row.proposedValue,
        row.proposedUnit,
        row.proposedReferenceInterval,
        row.proposedFlag,
        row.proposedBiomarkerId,
        row.proposedSpecimenType,
        row.collectionDate,
        row.decision,
      ]);
    }
  }

  async function runExtraction(
    id: string,
    passwordRequest?: PasswordRequest,
    mode: LabReportExtractionMode = 'start',
  ): Promise<ExtractionDraft> {
    const previousOperation = extractionOperations.get(id);
    if (previousOperation !== undefined) cancelExtractionOperation(previousOperation);
    const operationToken: ExtractionOperationToken = {
      generation: ++nextExtractionOperation,
      cancelled: false,
      cancellationListeners: new Set(),
    };
    extractionOperations.set(id, operationToken);
    return serialized(async () => {
      let password = '';
      let createdDraft: ExtractionDraft | null = null;
      let deterministicCheckpoint: ExtractionDraft | null = null;
      let activeRepo: LabRepository | null = null;
      let operationPipelineFingerprint: ExtractionPipelineFingerprint | null = null;
      let extractionRevision = 1;
      let unlockedPdfSession: PdfInspectionSession | null = null;
      const closeUnlockedPdfSession = async (): Promise<void> => {
        const session = unlockedPdfSession;
        password = '';
        if (session === null) return;
        try {
          await session.close();
          unlockedPdfSession = null;
        } catch {
          // The operation's primary result must not be replaced by best-effort capability
          // cleanup. Keeping the session retains an outer-finally retry when close fails.
        }
      };
      let replacingExistingDraft = false;
      const isCancelled = () =>
        extractionOperations.get(id) !== operationToken || operationToken.cancelled;
      const cancellation: ExtractionSemanticCancellation = {
        isCancelled,
        subscribe: (listener) => {
          if (isCancelled()) {
            listener();
            return () => undefined;
          }
          operationToken.cancellationListeners.add(listener);
          return () => operationToken.cancellationListeners.delete(listener);
        },
      };
      try {
        await ensureInitialized();
        const repo = await repository();
        activeRepo = repo;
        const report = await repo.getReport(id);
        if (report === null) throw new Error('Lab Report was not found');
        if (report.importState !== 'imported' || report.originalPath === null) {
          throw new Error('Only an imported Lab Report can be extracted');
        }
        const existingDraft = await repo.getExtractionDraftForReport(
          id,
          extractionAliases,
          currentExtractionPipelineFingerprint(report.sourceHash, 1, report.sourceType),
        );
        const staleOpenDraft =
          existingDraft?.state === 'draft' && existingDraft.pipelineStatus === 'older';
        // Starting extraction is intentionally idempotent. Returning the existing draft before
        // touching durable progress avoids a fake OCR pass and makes cached work explicit.
        if (mode === 'start' && existingDraft !== null && !staleOpenDraft) {
          return existingDraft;
        }
        if (mode === 'reprocess') {
          if (
            existingDraft === null ||
            (existingDraft.state !== 'draft' && existingDraft.state !== 'confirmed')
          ) {
            throw new LabReportExtractionError(
              'persistence',
              'Only an existing Extraction Draft can be reprocessed',
            );
          }
        }
        replacingExistingDraft =
          existingDraft?.state === 'draft' && (mode === 'reprocess' || staleOpenDraft);
        extractionRevision =
          mode === 'reprocess' || staleOpenDraft ? (existingDraft?.revision ?? 0) + 1 : 1;
        const pipelineFingerprint = currentExtractionPipelineFingerprint(
          report.sourceHash,
          extractionRevision,
          report.sourceType,
        );
        operationPipelineFingerprint = pipelineFingerprint;
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'import',
          0,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        if ((await verifySource(id)) !== 'verified') {
          throw new LabReportExtractionError(
            'original-source',
            'The protected Original Report is missing or has changed',
          );
        }
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        if (existingDraft?.state === 'failed') {
          // v11 drafts have no trustworthy artifact identity. They are explicitly invalidated by
          // migration and are removed only when a user requests regeneration.
          await repo.discardLegacyExtractionDraft(id);
        }

        const sourcePath = await openOriginal(id);
        let inspection: PdfInspection | null = null;
        const requireVerifiedOriginal = async (): Promise<void> => {
          if ((await verifySource(id)) !== 'verified') {
            throw new LabReportExtractionError(
              'original-source',
              'The Original Report changed and must be imported again',
            );
          }
        };
        const requireNotCancelled = (): void => {
          if (isCancelled())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        };
        if (report.sourceType === 'pdf') {
          try {
            requireNotCancelled();
            await requireVerifiedOriginal();
            const initial = await pdfInspector.inspect(sourcePath);
            await requireVerifiedOriginal();
            requireNotCancelled();
            if (initial.locked) {
              const request = passwordRequest ?? options.passwordRequest;
              if (request === undefined) {
                throw new LabReportExtractionError(
                  'wrong-password',
                  'A password is required to read this report',
                );
              }
              const entered = await request({ report, attempt: 1 });
              if (entered === null || entered.length === 0) {
                throw new LabReportExtractionError('cancelled', 'Password entry was cancelled');
              }
              password = entered;
              requireNotCancelled();
              await requireVerifiedOriginal();
              const session = await pdfInspector.unlock(sourcePath, password);
              unlockedPdfSession = session;
              await requireVerifiedOriginal();
              requireNotCancelled();
              inspection = session.inspection;
            } else {
              inspection = initial;
            }
          } catch (error) {
            await closeUnlockedPdfSession();
            if (error instanceof LabReportExtractionError) throw error;
            throw new LabReportExtractionError(
              isPdfPasswordFailure(error) ? 'wrong-password' : 'recognition',
              isPdfPasswordFailure(error)
                ? 'The PDF password was not accepted'
                : 'Local document inspection failed',
              { cause: error },
            );
          }
        }

        const pages =
          report.sourceType === 'pdf'
            ? (inspection?.pages ?? []).map((page) => ({
                pageIndex: page.pageIndex,
                rotation: 0,
                hasTextLayer: page.hasTextLayer,
              }))
            : [{ pageIndex: 0, rotation: 0, hasTextLayer: false }];
        if (pages.length === 0) {
          throw new LabReportExtractionError('recognition', 'The report has no readable pages');
        }
        extractionProgressEvent(id, mode, 'import', 'complete', 1, 1);
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'ocr',
          0,
          pages.length,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'ocr', 'active', 0, pages.length);
        const pageResults: ExtractionPageResult[] = [];
        try {
          for (const [pageNumber, page] of pages.entries()) {
            requireNotCancelled();
            const usePdfTextLayer =
              report.sourceType === 'pdf' &&
              page.hasTextLayer &&
              (unlockedPdfSession?.readTextLayerPage !== undefined ||
                (unlockedPdfSession === null && pdfInspector.readTextLayerPage !== undefined));
            let trustedTextLayer: VisionOCRResult | null = null;
            if (usePdfTextLayer) {
              await requireVerifiedOriginal();
              requireNotCancelled();
              try {
                if (unlockedPdfSession?.readTextLayerPage !== undefined) {
                  trustedTextLayer = await unlockedPdfSession.readTextLayerPage(page.pageIndex);
                } else if (pdfInspector.readTextLayerPage !== undefined) {
                  trustedTextLayer = await pdfInspector.readTextLayerPage(
                    sourcePath,
                    page.pageIndex,
                    password || null,
                  );
                } else {
                  throw new Error('PDF text-layer reader disappeared during extraction');
                }
              } catch (error) {
                if (error instanceof LabReportExtractionError) throw error;
                throw new LabReportExtractionError(
                  isPdfPasswordFailure(error) ? 'wrong-password' : 'recognition',
                  isPdfPasswordFailure(error)
                    ? 'The PDF password was not accepted'
                    : 'Local PDF text-layer recognition failed',
                  { cause: error },
                );
              }
              // Verify before interpreting or storing the native result. A changed source makes
              // the result unusable and must not trigger Vision fallback or later-page reads.
              await requireVerifiedOriginal();
              requireNotCancelled();
              if (trustedTextLayer === undefined) {
                throw new LabReportExtractionError(
                  'recognition',
                  'Local PDF text-layer recognition returned an invalid result',
                );
              }
            }

            if (trustedTextLayer === null) {
              requireNotCancelled();
              await requireVerifiedOriginal();
              try {
                const visionResult = await visionOCR.recognize(
                  sourcePath,
                  page.pageIndex,
                  page.rotation,
                  password || null,
                );
                await requireVerifiedOriginal();
                requireNotCancelled();
                pageResults.push({ result: visionResult, origin: 'vision' });
              } catch (error) {
                if (error instanceof LabReportExtractionError) throw error;
                if (isPdfPasswordFailure(error) && report.sourceType === 'pdf') {
                  throw new LabReportExtractionError(
                    'wrong-password',
                    'The PDF password was not accepted',
                    { cause: error },
                  );
                }
                throw new LabReportExtractionError(
                  'recognition',
                  'Local document recognition failed',
                  { cause: error },
                );
              }
            } else {
              pageResults.push({ result: trustedTextLayer, origin: 'trusted-pdf-text-layer' });
            }

            await persistExtractionOperation(
              repo,
              id,
              mode,
              'active',
              'ocr',
              pageNumber + 1,
              pages.length,
              null,
              pipelineFingerprint,
              extractionRevision,
            );
            extractionProgressEvent(id, mode, 'ocr', 'active', pageNumber + 1, pages.length);
          }
        } finally {
          // Close the unlocked document immediately after the last native page acquisition and
          // before any semantic mapping or other interpretation of the OCR results.
          await closeUnlockedPdfSession();
        }
        const results = pageResults.map(({ result }) => result);
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'ocr',
          pages.length,
          pages.length,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'ocr', 'complete', pages.length, pages.length);
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'organize',
          0,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'organize', 'active', 0, 1);

        const dateContext = dateContextFromOCR(results);
        // A report with no collection-date context gets one captured local-day fallback. The
        // source context remains null, and all rows share this injected instant until the group
        // editor changes them atomically.
        const collectionDateDefaulted = dateContext.contexts.length === 0;
        const collectionDate = collectionDateDefaulted
          ? localCalendarDateFromInstant(now())
          : dateContext.collectionDate;
        const observations = [
          ...new Map(
            results
              .flatMap((result) => result.observations)
              .filter((observation) => !dateContext.excludedObservationIds.has(observation.id))
              .map((observation) => [observation.id, observation] as const),
          ).values(),
        ];
        const trustedPdfTextLayerObservationKeys = new Set(
          pageResults.flatMap(({ result, origin }) =>
            origin === 'trusted-pdf-text-layer'
              ? result.observations.map(extractionObservationKey)
              : [],
          ),
        );
        const sourceArtifact: LabSourceArtifact = {
          kind: 'original',
          id: null,
          hash: report.sourceHash,
        };
        const locale = extractionLocaleFromOCR(results);
        const geometryExtraction = results.some(
          (result) => result.contractVersion === VISION_OCR_CONTRACT_VERSION,
        )
          ? geometryRowsForExtraction(observations, {
              locale,
              collectionDate,
              collectionDateDefaulted,
              collectionDateContexts: dateContext.contexts,
              aliases: extractionAliases,
              artifact: sourceArtifact,
              trustedPdfTextLayerObservationKeys,
            })
          : null;
        const deterministicRows =
          geometryExtraction?.rows ??
          specimenContextGroups(observations)
            .flatMap(({ observations: contextObservations, specimenType }) =>
              groupObservationsIntoRows(contextObservations, {
                locale,
                collectionDate,
                collectionDateDefaulted,
                collectionDateContexts: dateContext.contexts,
                specimenType,
                aliases: extractionAliases,
                artifact: sourceArtifact,
              }),
            )
            .sort((left, right) => {
              const leftSource = left.source.observations?.[0];
              const rightSource = right.source.observations?.[0];
              return (
                (leftSource?.pageIndex ?? 0) - (rightSource?.pageIndex ?? 0) ||
                (leftSource?.boundingBox.y ?? 0) - (rightSource?.boundingBox.y ?? 0) ||
                (leftSource?.boundingBox.x ?? 0) - (rightSource?.boundingBox.x ?? 0)
              );
            })
            .map((row, order) => ({ ...row, order }));
        // Persist the source-grounded baseline before allocating the large model runtime. If iOS
        // suspends or terminates the process during refinement, relaunch can still offer these
        // rows for review instead of making the completed OCR pass disappear.
        if (mode === 'start' && !replacingExistingDraft && deterministicRows.length > 0) {
          requireNotCancelled();
          await requireVerifiedOriginal();
          try {
            deterministicCheckpoint = await repo.createExtractionDraft({
              reportId: id,
              collectionDate,
              rows: deterministicRows,
              sourceArtifact,
              pipelineFingerprint,
              revision: extractionRevision,
            });
          } catch (error) {
            throw new LabReportExtractionError(
              'persistence',
              'The local extraction checkpoint could not be saved',
              { cause: error },
            );
          }
          createdDraft = deterministicCheckpoint;
          if ((await verifySource(id)) !== 'verified') {
            await repo.deleteExtractionDraft(deterministicCheckpoint.id);
            deterministicCheckpoint = null;
            createdDraft = null;
            throw new LabReportExtractionError(
              'original-source',
              'The Original Report changed and must be imported again',
            );
          }
        }
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'organize',
          1,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'organize', 'complete', 1, 1);
        const refinementWindows = documentRefinementWindows(
          deterministicRows,
          geometryExtraction?.candidateWindows ?? [],
        );
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'refine',
          0,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'refine', 'active', 0, 1);
        const documentRows =
          geometryExtraction === null || refinementWindows.length === 0
            ? new Map<number, readonly DocumentVLMRow[]>()
            : await extractDocumentVLMRows({
                report,
                sourcePath,
                password: password || null,
                pageIndices: pages.map((page) => page.pageIndex),
                candidateWindows: refinementWindows,
                locale,
                cancellation,
                requireVerifiedOriginal,
              });
        const deterministicValueSourceIDs = new Set(
          deterministicRows.flatMap((row) =>
            (row.source.observations ?? []).flatMap((observation) =>
              observation.text.trim() === row.sourceValueString.trim() ? [observation.id] : [],
            ),
          ),
        );
        const grounding =
          geometryExtraction === null
            ? null
            : groundDocumentVLMRows(documentRows, refinementWindows, {
                locale,
                collectionDate,
                collectionDateDefaulted,
                collectionDateContexts: dateContext.contexts,
                aliases: extractionAliases,
                artifact: sourceArtifact,
                existingSourceObservationIds: deterministicValueSourceIDs,
              });
        const matchedGroups = new Map(
          refinementWindows
            .filter((group) => grounding?.matchedPhysicalRowIds.has(group.physicalRowId))
            .map((group) => [group.physicalRowId, group] as const),
        );
        const deterministicRowsWithoutPromotedFallbacks = deterministicRows.filter((row) => {
          const rowIDs = row.source.observationIds;
          return ![...matchedGroups.values()].some((group) => {
            const sourceIDs = new Set(group.sourceObservationIds);
            const anchorIDs = new Set(group.anchorCellIds);
            return (
              rowIDs.length > 0 &&
              rowIDs.every((id) => sourceIDs.has(id)) &&
              rowIDs.some((id) => anchorIDs.has(id))
            );
          });
        });
        const sourceRows = [
          ...deterministicRowsWithoutPromotedFallbacks,
          ...(grounding?.rows ?? []),
        ]
          .sort((left, right) => {
            const leftSource = left.source.observations?.[0];
            const rightSource = right.source.observations?.[0];
            return (
              (leftSource?.pageIndex ?? left.source.pageIndex) -
                (rightSource?.pageIndex ?? right.source.pageIndex) ||
              (leftSource?.boundingBox.y ?? left.source.boundingBox.y) -
                (rightSource?.boundingBox.y ?? right.source.boundingBox.y) ||
              (leftSource?.boundingBox.x ?? left.source.boundingBox.x) -
                (rightSource?.boundingBox.x ?? right.source.boundingBox.x)
            );
          })
          .map((row, order) => ({ ...row, order }));
        let semanticFailure: 'recognition' | 'model-unavailable' | null = null;
        const rows = await applySemanticMappings(
          sourceRows,
          observations,
          undefined,
          cancellation,
          geometryExtraction?.semanticCandidateRowIds,
          geometryExtraction !== null,
          geometryExtraction?.candidateWindows,
          {
            locale,
            collectionDate,
            collectionDateDefaulted,
            collectionDateContexts: dateContext.contexts,
            artifact: sourceArtifact,
          },
          (reason) => {
            if (semanticFailure === null || reason === 'model-unavailable')
              semanticFailure = reason;
          },
        );
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        if (rows.length === 0) {
          throw new LabReportExtractionError(
            'no-reviewable-measurements',
            'Local OCR found no reviewable Measurements',
          );
        }
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'refine',
          1,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'refine', 'complete', 1, 1);
        // Reprocessing must not replace an edited current draft when optional research-only
        // refinement fails. The deterministic MVP path still completes successfully and the
        // existing draft remains the user's current work.
        if (semanticFailure !== null && replacingExistingDraft && !staleOpenDraft) {
          await persistExtractionOperation(
            repo,
            id,
            mode,
            'complete',
            'review',
            1,
            1,
            null,
            pipelineFingerprint,
            extractionRevision,
          );
          extractionProgressEvent(id, mode, 'review', 'complete', 1, 1);
          return existingDraft!;
        }
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'active',
          'review',
          0,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'review', 'active', 0, 1);
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        if ((await verifySource(id)) !== 'verified') {
          throw new LabReportExtractionError(
            'original-source',
            'The Original Report changed and must be imported again',
          );
        }
        const preserveExistingRows = staleOpenDraft && existingDraft?.state === 'draft';
        const draftRows = preserveExistingRows
          ? mergeSemanticRetryRows(existingDraft.rows, rows, geometryExtraction?.candidateWindows)
          : rows;
        const draftInput = {
          reportId: id,
          collectionDate,
          rows: draftRows,
          sourceArtifact,
          pipelineFingerprint,
          revision: extractionRevision,
        } as const;
        const existingReplacementDraft =
          replacingExistingDraft && existingDraft?.state === 'draft' ? existingDraft : null;
        if (replacingExistingDraft && existingReplacementDraft === null)
          throw new LabReportExtractionError(
            'persistence',
            'Only an open Extraction Draft can be reprocessed',
          );
        const replacementDraft = existingReplacementDraft ?? deterministicCheckpoint;
        const draft =
          replacementDraft !== null
            ? await repo.replaceExtractionDraft({
                previousDraftId: replacementDraft.id,
                ...draftInput,
                revision: extractionRevision,
                ...(preserveExistingRows ? { preserveRowIds: true } : {}),
              })
            : await repo.createExtractionDraft(draftInput);
        createdDraft = draft;
        deterministicCheckpoint = null;
        // The source can change while SQLite is writing a large draft. Reverify immediately
        // after the atomic commit as well as immediately before it. A replaced open draft is
        // restored from the exact in-memory snapshot if this post-write check fails.
        if ((await verifySource(id)) !== 'verified') {
          if (existingReplacementDraft !== null) {
            await repo.replaceExtractionDraft({
              previousDraftId: draft.id,
              id: existingReplacementDraft.id,
              reportId: existingReplacementDraft.reportId,
              collectionDate: existingReplacementDraft.collectionDate,
              rows: existingReplacementDraft.rows,
              sourceArtifact: existingReplacementDraft.sourceArtifact ?? null,
              pipelineFingerprint: existingReplacementDraft.pipelineFingerprint,
              revision: existingReplacementDraft.revision,
              ocrContractVersion: existingReplacementDraft.ocrContractVersion,
              parserVersion: existingReplacementDraft.parserVersion,
              preserveRowIds: true,
            });
          } else {
            await repo.deleteExtractionDraft(draft.id);
          }
          createdDraft = null;
          throw new LabReportExtractionError(
            'original-source',
            'The Original Report changed and must be imported again',
          );
        }
        // Cancellation at the write seam is a committed success. This avoids reporting failure
        // while exposing a replacement or deleting the exact prior draft after atomic replace.
        if (mode === 'start' && !replacingExistingDraft && isCancelled()) {
          await repo.deleteExtractionDraft(draft.id);
          createdDraft = null;
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        }
        await persistExtractionOperation(
          repo,
          id,
          mode,
          'complete',
          'review',
          1,
          1,
          null,
          pipelineFingerprint,
          extractionRevision,
        );
        extractionProgressEvent(id, mode, 'review', 'complete', 1, 1);
        if (isCancelled() && mode !== 'reprocess' && !replacingExistingDraft) {
          await repo.deleteExtractionDraft(draft.id);
          createdDraft = null;
          await persistExtractionOperation(
            repo,
            id,
            mode,
            'cancelled',
            'review',
            1,
            1,
            'cancelled',
            pipelineFingerprint,
            extractionRevision,
          );
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        }
        return draft;
      } catch (error) {
        const stage = extractionProgress.get(id)?.stage ?? 'import';
        let extractionError =
          error instanceof LabReportExtractionError
            ? error
            : new LabReportExtractionError(
                stage === 'review' ? 'persistence' : 'recognition',
                stage === 'review'
                  ? 'The local extraction draft could not be saved'
                  : 'Local document extraction failed',
                { cause: error },
              );
        const cancelled = isCancelled() || extractionError.reason === 'cancelled';
        const recoverableDraft =
          mode === 'start' && !replacingExistingDraft
            ? (deterministicCheckpoint ?? createdDraft)
            : null;
        if (
          !cancelled &&
          extractionError.reason !== 'original-source' &&
          recoverableDraft !== null
        ) {
          let sourceStillVerified = false;
          try {
            sourceStillVerified = (await verifySource(id)) === 'verified';
          } catch {
            sourceStillVerified = false;
          }
          if (sourceStillVerified) {
            // Deterministic, source-linked OCR is the durable product baseline. Refinement,
            // grounding, final replacement, or progress metadata may fail without turning that
            // already-valid review work into a failed import.
            try {
              if (activeRepo !== null)
                await persistExtractionOperation(
                  activeRepo,
                  id,
                  mode,
                  'complete',
                  'review',
                  1,
                  1,
                  null,
                  operationPipelineFingerprint,
                  extractionRevision,
                );
            } catch {
              // The controller can still navigate directly to the validated checkpoint. Relaunch
              // reconciles a remaining active operation marker as interrupted.
            }
            extractionProgressEvent(id, mode, 'review', 'complete', 1, 1);
            return recoverableDraft;
          }
          extractionError = new LabReportExtractionError(
            'original-source',
            'The Original Report changed and must be imported again',
            { cause: error },
          );
        }
        if (
          extractionError.reason === 'original-source' &&
          (deterministicCheckpoint !== null || createdDraft !== null) &&
          mode === 'start' &&
          !replacingExistingDraft
        ) {
          const invalidDraft = deterministicCheckpoint ?? createdDraft!;
          try {
            await activeRepo?.deleteExtractionDraft(invalidDraft.id);
          } catch {
            // The unreadable source remains terminal. A later retry/list reconciliation keeps the
            // invalid derived work from becoming authoritative.
          }
          if (createdDraft?.id === invalidDraft.id) createdDraft = null;
          deterministicCheckpoint = null;
        }
        if (cancelled && createdDraft !== null && mode !== 'reprocess' && !replacingExistingDraft) {
          try {
            await activeRepo?.deleteExtractionDraft(createdDraft.id);
          } catch {
            // The cancellation result remains non-success; cleanup is retried by the next run.
          }
          createdDraft = null;
        }
        const terminalReason = cancelled ? 'cancelled' : extractionError.reason;
        try {
          if (activeRepo !== null)
            await persistExtractionOperation(
              activeRepo,
              id,
              mode,
              cancelled ? 'cancelled' : 'failed',
              extractionProgress.get(id)?.stage ?? 'import',
              extractionProgress.get(id)?.completed ?? 0,
              extractionProgress.get(id)?.total ?? 0,
              terminalReason,
              operationPipelineFingerprint,
              extractionRevision,
            );
        } catch {
          // A terminal UI state is still safe if the database is unavailable; relaunch will
          // reconcile a remaining active marker as interrupted.
        }
        extractionProgressEvent(
          id,
          mode,
          extractionProgress.get(id)?.stage ?? 'import',
          cancelled ? 'cancelled' : 'failed',
          extractionProgress.get(id)?.completed ?? 0,
          extractionProgress.get(id)?.total ?? 0,
          terminalReason,
        );
        if (cancelled && extractionError.reason !== 'cancelled') {
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled', { cause: error });
        }
        throw extractionError;
      } finally {
        await closeUnlockedPdfSession();
        password = '';
        operationToken.cancellationListeners.clear();
        if (extractionOperations.get(id) === operationToken) extractionOperations.delete(id);
      }
    });
  }

  async function startExtraction(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<ExtractionDraft> {
    return runExtraction(id, passwordRequest, 'start');
  }

  async function reprocessExtraction(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<ExtractionDraft> {
    return runExtraction(id, passwordRequest, 'reprocess');
  }

  async function improveExtraction(id: string): Promise<ExtractionDraft> {
    const previousOperation = extractionOperations.get(id);
    if (previousOperation !== undefined) cancelExtractionOperation(previousOperation);
    const operationToken: ExtractionOperationToken = {
      generation: ++nextExtractionOperation,
      cancelled: false,
      cancellationListeners: new Set(),
    };
    extractionOperations.set(id, operationToken);
    return serialized(async () => {
      const isCancelled = () =>
        extractionOperations.get(id) !== operationToken || operationToken.cancelled;
      const cancellation: ExtractionSemanticCancellation = {
        isCancelled,
        subscribe: (listener) => {
          if (isCancelled()) {
            listener();
            return () => undefined;
          }
          operationToken.cancellationListeners.add(listener);
          return () => operationToken.cancellationListeners.delete(listener);
        },
      };
      try {
        await ensureInitialized();
        const repo = await repository();
        const report = await repo.getReport(id);
        if (report === null) throw new Error('Lab Report was not found');
        const draft = await repo.getExtractionDraftForReport(
          id,
          extractionAliases,
          currentExtractionPipelineFingerprint(report.sourceHash, 1, report.sourceType),
        );
        if (draft === null || draft.state !== 'draft')
          throw new LabReportExtractionError('persistence', 'Only an open draft can be improved');
        if (draft.pipelineStatus === 'older')
          throw new LabReportExtractionError(
            'persistence',
            'This Extraction Draft must be reprocessed before it can be improved',
          );
        const sourceArtifact = draft.sourceArtifact ?? null;
        if (
          sourceArtifact === null ||
          sourceArtifact.kind !== 'original' ||
          sourceArtifact.hash !== report.sourceHash ||
          (await verifySource(id)) !== 'verified'
        ) {
          throw new LabReportExtractionError(
            'original-source',
            'The Original Report is missing or has changed',
          );
        }
        if (semanticMapper === undefined) return draft;
        const eligibleIds = new Set(
          draft.rows
            .filter(
              (row) =>
                row.editState === 'automatic' &&
                row.source.observations !== undefined &&
                row.source.observations.length > 0 &&
                (row.proposedBiomarkerId === null || row.reviewReasons.length > 0) &&
                !row.reviewReasons.includes('incompatible-unit') &&
                !row.reviewReasons.includes('incompatible-specimen'),
            )
            .map((row) => row.id),
        );
        if (eligibleIds.size === 0) return draft;
        const observations = [
          ...new Map(
            draft.rows
              .flatMap((row) => row.source.observations ?? [])
              .map((observation) => [observation.id, observation] as const),
          ).values(),
        ];
        const improvedRows = await applySemanticMappings(
          draft.rows,
          observations,
          undefined,
          cancellation,
          eligibleIds,
          // geometryCellObservation marks each exact persisted source cell with a synthetic
          // source-span ID. This survives relaunch and distinguishes v3 geometry rows from the
          // legacy v2 observation shape, whose semantic specimen behavior remains unchanged.
          draft.rows.some((row) =>
            row.source.observations?.some(
              (observation) =>
                observation.sourceSpan?.id === `${observation.id}:source` &&
                observation.sourceSpan.parentObservationId.length > 0,
            ),
          ),
        );
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Improvement cancelled');
        if ((await verifySource(id)) !== 'verified')
          throw new LabReportExtractionError('original-source', 'The Original Report changed');
        const changedRows = improvedRows.filter((row, index) => {
          const before = draft.rows[index];
          return before !== undefined && JSON.stringify(before) !== JSON.stringify(row);
        });
        if (changedRows.length === 0) return draft;
        const base = draft.pipelineFingerprint;
        const fingerprint = createExtractionPipelineFingerprint(
          {
            sourceHash: report.sourceHash,
            ocrContractVersion: base?.ocrContractVersion ?? null,
            rowSegmentationVersion: base?.rowSegmentationVersion ?? null,
            parserVersion: base?.parserVersion ?? null,
            semanticAdapterVersion: semanticMapper.adapterVersion,
            semanticSchemaVersion: semanticMapper.schemaVersion,
            semanticChunkVersion: semanticMapper.provenance?.chunkVersion ?? null,
            semanticPromptVersion: semanticMapper.provenance?.promptVersion ?? null,
            modelVersion: semanticMapper.provenance?.modelVersion ?? null,
            runtimeVersion: semanticMapper.provenance?.runtimeVersion ?? null,
            catalogueVersion: semanticMapper.provenance?.catalogueVersion ?? CATALOGUE_VERSION,
            pdfTextLayerAdapterVersion: base?.pdfTextLayerAdapterVersion ?? null,
          },
          draft.revision,
        );
        return await repo.updateExtractionDraftRows({
          draftId: draft.id,
          expectedRevision: draft.revision,
          rows: changedRows,
          pipelineFingerprint: fingerprint,
        });
      } finally {
        operationToken.cancellationListeners.clear();
        if (extractionOperations.get(id) === operationToken) extractionOperations.delete(id);
      }
    });
  }

  async function getExtractionDraft(id: string): Promise<ExtractionDraft | null> {
    await ensureInitialized();
    const repo = await repository();
    const draft = await repo.getExtractionDraft(id, extractionAliases);
    if (draft === null) return null;
    const report = await repo.getReport(draft.reportId);
    return repo.getExtractionDraft(
      id,
      extractionAliases,
      currentExtractionPipelineFingerprint(
        report?.sourceHash ?? null,
        draft.revision,
        report?.sourceType,
      ),
    );
  }

  async function countOpenExtractionDrafts(): Promise<number> {
    await ensureInitialized();
    return (await repository()).countOpenExtractionDrafts();
  }

  async function listOpenExtractionDrafts(): Promise<readonly LabReportExtractionDraftReference[]> {
    await ensureInitialized();
    return (await repository()).listOpenExtractionDrafts();
  }

  async function discardExtractionDraft(id: string): Promise<void> {
    return serialized(async () => {
      await ensureInitialized();
      await (await repository()).deleteExtractionDraft(id);
    });
  }

  async function updateExtractionRow(
    id: string,
    patch: ExtractionDraftRowPatch,
    options?: ExtractionDraftRowUpdateOptions,
  ): Promise<ExtractionDraftRow> {
    await ensureInitialized();
    return (await repository()).updateExtractionDraftRow(id, patch, extractionAliases, options);
  }

  async function updateExtractionGroupDate(
    draftId: string,
    currentDate: LabDateState,
    specimenType: SpecimenType,
    collectionDate: LabDateState,
  ): Promise<ExtractionDraft> {
    await ensureInitialized();
    return (await repository()).updateExtractionDraftGroupDate(
      draftId,
      currentDate,
      specimenType,
      collectionDate,
      extractionAliases,
    );
  }

  async function confirmExtraction(id: string): Promise<readonly LabRecord[]> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const draft = await repo.getExtractionDraft(id, extractionAliases);
      if (draft === null) throw new Error('Extraction Draft was not found');
      // A draft is still extracted source material until it is confirmed. Recheck the immutable
      // Original before the first confirmation, while an already confirmed draft remains
      // readable after the user explicitly deletes its source.
      if (draft.state === 'draft') {
        const report = await repo.getReport(draft.reportId);
        const currentDraft =
          report === null
            ? null
            : await repo.getExtractionDraft(
                id,
                extractionAliases,
                currentExtractionPipelineFingerprint(report.sourceHash, 1, report.sourceType),
              );
        if (currentDraft?.pipelineStatus === 'older')
          throw new LabReportExtractionError(
            'persistence',
            'This Extraction Draft must be reprocessed before it can be confirmed',
          );
        const artifact = draft.sourceArtifact;
        if (
          report === null ||
          artifact?.kind !== 'original' ||
          artifact.id !== null ||
          artifact.hash === null ||
          artifact.hash !== report.sourceHash ||
          (await verifySource(draft.reportId)) !== 'verified'
        ) {
          throw new Error('Original Report integrity could not be verified');
        }
      }
      return repo.confirmExtractionDraft(id, extractionAliases);
    });
  }

  return {
    listReports,
    getReport,
    importPdf,
    importImages,
    retryImport,
    verifySource,
    openOriginal,
    previewOriginal,
    openOriginalViewer,
    openSanitizationEditor,
    closeSanitizationEditor,
    saveSanitizationDraft,
    discardSanitizationDraft,
    saveSanitizedReport,
    previewSanitizedReport,
    getExtractionReadiness,
    subscribeExtractionProgress,
    getExtractionProgress,
    loadExtractionProgress,
    cancelExtraction,
    getSanitizedReport,
    deleteSanitizedReport,
    deleteReport,
    startExtraction,
    reprocessExtraction,
    improveExtraction,
    listOpenExtractionDrafts,
    countOpenExtractionDrafts,
    getExtractionDraft,
    discardExtractionDraft,
    updateExtractionRow,
    updateExtractionGroupDate,
    confirmExtraction,
  };
}

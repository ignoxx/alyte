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
} from '@alyte/domain';
import {
  groupObservationsIntoRows,
  parseLabDate,
  revalidateExtractionRow,
  validateSemanticProposals,
  type ExtractionAliasEntry,
  type ExtractionDraft,
  type ExtractionDraftRow,
  type ExtractionDraftRowPatch,
  type ExtractionDateContext,
  type ExtractionSemanticCandidateRow,
  type ExtractionSemanticLease,
  type ExtractionSemanticMapper,
  type ExtractionSemanticProposal,
  type VisionTextObservation,
  type VisionOCRResult,
  type SpecimenType,
} from '@alyte/domain';
import { comparableBiomarkers } from '@alyte/catalogue';
import {
  openProtectedLabDatabase,
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

export type PasswordRequest = (context: {
  readonly report: LabReport;
  readonly attempt: number;
}) => Promise<string | null>;

export type LabReportImportResult = {
  readonly report: LabReport;
  readonly duplicate: boolean;
};

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
  readonly stage: 'import' | 'ocr' | 'model' | 'review';
  readonly status: 'active' | 'complete' | 'failed' | 'cancelled' | 'interrupted';
  readonly completed: number;
  readonly total: number;
  readonly error?: LabReportExtractionError['reason'];
};

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
      | 'model-unavailable'
      | 'original-source'
      | 'wrong-password'
      | 'cancelled'
      | 'interrupted',
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
  countOpenExtractionDrafts(): Promise<number>;
  getExtractionDraft(id: string): Promise<ExtractionDraft | null>;
  updateExtractionRow(id: string, patch: ExtractionDraftRowPatch): Promise<ExtractionDraftRow>;
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
};

/**
 * The app's one catalogue-to-extraction adapter. Tests and semantic adapters must use the same
 * projection as the running service so an alias or method-policy change cannot silently leave
 * fixture coverage behind.
 */
export function createDefaultExtractionAliases(): readonly ExtractionAliasEntry[] {
  return comparableBiomarkers.map((entry) => ({
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
  }));
}

type ImportOutcome = { readonly report: LabReport; readonly duplicate: boolean };

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
  const extractionProgress = new Map<string, LabReportExtractionProgress>();
  const extractionProgressListeners = new Set<(progress: LabReportExtractionProgress) => void>();
  let nextExtractionOperation = 0;
  const extractionOperations = new Map<
    string,
    { readonly generation: number; cancelled: boolean }
  >();
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
    stage: LabReportExtractionProgress['stage'],
    status: LabReportExtractionProgress['status'],
    completed: number,
    total: number,
    error?: LabReportExtractionProgress['error'],
  ): void {
    publishExtractionProgress({
      reportId,
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
      'model-unavailable',
      'original-source',
      'wrong-password',
      'cancelled',
      'interrupted',
    ];
    return value !== null && supported.includes(value as LabReportExtractionError['reason'])
      ? (value as LabReportExtractionError['reason'])
      : undefined;
  }

  async function persistExtractionOperation(
    repo: LabRepository,
    reportId: string,
    state: LabReportExtractionOperation['state'],
    stage: LabReportExtractionProgress['stage'],
    completed: number,
    total: number,
    error: string | null = null,
  ): Promise<void> {
    const current = await repo.getExtractionOperation(reportId);
    await repo.upsertExtractionOperation({
      reportId,
      state,
      stage,
      completed,
      total,
      error,
      createdAt: current?.createdAt ?? now(),
      updatedAt: now(),
    });
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
        return { report: duplicate, duplicate: true };
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
      return { report, duplicate: false };
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
      report = await repo.updateReport(reportId, {
        sourceHash: preservedHash,
        originalPath: preservedPath,
        importState: reason === 'cancelled' ? 'interrupted' : 'failed',
        failureReason: reason,
      });
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
    if (operationToken !== undefined) operationToken.cancelled = true;
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

  function localeForObservation(observation: VisionTextObservation): string {
    const language = observation.recognition.language?.toLowerCase().split(/[-_]/u)[0];
    const languageLocales: Record<string, string> = {
      de: 'de-DE',
      fr: 'fr-FR',
      es: 'es-ES',
      it: 'it-IT',
      pt: 'pt-PT',
      nl: 'nl-NL',
      pl: 'pl-PL',
      lt: 'lt-LT',
      en: Intl.DateTimeFormat().resolvedOptions().locale,
    };
    return languageLocales[language ?? ''] ?? Intl.DateTimeFormat().resolvedOptions().locale;
  }

  function dateIsAmbiguous(candidate: string): boolean {
    const parts = candidate.split(/[./-]/u).map(Number);
    if (parts.length !== 3 || String(parts[0]).length === 4) return false;
    return (parts[0] ?? 0) <= 12 && (parts[1] ?? 0) <= 12;
  }

  function dateContextFromOCR(results: readonly VisionOCRResult[]): {
    readonly contexts: readonly ExtractionDateContext[];
    readonly excludedObservationIds: ReadonlySet<string>;
    readonly collectionDate: LabDateState;
  } {
    const observations = [
      ...new Map(
        results
          .flatMap((result) => result.observations)
          .map((observation) => [observation.id, observation] as const),
      ).values(),
    ];
    const contexts: ExtractionDateContext[] = [];
    const excludedObservationIds = new Set<string>();
    const collectionWords =
      /\b(collection|collected|sample|specimen|date of collection|abnahme|entnahme|proben(?:entnahme)?|prélèvement|prelevement|muestra|toma de muestra|prelievo|campione|colheita|amostra|afname|monster|pobranie|próbka|paėmimo data|mėginys|ėminys|paimta)\b/iu;
    const nonCollectionWords =
      /\b(issued|report date|birth|dob|date of birth|ausgestellt|geburt|naissance|nacimiento|nascita|nascimento|geboorte|urodzenia|wydania|išdavimo data|gimimo data)\b/iu;
    for (const observation of observations) {
      const candidate = observation.text.match(/\b\d{1,4}[./-]\d{1,2}[./-]\d{1,4}\b/u)?.[0];
      if (candidate === undefined) continue;
      const center = observation.boundingBox.y + observation.boundingBox.height / 2;
      const neighbors = observations.filter(
        (other) =>
          other.pageIndex === observation.pageIndex &&
          Math.abs(other.boundingBox.y + other.boundingBox.height / 2 - center) <=
            Math.max(observation.boundingBox.height, other.boundingBox.height) * 1.5,
      );
      const lineText = neighbors.map((other) => other.text).join(' ');
      const isCollection = collectionWords.test(lineText);
      const isNonCollection = nonCollectionWords.test(lineText);
      if (!isCollection && !isNonCollection) continue;
      neighbors.forEach((other) => excludedObservationIds.add(other.id));
      if (isNonCollection) continue;
      const locale = localeForObservation(observation);
      const ambiguous = dateIsAmbiguous(candidate);
      const parsed = ambiguous ? null : parseLabDate(candidate, locale);
      contexts.push({
        observationId: observation.id,
        pageIndex: observation.pageIndex,
        centerY: center,
        locale,
        context: 'collection',
        ambiguous: ambiguous || parsed === null,
        collectionDate: parsed ?? { kind: 'missing' },
        sourceText: observation.text,
      });
    }
    const known = contexts.filter((context) => context.collectionDate.kind === 'known');
    const collectionDate =
      contexts.length === 1 && known.length === 1
        ? (known[0]?.collectionDate ?? { kind: 'missing' })
        : { kind: 'missing' as const };
    return { contexts, excludedObservationIds, collectionDate };
  }

  function specimenTypeFromText(text: string): SpecimenType | null {
    const candidates = new Set<SpecimenType>();
    if (/\bplasma\b/iu.test(text)) candidates.add('plasma');
    if (/\b(?:serum|sérum|serumas)\b/iu.test(text)) candidates.add('serum');
    if (/\b(?:urine|urin|orina|urina)\b/iu.test(text)) candidates.add('urine');
    if (
      /\b(?:blood|whole blood|blut|vollblut|sang|sangue|bloed|krew|kraujas|kraujo)\b/iu.test(text)
    )
      candidates.add('blood');
    return candidates.size === 1 ? [...candidates][0]! : null;
  }

  function specimenContextGroups(observations: readonly VisionTextObservation[]): readonly {
    readonly specimenType: SpecimenType;
    readonly observations: readonly VisionTextObservation[];
  }[] {
    const tableGroups = new Map<string, VisionTextObservation[]>();
    const rowGroups = new Map<string, VisionTextObservation[]>();
    for (const observation of observations) {
      const structure = observation.structure;
      const tableKey =
        structure?.kind === 'table-cell' && structure.tableId !== null
          ? `${observation.pageIndex}:${structure.tableId}`
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
      tableSpecimens.set(tableKey, specimenTypeFromText(group.map((item) => item.text).join(' ')));
    }

    const grouped = new Map<SpecimenType, VisionTextObservation[]>();
    for (const observation of observations) {
      const structure = observation.structure;
      const tableKey =
        structure?.kind === 'table-cell' && structure.tableId !== null
          ? `${observation.pageIndex}:${structure.tableId}`
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
      const specimenType = rowSpecimen ?? tableSpecimens.get(tableKey) ?? 'unknown';
      const context = grouped.get(specimenType) ?? [];
      context.push(observation);
      grouped.set(specimenType, context);
    }
    return [...grouped.entries()].map(([specimenType, context]) => ({
      specimenType,
      observations: context,
    }));
  }

  async function applySemanticMappings(
    rows: readonly ExtractionDraftRow[],
    observations: readonly VisionTextObservation[],
    onProgress?: (completed: number, total: number) => void,
    isCancelled?: () => boolean,
  ): Promise<readonly ExtractionDraftRow[]> {
    if (semanticMapper === undefined) {
      onProgress?.(0, 0);
      return rows;
    }
    // A model request is a bounded set of already-filtered candidate rows. Never send the whole
    // page or a raw OCR wall: unrelated headers, addresses, and footers are not model input.
    const observationById = new Map(
      observations.map((observation) => [observation.id, observation]),
    );
    const rowGroups = new Map<string, ExtractionDraftRow[]>();
    const candidateSourceIds = new Set(rows.flatMap((row) => row.source.observationIds));
    for (const row of rows) {
      const first = row.source.observations?.[0];
      const table = first?.structure?.tableId ?? 'page';
      const key = `${first?.pageIndex ?? row.source.pageIndex}:${table}`;
      const group = rowGroups.get(key) ?? [];
      group.push(row);
      rowGroups.set(key, group);
    }
    const chunks: {
      readonly rows: readonly ExtractionSemanticCandidateRow[];
      readonly headings: VisionTextObservation[];
    }[] = [];
    const maxRowsPerChunk = Math.max(1, Math.floor(semanticMapper.maxRowsPerChunk ?? 12));
    const maxObservationsPerChunk = Math.max(
      1,
      Math.floor(semanticMapper.maxObservationsPerChunk ?? 48),
    );
    for (const group of rowGroups.values()) {
      let rowChunk: ExtractionDraftRow[] = [];
      let rowObservationCount = 0;
      const flushChunk = () => {
        if (rowChunk.length === 0) return;
        const candidateRows = rowChunk.flatMap((row): ExtractionSemanticCandidateRow[] => {
          const rowObservations = row.source.observationIds.flatMap((id) => {
            const observation = observationById.get(id);
            return observation === undefined ? [] : [observation];
          });
          return rowObservations.length === row.source.observationIds.length
            ? [
                {
                  rowId: row.id,
                  sourceObservationIds: [...row.source.observationIds],
                  observations: rowObservations,
                },
              ]
            : [];
        });
        // Preserve nearby section/table headings even when Vision placed them outside the table
        // cells. A heading is context only: it is never added to the candidate row itself.
        const anchor = rowChunk[0]?.source.observations?.[0];
        const anchorY = anchor?.boundingBox.y ?? 0;
        const anchorTableId = anchor?.structure?.tableId ?? null;
        const headings = observations.filter((observation) => {
          const structure = observation.structure;
          if (candidateSourceIds.has(observation.id) || observation.pageIndex !== anchor?.pageIndex)
            return false;
          if (structure?.kind === 'table-cell' && structure.tableId === anchorTableId) return true;
          const specimenHeading = specimenTypeFromText(observation.text) !== null;
          const isAbove = observation.boundingBox.y <= anchorY;
          return specimenHeading && isAbove && anchorY - observation.boundingBox.y <= 0.25;
        });
        if (candidateRows.length > 0) chunks.push({ rows: candidateRows, headings });
        rowChunk = [];
        rowObservationCount = 0;
      };
      for (const row of group) {
        const observationCount = row.source.observationIds.length;
        if (observationCount > maxObservationsPerChunk) {
          // Keep the deterministic row, but never hand an oversized row to the model adapter.
          flushChunk();
          continue;
        }
        if (
          rowChunk.length > 0 &&
          (rowChunk.length >= maxRowsPerChunk ||
            rowObservationCount + observationCount > maxObservationsPerChunk)
        ) {
          flushChunk();
        }
        rowChunk.push(row);
        rowObservationCount += observationCount;
      }
      flushChunk();
    }
    const proposals: ExtractionSemanticProposal[] = [];
    onProgress?.(0, chunks.length);
    let preparationAttempted = false;
    let semanticLease: ExtractionSemanticLease | null = null;
    let semanticStageError: unknown = null;
    try {
      for (const [chunkIndex, chunk] of chunks.entries()) {
        if (isCancelled?.())
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        const locale = chunk.rows[0]?.observations[0]?.recognition.language ?? null;
        try {
          if (!semanticMapper.supports(locale)) {
            onProgress?.(chunkIndex + 1, chunks.length);
            continue;
          }
          // Allocate the model immediately before the first supported semantic chunk. OCR and
          // deterministic row filtering therefore complete without the multi-gigabyte runtime,
          // and one loaded session is reused for every subsequent chunk in this stage.
          if (preparationAttempted === false) {
            preparationAttempted = true;
            semanticLease = (await semanticMapper.prepare?.()) ?? null;
          }
          const input = {
            pageIndex: chunk.rows[0]?.observations[0]?.pageIndex ?? 0,
            rows: chunk.rows,
            headings: chunk.headings,
          };
          const mapped = await semanticMapper.map(input);
          if (isCancelled?.())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
          proposals.push(...validateSemanticProposals(mapped, chunk.rows, extractionAliases));
        } catch (error) {
          if (error instanceof LabReportExtractionError && error.reason === 'cancelled')
            throw error;
          if (isSemanticModelUnavailable(error)) {
            throw new LabReportExtractionError(
              'model-unavailable',
              'The verified on-device model pack became unavailable during extraction',
              { cause: error },
            );
          }
          // Timeouts, runtime failures, and malformed output all preserve the deterministic rows.
          // A later chunk is still allowed to complete independently; explicit cancellation aborts
          // the operation before any draft can be written.
        }
        onProgress?.(chunkIndex + 1, chunks.length);
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
    return rows.map((row) => {
      const proposal = proposals.find(
        (item) =>
          item.sourceObservationIds.length === row.source.observationIds.length &&
          item.sourceObservationIds.every((id, index) => id === row.source.observationIds[index]),
      );
      if (proposal === undefined) return row;
      if (proposal.role === 'ignore') return row;
      const proposedSpecimenType =
        proposal.proposedSpecimenType === 'other' ? 'unknown' : proposal.proposedSpecimenType;
      // Deterministic section/row context outranks model context. A model can refine an unknown
      // row, but cannot rewrite an explicitly recognized serum/urine/blood source.
      if (
        proposedSpecimenType !== undefined &&
        row.proposedSpecimenType !== 'unknown' &&
        proposedSpecimenType !== row.proposedSpecimenType
      )
        return row;
      const next = revalidateExtractionRow(
        row,
        {
          ...(proposal.proposedBiomarkerId === null
            ? {}
            : { proposedBiomarkerId: proposal.proposedBiomarkerId }),
          ...(proposedSpecimenType === undefined ? {} : { proposedSpecimenType }),
        },
        extractionAliases,
      );
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
            adapterVersion: semanticMapper.adapterVersion,
            schemaVersion: semanticMapper.schemaVersion,
            sourceObservationIds: proposal.sourceObservationIds,
            ...semanticMapper.provenance,
          },
        },
      };
    });
  }

  async function startExtraction(
    id: string,
    passwordRequest?: PasswordRequest,
  ): Promise<ExtractionDraft> {
    const operationToken = { generation: ++nextExtractionOperation, cancelled: false };
    extractionOperations.set(id, operationToken);
    return serialized(async () => {
      let password = '';
      let createdDraft: ExtractionDraft | null = null;
      let activeRepo: LabRepository | null = null;
      const isCancelled = () =>
        extractionOperations.get(id) !== operationToken || operationToken.cancelled;
      try {
        await ensureInitialized();
        const repo = await repository();
        activeRepo = repo;
        const report = await repo.getReport(id);
        if (report === null) throw new Error('Lab Report was not found');
        if (report.importState !== 'imported' || report.originalPath === null) {
          throw new Error('Only an imported Lab Report can be extracted');
        }
        await persistExtractionOperation(repo, id, 'active', 'import', 0, 1);
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        extractionProgressEvent(id, 'import', 'complete', 1, 1);
        if ((await verifySource(id)) !== 'verified') {
          throw new LabReportExtractionError(
            'original-source',
            'The protected Original Report is missing or has changed',
          );
        }
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        const existingDraft = await repo.getExtractionDraftForReport(id, extractionAliases);
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        if (existingDraft !== null && existingDraft.state !== 'failed') {
          await persistExtractionOperation(repo, id, 'complete', 'review', 1, 1);
          extractionProgressEvent(id, 'review', 'complete', 1, 1);
          if (isCancelled())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
          return existingDraft;
        }
        if (existingDraft?.state === 'failed') {
          // v11 drafts have no trustworthy artifact identity. They are explicitly invalidated by
          // migration and are removed only when a user requests regeneration.
          await repo.discardLegacyExtractionDraft(id);
        }

        const sourcePath = await openOriginal(id);
        let inspection: PdfInspection | null = null;
        if (report.sourceType === 'pdf') {
          try {
            const initial = await pdfInspector.inspect(sourcePath);
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
              const session = await pdfInspector.unlock(sourcePath, password);
              try {
                inspection = session.inspection;
              } finally {
                await session.close();
              }
            } else {
              inspection = initial;
            }
          } catch (error) {
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
              }))
            : [{ pageIndex: 0, rotation: 0 }];
        if (pages.length === 0) {
          throw new LabReportExtractionError('recognition', 'The report has no readable pages');
        }
        await persistExtractionOperation(repo, id, 'active', 'ocr', 0, pages.length);
        extractionProgressEvent(id, 'ocr', 'active', 0, pages.length);
        const results: VisionOCRResult[] = [];
        for (const [pageNumber, page] of pages.entries()) {
          if (isCancelled())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
          // Hash and existence are checked immediately before every Vision call. The resolved
          // path never crosses into a screen and the password exists only for this operation.
          if ((await verifySource(id)) !== 'verified') {
            throw new LabReportExtractionError(
              'original-source',
              'The Original Report changed and must be imported again',
            );
          }
          try {
            results.push(
              await visionOCR.recognize(
                sourcePath,
                page.pageIndex,
                page.rotation,
                password || null,
              ),
            );
          } catch (error) {
            if (isPdfPasswordFailure(error) && report.sourceType === 'pdf') {
              throw new LabReportExtractionError(
                'wrong-password',
                'The PDF password was not accepted',
                { cause: error },
              );
            }
            throw new LabReportExtractionError('recognition', 'Local document recognition failed', {
              cause: error,
            });
          }
          if (isCancelled())
            throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
          await persistExtractionOperation(repo, id, 'active', 'ocr', pageNumber, pages.length);
          extractionProgressEvent(id, 'ocr', 'active', pageNumber + 1, pages.length);
        }
        await persistExtractionOperation(repo, id, 'active', 'ocr', pages.length, pages.length);
        extractionProgressEvent(id, 'ocr', 'complete', pages.length, pages.length);

        const dateContext = dateContextFromOCR(results);
        const observations = [
          ...new Map(
            results
              .flatMap((result) => result.observations)
              .filter((observation) => !dateContext.excludedObservationIds.has(observation.id))
              .map((observation) => [observation.id, observation] as const),
          ).values(),
        ];
        const sourceArtifact: LabSourceArtifact = {
          kind: 'original',
          id: null,
          hash: report.sourceHash,
        };
        const deterministicRows = specimenContextGroups(observations)
          .flatMap(({ observations: contextObservations, specimenType }) =>
            groupObservationsIntoRows(contextObservations, {
              locale: Intl.DateTimeFormat().resolvedOptions().locale,
              collectionDate: dateContext.collectionDate,
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
        await persistExtractionOperation(repo, id, 'active', 'model', 0, 0);
        extractionProgressEvent(id, 'model', 'active', 0, 0);
        const rows = await applySemanticMappings(
          deterministicRows,
          observations,
          (completed, total) => extractionProgressEvent(id, 'model', 'active', completed, total),
          isCancelled,
        );
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        const modelTotal = extractionProgress.get(id)?.total ?? 0;
        await persistExtractionOperation(repo, id, 'active', 'model', modelTotal, modelTotal);
        extractionProgressEvent(id, 'model', 'complete', modelTotal, modelTotal);
        if (rows.length === 0) {
          throw new LabReportExtractionError(
            'no-reviewable-measurements',
            'Local OCR found no reviewable Measurements',
          );
        }
        await persistExtractionOperation(repo, id, 'active', 'review', 0, 1);
        extractionProgressEvent(id, 'review', 'active', 0, 1);
        if (isCancelled()) throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        if ((await verifySource(id)) !== 'verified') {
          throw new LabReportExtractionError(
            'original-source',
            'The Original Report changed and must be imported again',
          );
        }
        const draft = await repo.createExtractionDraft({
          reportId: id,
          collectionDate: dateContext.collectionDate,
          rows,
          sourceArtifact,
        });
        createdDraft = draft;
        // The source can change while SQLite is writing a large draft. Reverify immediately
        // before exposing it; a stale result is never allowed to survive this race.
        if ((await verifySource(id)) !== 'verified') {
          await repo.deleteExtractionDraft(draft.id);
          createdDraft = null;
          throw new LabReportExtractionError(
            'original-source',
            'The Original Report changed and must be imported again',
          );
        }
        if (isCancelled()) {
          await repo.deleteExtractionDraft(draft.id);
          createdDraft = null;
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        }
        await persistExtractionOperation(repo, id, 'complete', 'review', 1, 1);
        extractionProgressEvent(id, 'review', 'complete', 1, 1);
        if (isCancelled()) {
          await repo.deleteExtractionDraft(draft.id);
          createdDraft = null;
          await persistExtractionOperation(repo, id, 'cancelled', 'review', 1, 1, 'cancelled');
          throw new LabReportExtractionError('cancelled', 'Extraction cancelled');
        }
        return draft;
      } catch (error) {
        const extractionError =
          error instanceof LabReportExtractionError
            ? error
            : new LabReportExtractionError('recognition', 'Local document extraction failed', {
                cause: error,
              });
        const cancelled = isCancelled() || extractionError.reason === 'cancelled';
        if (cancelled && createdDraft !== null) {
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
              cancelled ? 'cancelled' : 'failed',
              extractionProgress.get(id)?.stage ?? 'import',
              extractionProgress.get(id)?.completed ?? 0,
              extractionProgress.get(id)?.total ?? 0,
              terminalReason,
            );
        } catch {
          // A terminal UI state is still safe if the database is unavailable; relaunch will
          // reconcile a remaining active marker as interrupted.
        }
        extractionProgressEvent(
          id,
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
        password = '';
        if (extractionOperations.get(id) === operationToken) extractionOperations.delete(id);
      }
    });
  }

  async function getExtractionDraft(id: string): Promise<ExtractionDraft | null> {
    await ensureInitialized();
    return (await repository()).getExtractionDraft(id, extractionAliases);
  }

  async function countOpenExtractionDrafts(): Promise<number> {
    await ensureInitialized();
    return (await repository()).countOpenExtractionDrafts();
  }

  async function updateExtractionRow(
    id: string,
    patch: ExtractionDraftRowPatch,
  ): Promise<ExtractionDraftRow> {
    await ensureInitialized();
    return (await repository()).updateExtractionDraftRow(id, patch, extractionAliases);
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
    countOpenExtractionDrafts,
    getExtractionDraft,
    updateExtractionRow,
    confirmExtraction,
  };
}

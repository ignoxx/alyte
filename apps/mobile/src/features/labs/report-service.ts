import {
  createSortableOpaqueId,
  createSanitizationRecipe,
  type LabReport,
  type LabDateState,
  type LabRecord,
  type LabReportSourceIntegrity,
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
  type ExtractionSemanticMapper,
  type ExtractionSemanticProposal,
  type VisionTextObservation,
  type VisionOCRResult,
  type SpecimenType,
} from '@alyte/domain';
import { comparableBiomarkers } from '@alyte/catalogue';
import { openProtectedLabDatabase, type LabRepository } from './persistence';
import {
  createProtectedReportFileService,
  deleteProtectedReportArtifacts,
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import { createSystemLabSourcePicker, type LabSourcePicker } from './pickers';
import {
  nativePdfInspector,
  type PdfInspection,
  type PdfInspector,
  type PdfSanitizationResult,
  type PdfSanitizedVerification,
} from './pdf';
import {
  nativeImageInspector,
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
      'sanitized-source' | 'recognition' | 'no-reviewable-measurements' | 'model-unavailable',
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
    sources?: readonly LabSourceSelection[],
    passwordRequest?: PasswordRequest,
  ): Promise<readonly LabReportImportResult[]>;
  retryImport(id: string, passwordRequest?: PasswordRequest): Promise<LabReport>;
  verifySource(id: string): Promise<LabReportSourceIntegrity>;
  openOriginal(id: string): Promise<string>;
  previewOriginal(id: string, passwordRequest?: PasswordRequest): Promise<LabReportPreview>;
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
  readonly imageInspector?: typeof nativeImageInspector;
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

function verificationPassed(
  verification: PdfSanitizedVerification | ImageSanitizedVerification,
  sourceType: LabReport['sourceType'],
): boolean {
  return (
    verification.verified &&
    !verification.selectableText &&
    !verification.annotations &&
    !verification.attachments &&
    !verification.metadata &&
    !verification.removableRedactions &&
    verification.reloadChecked &&
    verification.sourceAwareChecked &&
    verification.sourceContentRemoved &&
    verification.verificationVersion ===
      (sourceType === 'image' ? 'image-source-aware-v2' : 'source-aware-v1') &&
    verification.failureReasons.length === 0
  );
}

function persistedVerificationPassed(
  verification: SanitizedReportVerification | null,
  sourceType: LabReport['sourceType'],
): boolean {
  return (
    verification !== null &&
    !verification.selectableText &&
    !verification.annotations &&
    !verification.attachments &&
    !verification.metadata &&
    !verification.removableRedactions &&
    verification.reloadChecked &&
    verification.sourceAwareChecked &&
    verification.sourceContentRemoved &&
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
  const now = options.now ?? isoNow;
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));
  const sanitizationSessions = new Map<string, Awaited<ReturnType<PdfInspector['unlock']>>>();
  const sanitizationWorkspaceArtifacts = new Map<string, string>();

  function persistedPath(path: string): string {
    return fileService.portablePath === undefined ? path : fileService.portablePath(path);
  }

  async function nativePath(path: string): Promise<string> {
    return fileService.resolvePath === undefined ? path : fileService.resolvePath(path);
  }

  async function repository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    return repositoryPromise;
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
      const preservedPath = promoted === null ? null : persistedPath(promoted.path);
      const preservedHash = promoted?.sourceHash ?? staged?.sourceHash ?? null;
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
    sources?: readonly LabSourceSelection[],
    passwordRequest?: PasswordRequest,
  ): Promise<readonly LabReportImportResult[]> {
    return serialized(async () => {
      await ensureInitialized();
      const selected = sources ?? (await picker.pickImages());
      const results: LabReportImportResult[] = [];
      for (const source of selected) {
        results.push(await importOne(source, passwordRequest));
      }
      return results;
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
    const verification =
      report.sourceType === 'image'
        ? await imageInspector.verifySanitized(artifactPath, sourcePath, derivative.recipe)
        : pdfInspector.verifySanitized === undefined
          ? (() => {
              throw new LabReportSanitizationError(
                id,
                'Sanitized verification is unavailable on this device',
              );
            })()
          : await pdfInspector.verifySanitized(artifactPath);
    if (!verificationPassed(verification, report.sourceType)) {
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
    const observations = results.flatMap((result) => result.observations);
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
  ): Promise<readonly ExtractionDraftRow[]> {
    if (semanticMapper === undefined) return rows;
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
      readonly observations: VisionTextObservation[];
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
        const chunk = rowChunk.flatMap((row) =>
          row.source.observationIds.flatMap((id) => {
            const observation = observationById.get(id);
            return observation === undefined ? [] : [observation];
          }),
        );
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
        if (chunk.length > 0) chunks.push({ observations: chunk, headings });
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
    for (const chunk of chunks) {
      const locale = chunk.observations[0]?.recognition.language ?? null;
      try {
        if (!semanticMapper.supports(locale)) continue;
        const input = {
          pageIndex: chunk.observations[0]?.pageIndex ?? 0,
          observations: chunk.observations,
          headings: chunk.headings,
        };
        proposals.push(
          ...validateSemanticProposals(
            await semanticMapper.map(input),
            chunk.observations,
            extractionAliases,
          ),
        );
      } catch {
        // Inference, cancellation, timeout, unload, and malformed output all preserve the
        // deterministic rows. A later chunk is still allowed to complete independently.
      }
    }
    return rows.map((row) => {
      const proposal = proposals.find((item) =>
        item.sourceObservationIds.every((id) => row.source.observationIds.includes(id)),
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
    _passwordRequest?: PasswordRequest,
  ): Promise<ExtractionDraft> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const report = await repo.getReport(id);
      if (report === null) throw new Error('Lab Report was not found');
      if (report.importState !== 'imported' || report.originalPath === null) {
        throw new Error('Only an imported Lab Report can be extracted');
      }
      let sanitized: SanitizedReportPreview;
      try {
        sanitized = await previewSanitizedReport(id);
      } catch (error) {
        throw new LabReportExtractionError(
          'sanitized-source',
          'The verified Sanitized Report is unavailable for local extraction',
          { cause: error },
        );
      }
      // Re-verify before reusing a draft. A draft is tied to the exact derivative that
      // produced it; if that derivative disappeared or changed, it must not be confirmable.
      const existingDraft = await repo.getExtractionDraftForReport(id, extractionAliases);
      if (existingDraft !== null) return existingDraft;
      // The verified pack is a prerequisite for new automated extraction. This gate intentionally
      // happens before Vision so a missing/deleted/corrupt pack routes to the contextual reinstall
      // flow instead of being misreported as a successful deterministic fallback. Runtime errors
      // after this point remain recoverable inside applySemanticMappings.
      if (semanticMapper?.prepare !== undefined) {
        try {
          await semanticMapper.prepare();
        } catch (error) {
          throw new LabReportExtractionError(
            'model-unavailable',
            'Install the verified Gemma model pack to extract this Lab Report',
            { cause: error },
          );
        }
      }
      const sourcePath = sanitized.artifactPath;
      try {
        const results: VisionOCRResult[] = [];
        // Both PDF pages and image reports reach Vision through the same verified derivative
        // boundary. Image derivatives are flattened, orientation-normalized artifacts, so their
        // sole page is always page 0 and has no additional rotation to apply.
        const pages = sanitized.uris.map((_, pageIndex) => ({ pageIndex, rotation: 0 }));
        for (const page of pages) {
          try {
            results.push(
              await visionOCR.recognize(sourcePath, page.pageIndex, page.rotation, null),
            );
          } catch (error) {
            throw new LabReportExtractionError('recognition', 'Local document recognition failed', {
              cause: error,
            });
          }
        }
        const dateContext = dateContextFromOCR(results);
        const observations = results
          .flatMap((result) => result.observations)
          .filter((observation) => !dateContext.excludedObservationIds.has(observation.id));
        const deterministicRows = specimenContextGroups(observations)
          .flatMap(({ observations: contextObservations, specimenType }) =>
            groupObservationsIntoRows(contextObservations, {
              locale: Intl.DateTimeFormat().resolvedOptions().locale,
              collectionDate: dateContext.collectionDate,
              collectionDateContexts: dateContext.contexts,
              specimenType,
              aliases: extractionAliases,
            }),
          )
          // Context grouping is an extraction implementation detail. Restore the report's visual
          // row order before assigning draft order so interleaved specimen sections cannot move
          // source rows across one another or change their provenance sequence.
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
        const rows = await applySemanticMappings(deterministicRows, observations);
        if (rows.length === 0) {
          throw new LabReportExtractionError(
            'no-reviewable-measurements',
            'Local OCR found no reviewable Measurements',
          );
        }
        return repo.createExtractionDraft({
          reportId: id,
          collectionDate: dateContext.collectionDate,
          rows,
        });
      } finally {
        // The verified Sanitized Report is already flattened and unlocked; no source password is
        // passed to Vision or retained by extraction.
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
      return (await repository()).confirmExtractionDraft(id, extractionAliases);
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
    openSanitizationEditor,
    closeSanitizationEditor,
    saveSanitizationDraft,
    discardSanitizationDraft,
    saveSanitizedReport,
    previewSanitizedReport,
    getExtractionReadiness,
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

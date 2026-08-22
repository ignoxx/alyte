import {
  createSortableOpaqueId,
  createSanitizationRecipe,
  type LabReport,
  type LabReportSourceIntegrity,
  type SanitizationRecipe,
  type SanitizedReport,
  type SanitizedReportVerification,
  type SensitiveRegionSuggestion,
  normalizePageRotation,
  sanitizationRecipeHash,
} from '@alyte/domain';
import { openProtectedLabDatabase, type LabRepository } from './persistence';
import {
  createProtectedReportFileService,
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import { createSystemLabSourcePicker, type LabSourcePicker } from './pickers';
import {
  nativePdfInspector,
  type PdfInspection,
  type PdfInspector,
  type PdfSanitizedVerification,
} from './pdf';

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
  readonly sourceType: 'pdf';
  readonly artifactPath: string;
  readonly artifactHash: string;
  /** Rendered from the same verified artifactPath that upload/export receives. */
  readonly uris: readonly string[];
  readonly verification: PdfSanitizedVerification;
};

export type SanitizationEditorState = {
  readonly report: LabReport;
  readonly recipe: SanitizationRecipe;
  readonly suggestions: readonly SensitiveRegionSuggestion[];
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
  openSanitizationEditor(id: string): Promise<SanitizationEditorState>;
  saveSanitizedReport(id: string, recipe: SanitizationRecipe): Promise<SanitizedReport>;
  previewSanitizedReport(id: string): Promise<SanitizedReportPreview>;
  getSanitizedReport(id: string): Promise<SanitizedReport | null>;
  deleteSanitizedReport(id: string): Promise<void>;
  deleteReport(id: string): Promise<void>;
};

export type LabReportsServiceOptions = {
  readonly repositoryFactory?: () => Promise<LabRepository>;
  readonly fileService?: ProtectedReportFileService;
  readonly picker?: LabSourcePicker;
  readonly pdfInspector?: PdfInspector;
  readonly now?: () => string;
  readonly idGenerator?: (prefix: string) => string;
  readonly passwordRequest?: PasswordRequest;
};

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
  verification: PdfSanitizedVerification,
): SanitizedReportVerification {
  return {
    selectableText: verification.selectableText,
    annotations: verification.annotations,
    attachments: verification.attachments,
    metadata: verification.metadata,
    removableRedactions: verification.removableRedactions,
    recoveryChecked: verification.recoveryChecked,
  };
}

function verificationPassed(verification: PdfSanitizedVerification): boolean {
  return (
    verification.verified &&
    !verification.selectableText &&
    !verification.annotations &&
    !verification.attachments &&
    !verification.metadata &&
    !verification.removableRedactions &&
    verification.recoveryChecked &&
    verification.failureReasons.length === 0
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
  const now = options.now ?? isoNow;
  const makeId = options.idGenerator ?? ((prefix: string) => createSortableOpaqueId(prefix));

  async function repository(): Promise<LabRepository> {
    repositoryPromise ??= repositoryFactory();
    return repositoryPromise;
  }

  async function ensureInitialized(): Promise<void> {
    if (initialized) return;
    initializationPromise ??= (async () => {
      const repo = await repository();
      await fileService.initialize();
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
            originalPath: recovered.path,
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
      if (sanitized?.artifactPath !== null && sanitized?.artifactPath !== undefined) {
        await fileService.remove(sanitized.artifactPath);
      }
      if (sanitized !== null) await reportRepository.deleteSanitizedReport(sanitized.id);
      if (report.originalPath !== null) {
        const references = await reportRepository.countReportsReferencingPath(
          report.originalPath,
          report.id,
        );
        if (references === 0) {
          await fileService.remove(report.originalPath);
          if (await fileService.exists(report.originalPath)) {
            throw new Error('Original Report remained after deletion');
          }
        }
      }
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
        originalPath: promoted.path,
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
        originalPath: promoted.path,
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
      const preservedPath = promoted?.path ?? null;
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
      const result = await sourceInspection(report, report.originalPath, passwordRequest);
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
    if (!(await fileService.exists(report.originalPath))) return 'missing';
    return (await fileService.hashFile(report.originalPath)) === report.sourceHash
      ? 'verified'
      : 'mismatch';
  }

  async function openOriginal(id: string): Promise<string> {
    const report = await getReport(id);
    if (report === null) throw new Error('Lab Report was not found');
    const integrity = await verifySource(id);
    if (integrity !== 'verified' || report.originalPath === null) {
      throw new Error('Original Report integrity could not be verified');
    }
    return report.originalPath;
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

  async function openSanitizationEditor(id: string): Promise<SanitizationEditorState> {
    await ensureInitialized();
    const repo = await repository();
    const report = await repo.getReport(id);
    if (report === null) throw new Error('Lab Report was not found');
    if (report.sourceType !== 'pdf') {
      throw new LabReportSanitizationError(id, 'Only PDF Lab Reports can be sanitized');
    }
    const path = await openOriginal(id);
    const current = await repo.getSanitizedReport(id);
    const recipe = current?.recipe ?? recipeForReport(report);
    const suggestions =
      pdfInspector.suggestSensitiveRegions === undefined
        ? []
        : await pdfInspector.suggestSensitiveRegions(path);
    return { report, recipe, suggestions, current };
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
      if (report.sourceType !== 'pdf') {
        throw new LabReportSanitizationError(id, 'Only PDF Lab Reports can be sanitized');
      }
      if (recipe.reportId !== id) {
        throw new LabReportSanitizationError(id, 'Sanitization recipe belongs to another report');
      }
      if (pdfInspector.sanitize === undefined || pdfInspector.verifySanitized === undefined) {
        throw new LabReportSanitizationError(id, 'PDF sanitization is unavailable on this device');
      }
      const sourcePath = await openOriginal(id);
      const recipeHash = sanitizationRecipeHash(recipe);
      const current = await repo.getSanitizedReport(id);
      if (
        current?.verificationState === 'verified' &&
        current.recipeHash === recipeHash &&
        current.artifactPath !== null &&
        current.artifactHash !== null &&
        (await fileService.exists(current.artifactPath))
      ) {
        return current;
      }
      if (current?.artifactPath !== null && current?.artifactPath !== undefined) {
        await fileService.remove(current.artifactPath);
      }
      // A changed recipe receives a new derivative identity. The prior artifact is removed before
      // rendering, so a stale path can never be mistaken for the current exact preview.
      const derivativeId =
        current !== null && current !== undefined && current.recipeHash === recipeHash
          ? current.id
          : makeId('sanitized-report');
      const destination =
        fileService.sanitizedDestination === undefined
          ? `${sourcePath}.alyte-sanitized-${derivativeId}.pdf`
          : await fileService.sanitizedDestination(id, derivativeId);
      const pending = await repo.saveSanitizedReport({
        id: derivativeId,
        reportId: id,
        recipe,
        recipeHash,
        artifactPath: destination,
        artifactHash: null,
        byteSize: null,
        verificationState: 'pending',
        verification: null,
        failureReason: null,
        deletedAt: null,
      });
      try {
        await pdfInspector.sanitize(sourcePath, destination, recipe);
        const verification = await pdfInspector.verifySanitized(destination);
        if (!verificationPassed(verification)) {
          await fileService.remove(destination);
          return repo.updateSanitizedReport(pending.id, {
            artifactPath: null,
            artifactHash: null,
            byteSize: null,
            verificationState: 'failed',
            verification: verificationForSanitizedReport(verification),
            failureReason:
              verification.failureReasons.join('; ') || 'sanitized-verification-failed',
          });
        }
        if (fileService.protectArtifact === undefined) {
          throw new Error('Protected derivative storage is unavailable');
        }
        const protectedArtifact = await fileService.protectArtifact(destination);
        return repo.updateSanitizedReport(pending.id, {
          artifactPath: protectedArtifact.path,
          artifactHash: protectedArtifact.sourceHash,
          byteSize: protectedArtifact.byteSize,
          verificationState: 'verified',
          verification: verificationForSanitizedReport(verification),
          failureReason: null,
          deletedAt: null,
        });
      } catch (error) {
        await fileService.remove(destination).catch(() => undefined);
        await repo.updateSanitizedReport(pending.id, {
          artifactPath: null,
          artifactHash: null,
          byteSize: null,
          verificationState: 'failed',
          failureReason: error instanceof Error ? error.message : 'sanitized-render-failed',
        });
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
    const derivative = await (await repository()).getSanitizedReport(id);
    if (
      derivative === null ||
      derivative.verificationState !== 'verified' ||
      derivative.artifactPath === null ||
      derivative.artifactHash === null
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
    const actualHash = await fileService.hashFile(derivative.artifactPath);
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
    if (pdfInspector.verifySanitized === undefined) {
      throw new LabReportSanitizationError(
        id,
        'Sanitized verification is unavailable on this device',
      );
    }
    const verification = await pdfInspector.verifySanitized(derivative.artifactPath);
    if (!verificationPassed(verification)) {
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
      sourceType: 'pdf',
      artifactPath: derivative.artifactPath,
      artifactHash: derivative.artifactHash,
      uris: await pdfInspector.renderPreview(derivative.artifactPath),
      verification,
    };
  }

  async function deleteSanitizedReport(id: string): Promise<void> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const derivative = await repo.getSanitizedReport(id);
      if (derivative === null) return;
      if (derivative.artifactPath !== null) await fileService.remove(derivative.artifactPath);
      await repo.deleteSanitizedReport(derivative.id);
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
    saveSanitizedReport,
    previewSanitizedReport,
    getSanitizedReport,
    deleteSanitizedReport,
    deleteReport,
  };
}

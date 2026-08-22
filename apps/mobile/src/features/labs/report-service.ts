import {
  createSortableOpaqueId,
  type LabReport,
  type LabReportSourceIntegrity,
} from '@alyte/domain';
import { openProtectedLabDatabase, type LabRepository } from './persistence';
import {
  createProtectedReportFileService,
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import { createSystemLabSourcePicker, type LabSourcePicker } from './pickers';
import { nativePdfInspector, type PdfInspection, type PdfInspector } from './pdf';

export type PasswordRequest = (context: {
  readonly report: LabReport;
  readonly attempt: number;
}) => Promise<string | null>;

export type LabReportImportResult = {
  readonly report: LabReport;
  readonly duplicate: boolean;
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
      await repo.reconcileInterruptedReports();
      await fileService.cleanupTransientImports();
      initialized = true;
    })();
    try {
      await initializationPromise;
    } catch (error) {
      initializationPromise = null;
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

  async function deleteReport(id: string): Promise<void> {
    return serialized(async () => {
      await ensureInitialized();
      const repo = await repository();
      const report = await repo.getReport(id);
      if (report === null) return;
      if (report.originalPath !== null) {
        const references = await repo.countReportsReferencingPath(report.originalPath, id);
        if (references === 0) await fileService.remove(report.originalPath);
      }
      await repo.deleteReport(id);
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
    deleteReport,
  };
}

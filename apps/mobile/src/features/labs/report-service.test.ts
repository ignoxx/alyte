import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LabReportSourceIntegrity, VisionOCRResult } from '@alyte/domain';
import { createLabRepository, type LabRepository, type SqliteDatabase } from './persistence';
import {
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import { createLabReportsService, type LabReportsService } from './report-service';
import type { LabReportImportError } from './report-service';
import type { PdfInspection, PdfInspectionSession, PdfInspector } from './pdf';
import type { PdfSanitizedVerification } from './pdf';
import type { VisionOCR } from './vision';
import type { DatabaseProtection } from './protection';
import { addRedaction } from '@alyte/domain';

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

  async protectArtifact(path: string): Promise<ProtectedCopy> {
    const file = this.files.get(path);
    if (file === undefined) throw new Error('sanitized artifact missing');
    return { path, sourceHash: file.hash, byteSize: file.size };
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
  previewCalls = 0;
  async inspect(_path: string): Promise<PdfInspection> {
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
    return this.verification;
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
): LabReportsService {
  return createLabReportsService({
    repositoryFactory: async () => repository,
    fileService: files,
    pdfInspector: pdf,
    ...(visionOCR === undefined ? {} : { visionOCR }),
    idGenerator: (() => {
      let count = 0;
      return (prefix: string) => `${prefix}-fixed-${++count}`;
    })(),
  });
}

describe('protected Lab Report import lifecycle', () => {
  test('local extraction creates an editable draft from untrusted OCR with source provenance', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.ocr.v1',
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
    const service = createService(repository, files, new FakePdf(), ocr);
    const report = (await service.importImages([source('extraction-image', 'image')]))[0]!.report;
    const draft = await service.startExtraction(report.id);
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
    assert.equal(records[0]?.measurements[0]?.original.valueString, '3,8');
  });

  test('uses contextual collection dates, keeps ambiguity reviewable, and groups events', async () => {
    const repository = createRepository();
    const files = new FakeFiles();
    const ocr: VisionOCR = {
      async recognize(): Promise<VisionOCRResult> {
        return {
          contractVersion: 'alyte.vision.ocr.v1',
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
    const service = createService(repository, files, new FakePdf(), ocr);
    const report = (await service.importImages([source('contextual-date', 'image')]))[0]!.report;
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
      importedAt: '2026-08-22T10:00:00.000Z',
    });
    assert.equal(second.originalPath, imported.originalPath);
    await service.deleteReport(imported.id);
    assert.equal(await files.exists(imported.originalPath!), true);
    assert.equal((await repository.getReport(imported.id))?.importState, 'deleted');
    assert.equal((await repository.getReport(second.id))?.importState, 'imported');
    await service.deleteReport(second.id);
    assert.equal(await files.exists(imported.originalPath!), false);
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

  test('recipe changes regenerate a new derivative and deletion is independent from the source', async () => {
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
    const second = await service.saveSanitizedReport(imported.id, secondRecipe);
    assert.notEqual(second.recipeHash, first.recipeHash);
    assert.equal(await files.exists(first.artifactPath!), false);
    assert.equal(await files.exists(imported.originalPath!), true);
    await service.deleteSanitizedReport(imported.id);
    assert.equal(await repository.getSanitizedReport(imported.id), null);
    assert.equal(await files.exists(imported.originalPath!), true);
  });

  test('preview invalidates a derivative after hash or structural tampering', async () => {
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

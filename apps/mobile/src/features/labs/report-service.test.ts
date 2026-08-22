import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type { LabReportSourceIntegrity } from '@alyte/domain';
import { createLabRepository, type LabRepository, type SqliteDatabase } from './persistence';
import {
  type LabSourceSelection,
  type ProtectedCopy,
  type ProtectedReportFileService,
} from './file-service';
import { createLabReportsService, type LabReportsService } from './report-service';
import type { LabReportImportError } from './report-service';
import type { PdfInspection, PdfInspectionSession, PdfInspector } from './pdf';
import type { DatabaseProtection } from './protection';

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
  async inspect(_path: string): Promise<PdfInspection> {
    return this.locked
      ? { ...pdfInspection, encrypted: true, locked: true, pageCount: 0, pages: [] }
      : pdfInspection;
  }
  async unlock(_path: string, password: string): Promise<PdfInspectionSession> {
    this.passwordAttempts.push(password);
    if (password !== 'correct horse') throw new Error('Wrong password');
    return { inspection: { ...pdfInspection, encrypted: true }, close: async () => {} };
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
): LabReportsService {
  return createLabReportsService({
    repositoryFactory: async () => repository,
    fileService: files,
    pdfInspector: pdf,
    idGenerator: (() => {
      let count = 0;
      return (prefix: string) => `${prefix}-fixed-${++count}`;
    })(),
  });
}

describe('protected Lab Report import lifecycle', () => {
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
    assert.equal(reopened?.failureReason, 'interrupted');
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
});

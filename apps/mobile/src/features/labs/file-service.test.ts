import { createHash } from 'node:crypto';
import { afterEach, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import type * as FileSystemTypes from 'expo-file-system/legacy';
import {
  createProtectedReportFileService,
  PROTECTED_REPORT_DIRECTORIES,
  type LabSourceSelection,
} from './file-service';
import type { ProtectedPathProtection } from './protection';

class SyntheticFileSystem {
  readonly documentDirectory: string;
  readonly directories = new Set<string>();
  readonly files = new Map<string, { content: string }>();
  readonly copies: Array<{ from: string; to: string }> = [];
  failNextCopyAfterPartial = false;

  constructor(documentDirectory = 'file:///sandbox/') {
    this.documentDirectory = documentDirectory;
  }

  async getInfoAsync(path: string) {
    const file = this.files.get(path);
    if (file !== undefined) {
      return {
        exists: true as const,
        uri: path,
        isDirectory: false as const,
        size: file.content.length,
        modificationTime: 0,
      };
    }
    if (this.directories.has(path)) {
      return {
        exists: true as const,
        uri: path,
        isDirectory: true as const,
        size: 0,
        modificationTime: 0,
      };
    }
    return { exists: false as const, uri: path, isDirectory: false as const };
  }

  async makeDirectoryAsync(path: string): Promise<void> {
    this.directories.add(path.replace(/\/$/, ''));
  }

  async copyAsync({ from, to }: { from: string; to: string }): Promise<void> {
    const source = this.files.get(from);
    if (source === undefined) throw new Error(`source missing: ${from}`);
    this.copies.push({ from, to });
    this.files.set(to, { content: source.content });
    if (this.failNextCopyAfterPartial) {
      this.failNextCopyAfterPartial = false;
      throw new Error('storage exhausted during copy');
    }
  }

  async deleteAsync(path: string): Promise<void> {
    this.files.delete(path);
  }

  async readDirectoryAsync(path: string): Promise<string[]> {
    const prefix = `${path.replace(/\/$/, '')}/`;
    return [...this.files.keys()]
      .filter(
        (candidate) =>
          candidate.startsWith(prefix) && !candidate.slice(prefix.length).includes('/'),
      )
      .map((candidate) => candidate.slice(prefix.length));
  }
}

function makeSource(uri = 'file:///picker/report.pdf'): LabSourceSelection {
  return {
    uri,
    name: 'report.pdf',
    mimeType: 'application/pdf',
    sourceType: 'pdf',
    byteSize: 17,
  };
}

function makeFixture(documentDirectory?: string) {
  const fileSystem = new SyntheticFileSystem(documentDirectory);
  fileSystem.files.set('file:///picker/report.pdf', { content: 'synthetic-pdf-data' });
  const protectedPaths: string[] = [];
  const protection: ProtectedPathProtection = {
    async protectPath(path) {
      protectedPaths.push(path);
      return { protectedPaths: [path] };
    },
    async hashFile(path) {
      const file = fileSystem.files.get(path);
      if (file === undefined) throw new Error(`file missing: ${path}`);
      return createHash('sha256').update(file.content).digest('hex');
    },
  };
  const service = createProtectedReportFileService({
    fileSystem: fileSystem as unknown as typeof FileSystemTypes,
    protection,
    rootDirectory: fileSystem.documentDirectory,
  });
  return { fileSystem, protectedPaths, service };
}

describe('protected Original Report file adapter', () => {
  let fixtures: ReturnType<typeof makeFixture>[] = [];

  afterEach(() => {
    fixtures = [];
  });

  test('protects, hashes, and promotes a synthetic source without mutating the picker file', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const { protectedPaths, service } = fixture;
    await service.initialize();

    const staged = await service.stage(makeSource(), 'import-1');
    const promoted = await service.promote(staged, 'report-1', makeSource());

    assert.match(staged.sourceHash, /^[a-f0-9]{64}$/);
    assert.equal(promoted.sourceHash, staged.sourceHash);
    assert.equal(await service.exists(promoted.path), true);
    assert.equal(await service.exists('file:///picker/report.pdf'), true);
    assert.ok(protectedPaths.includes(promoted.path));
    assert.ok(protectedPaths.includes('file:///sandbox/alyte-protected/original-reports'));
  });

  test('cleans a partial stage when storage fails after the destination is created', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    fixture.fileSystem.failNextCopyAfterPartial = true;

    await assert.rejects(fixture.service.stage(makeSource(), 'import-low-storage'), /storage/);
    assert.equal(
      [...fixture.fileSystem.files.keys()].some((path) =>
        path.includes(PROTECTED_REPORT_DIRECTORIES.transient),
      ),
      false,
    );
  });

  test('cleans a partial promotion and transient source remains retry-cleanable', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    const staged = await fixture.service.stage(makeSource(), 'import-promote');
    fixture.fileSystem.failNextCopyAfterPartial = true;

    await assert.rejects(
      fixture.service.promote(staged, 'report-promote', makeSource()),
      /storage/,
    );
    assert.equal(
      [...fixture.fileSystem.files.keys()].some((path) => path.includes('/original-reports/')),
      false,
    );
    await fixture.service.cleanupTransientImports();
    assert.equal(await fixture.service.exists(staged.path), false);
  });

  test('relaunch cleanup removes orphaned transient artifacts deterministically', async () => {
    const fixture = makeFixture();
    fixtures.push(fixture);
    await fixture.service.initialize();
    const transient = 'file:///sandbox/alyte-protected/transient-imports/orphan.pdf';
    fixture.fileSystem.files.set(transient, { content: 'orphan' });

    await fixture.service.cleanupTransientImports();
    assert.equal(await fixture.service.exists(transient), false);
  });

  test('rebases a prior iOS app-container path and keeps hash and deletion behavior safe', async () => {
    const fixture = makeFixture(
      'file:///Users/test/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/',
    );
    fixtures.push(fixture);
    await fixture.service.initialize();
    const legacy =
      'file:///Users/test/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents/alyte-protected/original-reports/report.pdf';
    const current =
      'file:///Users/test/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/alyte-protected/original-reports/report.pdf';
    fixture.fileSystem.files.set(current, { content: 'synthetic-pdf-data' });

    assert.equal(await fixture.service.resolvePath!(legacy), current);
    assert.equal(fixture.service.portablePath!(legacy), 'protected://original-reports/report.pdf');
    assert.equal(await fixture.service.exists(legacy), true);
    assert.equal(await fixture.service.hashFile(legacy), await fixture.service.hashFile(current));
    await fixture.service.remove(legacy);
    assert.equal(await fixture.service.exists(current), false);
  });

  test('accepts current and portable paths but rejects unowned and traversal paths', async () => {
    const fixture = makeFixture(
      'file:///Users/test/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/',
    );
    fixtures.push(fixture);
    await fixture.service.initialize();
    const current =
      'file:///Users/test/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/alyte-protected/intake-media/photo.jpg';
    fixture.fileSystem.files.set(current, { content: 'image-data' });

    assert.equal(await fixture.service.resolvePath!('protected://intake-media/photo.jpg'), current);
    assert.equal(fixture.service.portablePath!(current), 'protected://intake-media/photo.jpg');
    await assert.rejects(
      fixture.service.resolvePath!('file:///tmp/alyte-protected/intake-media/photo.jpg'),
      /owned protected file/,
    );
    await assert.rejects(
      fixture.service.remove(
        'file:///Users/test/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/alyte-protected/intake-media/../original-reports/report.pdf',
      ),
      /owned protected file/,
    );
    await assert.rejects(
      fixture.service.inspectIntake!('protected://original-reports/report.pdf'),
      /owned Intake Image/,
    );
    const intakeCopy = await fixture.service.inspectIntake!('protected://intake-media/photo.jpg');
    assert.equal(intakeCopy?.path, current);
  });
});

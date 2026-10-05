/**
 * macOS evaluation adapter for Alyte's production report-service orchestration.
 *
 * The report-service is deliberately used as the runner here.  This keeps PDF text-layer
 * admission, date exclusion, specimen context, geometry windows, deterministic checkpointing,
 * document grounding, and draft persistence identical to the app.  Only the native/platform
 * seams are supplied by this file; all payload artifacts stay below the private evaluation root.
 */
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import type { VisionOCRResult } from '@alyte/domain';
import {
  createLabRepository,
  type LabRepository,
  type SqliteDatabase,
} from '../../apps/mobile/src/features/labs/persistence';
import type { LabReportsService } from '../../apps/mobile/src/features/labs/report-service';
import { createLabReportsService as createProductionLabReportsService } from '../../apps/mobile/src/features/labs/report-service';
import type {
  PdfInspection,
  PdfInspector,
  PdfInspectionSession,
} from '../../apps/mobile/src/features/labs/pdf';
import type {
  LabSourceSelection,
  ProtectedCopy,
  ProtectedReportFileService,
} from '../../apps/mobile/src/features/labs/file-service';
import type { DocumentVLMExtractor } from '../../apps/mobile/src/features/local-models/document-vlm';
import {
  createRawSnapshotBinding,
  verifyRawSnapshotBinding,
  type RawSnapshotIdentity,
} from './raw-snapshot-binding';

const SCHEMA_VERSION = 'alyte.import-eval.v1' as const;
const PIPELINE_ID = 'alyte-baseline-service' as const;
const PIPELINE_VERSION_MODEL = 'mac-production-report-service-qwen.v1' as const;
const PIPELINE_VERSION_DETERMINISTIC = 'mac-production-report-service-deterministic.v1' as const;
const EXPERIMENT_ID = 'date-exclusion-v1' as const;
const EXPERIMENT_PIPELINE_VERSION_MODEL =
  'mac-production-report-service-date-exclusion-qwen.v1' as const;
const EXPERIMENT_PIPELINE_VERSION_DETERMINISTIC =
  'mac-production-report-service-date-exclusion-deterministic.v1' as const;
const GEOMETRY_EXPERIMENT_ID = 'geometry-precision-v1' as const;
const GEOMETRY_PIPELINE_VERSION =
  'mac-production-report-service-geometry-precision-deterministic.v1' as const;
type ExperimentId = typeof EXPERIMENT_ID | typeof GEOMETRY_EXPERIMENT_ID;
const DEFAULT_EVAL_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../.scratch/import-evaluation',
);
let evaluationRoot = DEFAULT_EVAL_ROOT;

type ReaderPage = {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly result: VisionOCRResult | null;
};
type ReaderEnvelope = {
  readonly readerVersion: string;
  readonly reportSha256: string;
  readonly runtimeVersion: string;
  readonly pageCount: number;
  readonly pages: readonly ReaderPage[];
};

export function forceVisionPages(reader: ReaderEnvelope): ReaderEnvelope {
  return {
    ...reader,
    pages: reader.pages.map((page) => ({ ...page, result: null })),
  };
}

export type Args = {
  readonly report: string;
  readonly reportId: string;
  readonly output: string;
  readonly privateRoot: string;
  readonly skipVision: boolean;
  readonly forceVision: boolean;
  readonly modelEnabled: boolean;
  readonly modelModule: string | null;
  readonly experiment: ExperimentId | null;
  readonly currentTime?: string;
};

type MainOverrides = {
  readonly experiment?: ExperimentId;
  readonly deterministicOnly?: boolean;
  readonly forceVision?: boolean;
};

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = resolve(root);
  const resolvedCandidate = resolve(candidate);
  const remainder = relative(resolvedRoot, resolvedCandidate);
  return (
    remainder === '' ||
    (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

export function nearestExistingPath(candidate: string): string {
  let current = resolve(candidate);
  while (true) {
    try {
      lstatSync(current);
      return current;
    } catch (error: any) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error;
    }
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

function chmodPrivateDirectoryChain(directory: string): void {
  let current = resolve(directory);
  const root = resolve(evaluationRoot);
  while (isPathInside(root, current)) {
    chmodSync(current, 0o700);
    if (current === root) return;
    current = dirname(current);
  }
  throw new Error('baseline-private-path-invalid');
}

function assertEvaluationPath(candidate: string, label: string, mustExist: boolean): string {
  const absolute = resolve(candidate);
  if (!isPathInside(evaluationRoot, absolute))
    throw new Error(`baseline-${label}-outside-private-root`);
  const rootReal = realpathSync(evaluationRoot);
  if (mustExist) {
    if (
      !existsSync(absolute) ||
      !statSync(absolute).isFile() ||
      !isPathInside(rootReal, realpathSync(absolute))
    )
      throw new Error(`baseline-${label}-outside-private-root`);
    return absolute;
  }
  const ancestor = nearestExistingPath(dirname(absolute));
  if (!isPathInside(rootReal, realpathSync(ancestor)))
    throw new Error(`baseline-${label}-outside-private-root`);
  return absolute;
}

function configureEvaluationRoot(root: string): void {
  mkdirSync(resolve(root), { recursive: true, mode: 0o700 });
  chmodSync(resolve(root), 0o700);
  evaluationRoot = realpathSync(resolve(root));
}

function inferEvaluationRoot(output: string): string {
  const absolute = resolve(output);
  const marker = `${sep}runs${sep}`;
  const markerIndex = absolute.lastIndexOf(marker);
  if (markerIndex > 0) return absolute.slice(0, markerIndex);
  const aggregateMarker = `${sep}aggregate${sep}`;
  const aggregateIndex = absolute.lastIndexOf(aggregateMarker);
  if (aggregateIndex > 0) return absolute.slice(0, aggregateIndex);
  return DEFAULT_EVAL_ROOT;
}

function parseArgs(overrides: MainOverrides = {}): Args {
  const report = arg('--report');
  const reportId = arg('--report-id');
  const output = arg('--output');
  if (report === undefined || reportId === undefined || output === undefined)
    throw new Error('baseline-arguments-invalid');
  if (!/^[a-z][a-z0-9_-]*$/u.test(reportId)) throw new Error('baseline-report-id-invalid');
  const privateRoot = resolve(arg('--private-root') ?? inferEvaluationRoot(output));
  const deterministicOnly =
    overrides.deterministicOnly ?? process.argv.includes('--deterministic-only');
  if (deterministicOnly && process.argv.includes('--model-enabled'))
    throw new Error('baseline-model-mode-conflict');
  // The faithful runner is model-enabled by default. The deterministic checkpoint is explicit
  // so a repeatable runner cannot silently omit the production refinement stage.
  const modelEnabled = !deterministicOnly;
  const modelModule = arg('--model-module') ?? null;
  const experiment = overrides.experiment ?? arg('--experiment');
  if (
    experiment !== undefined &&
    experiment !== EXPERIMENT_ID &&
    experiment !== GEOMETRY_EXPERIMENT_ID
  )
    throw new Error('baseline-experiment-invalid');
  const selectedExperiment =
    experiment === EXPERIMENT_ID || experiment === GEOMETRY_EXPERIMENT_ID ? experiment : null;
  return {
    report: resolve(report),
    reportId,
    output: resolve(output),
    privateRoot,
    skipVision: process.argv.includes('--skip-vision'),
    forceVision: overrides.forceVision ?? false,
    modelEnabled,
    modelModule: modelEnabled && modelModule !== null ? resolve(modelModule) : modelModule,
    experiment: selectedExperiment,
  };
}

type ReportServiceModule = {
  readonly createLabReportsService: typeof createProductionLabReportsService;
  readonly getGeometryAdmissionEvaluation?: () => {
    readonly latticeRows: number;
    readonly candidateGroups: number;
    readonly resultColumnAdmittedGroups: number;
    readonly resultColumnReviewGroups: number;
    readonly resultColumnExcludedGroups: number;
    readonly acceptedGroups: number;
    readonly rejectedGroups: number;
    readonly rejectedSourceObservationCount: number;
    readonly rejectedReasons: Readonly<Record<string, number>>;
  };
};

async function loadReportService(args: Args): Promise<ReportServiceModule> {
  if (args.experiment === EXPERIMENT_ID || args.experiment === GEOMETRY_EXPERIMENT_ID) {
    try {
      const modulePath =
        args.experiment === EXPERIMENT_ID
          ? '../../apps/mobile/src/features/labs/report-service-date-exclusion.eval.ts'
          : '../../apps/mobile/src/features/labs/report-service-geometry-date-exclusion.eval.ts';
      return (await import(modulePath)) as ReportServiceModule;
    } catch {
      throw new Error('baseline-experiment-adapter-invalid');
    }
  }
  return { createLabReportsService: createProductionLabReportsService };
}

function privatePath(...parts: string[]): string {
  const path = join(evaluationRoot, ...parts);
  if (!isPathInside(evaluationRoot, path)) throw new Error('baseline-private-path-invalid');
  const rootReal = realpathSync(evaluationRoot);
  const ancestor = nearestExistingPath(dirname(path));
  if (!isPathInside(rootReal, realpathSync(ancestor)))
    throw new Error('baseline-private-path-invalid');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!isPathInside(rootReal, realpathSync(dirname(path))))
    throw new Error('baseline-private-path-invalid');
  chmodPrivateDirectoryChain(dirname(path));
  return path;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function nativeRuntimeVersion(): string {
  let macOSProductVersion = 'unavailable';
  let macOSBuildVersion = 'unavailable';
  let swiftc = 'unavailable';
  try {
    macOSProductVersion = execFileSync('/usr/bin/sw_vers', ['-productVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\s+/gu, ' ')
      .slice(0, 64);
  } catch {
    // The reader invocation will still carry the host and toolchain identity.
  }
  try {
    macOSBuildVersion = execFileSync('/usr/bin/sw_vers', ['-buildVersion'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\s+/gu, ' ')
      .slice(0, 64);
  } catch {
    // The reader invocation will still carry the host and toolchain identity.
  }
  try {
    swiftc = execFileSync('/usr/bin/swiftc', ['--version'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .trim()
      .replace(/\s+/gu, ' ')
      .slice(0, 256);
  } catch {
    // The reader invocation will still carry the host and Node runtime identity.
  }
  return `node=${process.version};platform=${process.platform};arch=${process.arch};macOS=${macOSProductVersion};macOSBuild=${macOSBuildVersion};swiftc=${swiftc}`;
}

function readerSourceSha256(sources: readonly string[]): string {
  const sourceHashes = sources.map((source) => sha256(source)).join('|');
  return createHash('sha256').update(sourceHashes).digest('hex');
}

function sourcePathLabel(path: string, repoRoot: string): string {
  return isPathInside(repoRoot, path) ? relative(repoRoot, path) : `external:${basename(path)}`;
}

function gitProvenance(repoRoot: string): {
  readonly head: string | null;
  readonly dirty: boolean | null;
  readonly dirtyTreeSha256: string | null;
} {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const status = execFileSync('git', ['status', '--porcelain=v1', '--untracked-files=all'], {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return {
      head: head.length === 0 ? null : head,
      dirty: status.length > 0,
      dirtyTreeSha256:
        status.length === 0 ? null : createHash('sha256').update(status).digest('hex'),
    };
  } catch {
    return { head: null, dirty: null, dirtyTreeSha256: null };
  }
}

function sourceProvenance(
  args: Args,
  scriptDir: string,
): {
  readonly repository: ReturnType<typeof gitProvenance>;
  readonly files: Readonly<Record<string, { readonly path: string; readonly sha256: string }>>;
} {
  const repoRoot = resolve(scriptDir, '../..');
  const modelModule = args.modelModule ?? join(scriptDir, 'qwen-mac-cli.ts');
  const modelRepoRoot = resolve(dirname(modelModule), '../..');
  const candidates = [
    ['evaluationAdapter', join(scriptDir, 'alyte-service-baseline.ts')],
    ['reportService', resolve(scriptDir, '../../apps/mobile/src/features/labs/report-service.ts')],
    ['dateContext', resolve(scriptDir, '../../packages/domain/src/date-context.ts')],
    ['pdfKitReader', join(scriptDir, 'alyte-mac-pdfkit-reader.swift')],
    ['visionReader', join(scriptDir, 'alyte-mac-vision-reader.swift')],
    ['renderBand', join(scriptDir, 'alyte-mac-render-band.swift')],
    ['rawSnapshotBinding', join(scriptDir, 'raw-snapshot-binding.ts')],
    ['modelAdapter', modelModule],
    [
      'documentVlmPromptDecoder',
      resolve(modelRepoRoot, 'apps/mobile/src/features/local-models/document-vlm.ts'),
    ],
    [
      'documentVlmGrammar',
      resolve(
        modelRepoRoot,
        'apps/mobile/modules/alyte-local-models/ios/AlyteDocumentVLMGrammar.swift',
      ),
    ],
    ...(args.experiment === EXPERIMENT_ID
      ? ([
          [
            'dateExclusionReportService',
            resolve(
              scriptDir,
              '../../apps/mobile/src/features/labs/report-service-date-exclusion.eval.ts',
            ),
          ],
          [
            'dateExclusionDomain',
            resolve(scriptDir, '../../packages/domain/src/date-context-date-exclusion.eval.ts'),
          ],
          [
            'dateExclusionDomainIndex',
            resolve(scriptDir, '../../packages/domain/src/index-date-exclusion.eval.ts'),
          ],
        ] as const)
      : []),
    ...(args.experiment === GEOMETRY_EXPERIMENT_ID
      ? ([
          [
            'geometryDateExclusionReportService',
            resolve(
              scriptDir,
              '../../apps/mobile/src/features/labs/report-service-geometry-date-exclusion.eval.ts',
            ),
          ],
          [
            'dateExclusionDomain',
            resolve(scriptDir, '../../packages/domain/src/date-context-date-exclusion.eval.ts'),
          ],
          [
            'dateExclusionDomainIndex',
            resolve(scriptDir, '../../packages/domain/src/index-date-exclusion.eval.ts'),
          ],
        ] as const)
      : []),
  ] as const;
  const files: Record<string, { readonly path: string; readonly sha256: string }> = {};
  for (const [key, path] of candidates) {
    if (!existsSync(path)) continue;
    files[key] = { path: sourcePathLabel(path, repoRoot), sha256: sha256(path) };
  }
  return { repository: gitProvenance(repoRoot), files };
}

function compileReader(
  name: 'pdfkit' | 'vision' | 'render-band',
  sources: readonly string[],
  binary: string,
): void {
  const stampPath = privatePath('native', `${name}.service.stamp`);
  if (pathEntryExists(binary)) assertEvaluationPath(binary, 'native-reader', true);
  if (pathEntryExists(stampPath)) assertEvaluationPath(stampPath, 'native-reader-stamp', true);
  const stamp = `${nativeRuntimeVersion()}|${sources
    .map((source) => `${source}:${sha256(source)}`)
    .join('|')}`;
  try {
    if (existsSync(binary) && readFileSync(stampPath, 'utf8') === stamp) return;
  } catch {
    // Compile on first use.
  }
  mkdirSync(dirname(binary), { recursive: true, mode: 0o700 });
  mkdirSync(privatePath('native', 'module-cache'), { recursive: true, mode: 0o700 });
  execFileSync(
    '/usr/bin/swiftc',
    ['-module-cache-path', privatePath('native', 'module-cache'), ...sources, '-o', binary],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  assertEvaluationPath(binary, 'native-reader', true);
  writeFileSync(stampPath, stamp, { encoding: 'utf8', mode: 0o600 });
}

function compileRenderBand(scriptDir: string): string {
  const localSource = join(scriptDir, 'alyte-mac-render-band.swift');
  const harnessSource =
    '/tmp/alyte-import-harness/scripts/import-evaluation/alyte-mac-render-band.swift';
  const source = existsSync(localSource) ? localSource : harnessSource;
  if (!existsSync(source)) throw new Error('baseline-renderer-source-missing');
  const binary = privatePath('native', 'alyte-mac-render-band');
  compileReader('render-band', [source], binary);
  return binary;
}

function pathEntryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error: any) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function writePrivateBinding(
  path: string,
  binding: ReturnType<typeof createRawSnapshotBinding>,
): void {
  assertEvaluationPath(path, 'reader-binding', false);
  writeFileSync(path, `${JSON.stringify(binding)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function validateReaderEnvelope(value: Record<string, unknown>, name: string): ReaderEnvelope {
  const envelope = value as Partial<ReaderEnvelope>;
  if (
    typeof envelope.pageCount !== 'number' ||
    !Number.isSafeInteger(envelope.pageCount) ||
    !Array.isArray(envelope.pages)
  )
    throw new Error(`baseline-${name}-output-invalid`);
  if (envelope.pageCount <= 0 || envelope.pages.length !== envelope.pageCount)
    throw new Error(`baseline-${name}-output-invalid`);
  for (const [index, page] of envelope.pages.entries()) {
    if (
      page === null ||
      typeof page !== 'object' ||
      page.pageIndex !== index ||
      typeof page.width !== 'number' ||
      !Number.isFinite(page.width) ||
      page.width <= 0 ||
      typeof page.height !== 'number' ||
      !Number.isFinite(page.height) ||
      page.height <= 0 ||
      (page.result !== null && (typeof page.result !== 'object' || page.result === null))
    )
      throw new Error(`baseline-${name}-output-invalid`);
  }
  return envelope as ReaderEnvelope;
}

function savePrivateReaderStderr(name: string, error: unknown): void {
  let stderr = 'native-reader-failed\n';
  if (error !== null && typeof error === 'object' && 'stderr' in error) {
    const value = (error as { readonly stderr?: unknown }).stderr;
    if (typeof value === 'string') stderr = value;
    else if (value instanceof Uint8Array) stderr = Buffer.from(value).toString('utf8');
  }
  const path = privatePath('failures', `${name}.reader.stderr.txt`);
  writeFileSync(path, stderr, { encoding: 'utf8', mode: 0o600 });
  chmodSync(path, 0o600);
}

function runReader(
  binary: string,
  report: string,
  output: string,
  name: string,
  sources: readonly string[],
  readerVersion: string,
  runtimeVersion: string,
): ReaderEnvelope {
  const bindingPath = output.replace(/\.json$/u, '.binding.json');
  assertEvaluationPath(binary, 'native-reader', true);
  const identity: RawSnapshotIdentity = {
    reportSha256: sha256(report),
    readerVersion,
    runtimeVersion,
    readerBinarySha256: sha256(binary),
    readerSourceSha256: readerSourceSha256(sources),
  };
  const canReuse = process.env.ALYTE_EVAL_REUSE_READERS === '1' && pathEntryExists(output);
  if (canReuse) {
    assertEvaluationPath(output, 'reader-output', true);
    if (!pathEntryExists(bindingPath)) throw new Error(`baseline-${name}-binding-missing`);
    assertEvaluationPath(bindingPath, 'reader-binding', true);
    let binding: unknown;
    try {
      binding = JSON.parse(readFileSync(bindingPath, 'utf8')) as unknown;
    } catch {
      throw new Error(`baseline-${name}-binding-invalid`);
    }
    try {
      return validateReaderEnvelope(
        verifyRawSnapshotBinding(readFileSync(output, 'utf8'), binding, identity),
        name,
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('baseline-')) throw error;
      throw new Error(`baseline-${name}-binding-mismatch`);
    }
  }
  if (pathEntryExists(output)) {
    assertEvaluationPath(output, 'reader-output', true);
    unlinkSync(output);
  }
  if (pathEntryExists(bindingPath)) {
    assertEvaluationPath(bindingPath, 'reader-binding', true);
    unlinkSync(bindingPath);
  }
  try {
    execFileSync(
      binary,
      ['--input', report, '--output', output, '--runtime-version', runtimeVersion],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: name === 'vision' ? 180_000 : 30_000,
      },
    );
  } catch (error) {
    if (process.env.ALYTE_EVAL_DEBUG === '1') {
      try {
        savePrivateReaderStderr(name, error);
      } catch {
        // Keep native diagnostics private and never replace the stable CLI error.
      }
    }
    throw new Error(`baseline-${name}-reader-failed`);
  }
  assertEvaluationPath(output, 'reader-output', true);
  chmodSync(output, 0o600);
  const rawText = readFileSync(output, 'utf8');
  const binding = createRawSnapshotBinding(rawText, identity);
  const envelope = validateReaderEnvelope(
    verifyRawSnapshotBinding(rawText, binding, identity),
    name,
  );
  writePrivateBinding(bindingPath, binding);
  return envelope;
}

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

const protection = {
  async protectDatabaseFiles(
    databasePath: string,
    options: { readonly requireSidecars?: boolean } = {},
  ) {
    return {
      protectedPaths:
        options.requireSidecars === true
          ? [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]
          : [databasePath],
      missingSidecarPaths: [],
    };
  },
};

/** Private-run file owner.  It intentionally has no cloud or external service behavior. */
class EvaluationFiles implements ProtectedReportFileService {
  private readonly root: string;
  private sequence = 0;
  constructor(root: string) {
    this.root = root;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  async initialize(): Promise<void> {}
  async cleanupTransientImports(): Promise<void> {}
  async stage(source: LabSourceSelection, _importId: string): Promise<ProtectedCopy> {
    const path = join(this.root, 'staged', `${++this.sequence}-${basename(source.name)}`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    copyFileSync(source.uri.replace(/^file:\/\//u, ''), path);
    chmodSync(path, 0o600);
    return { path, sourceHash: sha256(path), byteSize: statSync(path).size };
  }
  async promote(
    staged: ProtectedCopy,
    reportId: string,
    source: LabSourceSelection,
  ): Promise<ProtectedCopy> {
    const path = join(this.root, 'originals', `${reportId}-${basename(source.name)}`);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    copyFileSync(staged.path, path);
    chmodSync(path, 0o600);
    return { path, sourceHash: sha256(path), byteSize: statSync(path).size };
  }
  async recoverPromoted(): Promise<ProtectedCopy | null> {
    return null;
  }
  async hashFile(path: string): Promise<string> {
    return sha256(path);
  }
  async exists(path: string): Promise<boolean> {
    return existsSync(path);
  }
  async remove(path: string): Promise<void> {
    try {
      unlinkSync(path);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  async resolvePath(path: string): Promise<string> {
    return path;
  }
  async removeOwnedFile(path: string): Promise<void> {
    await this.remove(path);
  }
  async listOwnedFiles(): Promise<readonly string[]> {
    return [];
  }
}

class EvaluationPdf implements PdfInspector {
  readonly textLayerAdapterVersion = 'alyte.pdf.text-layer.v3' as const;
  private _modelBandCalls = 0;
  private _modelBandElapsedMs = 0;
  private readonly inspection: PdfInspection;
  private readonly textPages: readonly ReaderPage[];
  private readonly visionPages: readonly ReaderPage[];
  constructor(
    text: ReaderEnvelope,
    vision: ReaderEnvelope | null,
    private readonly reportSha256: string,
    private readonly renderBinary: string | null,
  ) {
    this.textPages = text.pages;
    this.visionPages = vision?.pages ?? [];
    this.inspection = {
      encrypted: false,
      locked: false,
      pageCount: text.pageCount,
      metadata: {},
      pages: text.pages.map((page) => ({
        pageIndex: page.pageIndex,
        width: page.width,
        height: page.height,
        hasTextLayer: page.result !== null,
      })),
    };
  }
  async inspect(): Promise<PdfInspection> {
    return this.inspection;
  }
  get modelBandCalls(): number {
    return this._modelBandCalls;
  }
  get modelBandElapsedMs(): number {
    return this._modelBandElapsedMs;
  }
  async unlock(): Promise<PdfInspectionSession> {
    throw new Error('evaluation-pdf-not-encrypted');
  }
  async renderPreview(): Promise<readonly string[]> {
    return [];
  }
  async readTextLayerPage(_path: string, pageIndex: number): Promise<VisionOCRResult | null> {
    return this.textPages[pageIndex]?.result ?? null;
  }
  async renderExtractionBand(
    path: string,
    pageIndex: number,
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
  ): Promise<{ readonly uri: string; readonly width: number; readonly height: number }> {
    if (this.renderBinary === null) throw new Error('evaluation-render-band-unavailable');
    if (
      !Number.isInteger(pageIndex) ||
      pageIndex < 0 ||
      ![rect.x, rect.y, rect.width, rect.height].every((value) => Number.isFinite(value)) ||
      rect.x < 0 ||
      rect.y < 0 ||
      rect.width <= 0 ||
      rect.height <= 0 ||
      rect.x + rect.width > 1 ||
      rect.y + rect.height > 1
    )
      throw new Error('evaluation-render-band-invalid');
    const rectKey = createHash('sha256')
      .update(JSON.stringify([rect.x, rect.y, rect.width, rect.height]))
      .digest('hex')
      .slice(0, 24);
    const destination = privatePath(
      'rendered',
      `${this.reportSha256}-page-${pageIndex}-${rectKey}.jpg`,
    );
    const privateReportPath = assertEvaluationPath(path, 'render-input', true);
    if (sha256(privateReportPath) !== this.reportSha256)
      throw new Error('evaluation-render-band-source-hash-mismatch');
    let stdout: string;
    const started = performance.now();
    try {
      stdout = execFileSync(
        this.renderBinary,
        [
          '--report',
          privateReportPath,
          '--page',
          String(pageIndex),
          '--rect',
          [rect.x, rect.y, rect.width, rect.height].join(','),
          '--output',
          destination,
          '--private-root',
          evaluationRoot,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 },
      );
    } catch {
      throw new Error('evaluation-render-band-failed');
    } finally {
      this._modelBandCalls += 1;
      this._modelBandElapsedMs += performance.now() - started;
    }
    chmodSync(destination, 0o600);
    let metadata: unknown;
    try {
      metadata = JSON.parse(stdout) as unknown;
    } catch {
      throw new Error('evaluation-render-band-invalid');
    }
    if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata))
      throw new Error('evaluation-render-band-invalid');
    const record = metadata as Record<string, unknown>;
    const renderedRect = record.normalizedRect;
    if (renderedRect === null || typeof renderedRect !== 'object' || Array.isArray(renderedRect))
      throw new Error('evaluation-render-band-invalid');
    const rendered = renderedRect as Record<string, unknown>;
    if (
      record.schemaVersion !== 'alyte.import-eval.crop.v1' ||
      record.reportSha256 !== this.reportSha256 ||
      record.pageIndex !== pageIndex ||
      rendered.x !== rect.x ||
      rendered.y !== rect.y ||
      rendered.width !== rect.width ||
      rendered.height !== rect.height ||
      record.outputPath !== destination ||
      typeof record.width !== 'number' ||
      !Number.isSafeInteger(record.width) ||
      record.width <= 0 ||
      typeof record.height !== 'number' ||
      !Number.isSafeInteger(record.height) ||
      record.height <= 0 ||
      typeof record.bytes !== 'number' ||
      !Number.isSafeInteger(record.bytes) ||
      record.bytes <= 0 ||
      !existsSync(destination) ||
      statSync(destination).size !== record.bytes
    )
      throw new Error('evaluation-render-band-invalid');
    return { uri: pathToFileURL(destination).href, width: record.width, height: record.height };
  }
  async deleteExtractionBand(uri: string): Promise<void> {
    let path: string;
    try {
      path = uri.startsWith('file://') ? fileURLToPath(uri) : resolve(uri);
    } catch {
      throw new Error('evaluation-render-band-invalid');
    }
    if (!isPathInside(evaluationRoot, path)) throw new Error('evaluation-render-band-invalid');
    if (existsSync(path) && !isPathInside(realpathSync(evaluationRoot), realpathSync(path)))
      throw new Error('evaluation-render-band-invalid');
    try {
      unlinkSync(path);
    } catch (error: any) {
      if (error?.code !== 'ENOENT') throw new Error('evaluation-render-band-delete-failed');
    }
  }
  vision(pageIndex: number): VisionOCRResult {
    const result = this.visionPages[pageIndex]?.result;
    if (result === null || result === undefined)
      throw new Error('evaluation-vision-page-unavailable');
    return result;
  }
}

class EvaluationVision {
  constructor(private readonly pdf: EvaluationPdf) {}
  async recognize(_path: string, pageIndex: number): Promise<VisionOCRResult> {
    return this.pdf.vision(pageIndex);
  }
}

type DocumentModelAdapterModule = {
  readonly createQwenMacDocumentVLM?: (options?: {
    readonly paths?: { readonly privateRoot?: string };
  }) => Promise<{
    readonly extractor: DocumentVLMExtractor;
    readonly provenance: Record<string, unknown>;
  }>;
};

async function loadDocumentModel(
  args: Args,
  scriptDir: string,
): Promise<{
  readonly extractor: DocumentVLMExtractor;
  readonly provenance: Record<string, unknown>;
} | null> {
  if (!args.modelEnabled) return null;
  const modulePath = args.modelModule ?? join(scriptDir, 'qwen-mac-cli.ts');
  if (!existsSync(modulePath)) throw new Error('baseline-model-adapter-missing');
  let module: DocumentModelAdapterModule;
  try {
    module = (await import(pathToFileURL(modulePath).href)) as DocumentModelAdapterModule;
  } catch {
    throw new Error('baseline-model-adapter-invalid');
  }
  if (typeof module.createQwenMacDocumentVLM !== 'function')
    throw new Error('baseline-model-adapter-invalid');
  try {
    return await module.createQwenMacDocumentVLM({ paths: { privateRoot: evaluationRoot } });
  } catch {
    throw new Error('baseline-model-adapter-unavailable');
  }
}

type DocumentModelMetrics = {
  prepareMs: number;
  extractMs: number;
  calls: number;
  outputRows: number;
  failures: number;
};

function instrumentDocumentModel(
  extractor: DocumentVLMExtractor,
  metrics: DocumentModelMetrics,
): DocumentVLMExtractor {
  return {
    ...extractor,
    prepare: async () => {
      const started = performance.now();
      try {
        return await extractor.prepare();
      } catch (error) {
        metrics.failures += 1;
        throw error;
      } finally {
        metrics.prepareMs += performance.now() - started;
      }
    },
    extract: async (input) => {
      metrics.calls += 1;
      const started = performance.now();
      try {
        const rows = await extractor.extract(input);
        metrics.outputRows += rows.length;
        return rows;
      } catch (error) {
        metrics.failures += 1;
        throw error;
      } finally {
        metrics.extractMs += performance.now() - started;
      }
    },
  };
}

function measurementFromRow(row: any, reportId: string, index: number) {
  const value = row.proposedValue;
  const valueType =
    value.kind === 'numeric'
      ? 'numeric'
      : value.kind === 'bounded'
        ? 'bounded'
        : value.kind === 'categorical'
          ? 'categorical'
          : value.kind === 'free_text'
            ? 'text'
            : 'unknown';
  const parsedValue =
    value.kind === 'numeric' ||
    value.kind === 'bounded' ||
    value.kind === 'categorical' ||
    value.kind === 'free_text'
      ? value.value
      : null;
  const printedComparator = (sourceValue: unknown): '<' | '>' | '<=' | '>=' | '=' | null => {
    if (typeof sourceValue !== 'string') return null;
    const match = sourceValue.trim().match(/^(<=|>=|<|>|=|≤|≥)/u)?.[1];
    if (match === undefined) return null;
    if (match === '≤') return '<=';
    if (match === '≥') return '>=';
    return match as '<' | '>' | '<=' | '>=' | '=';
  };
  const comparator =
    value.kind === 'bounded'
      ? value.comparator
      : value.kind === 'numeric'
        ? printedComparator(row.sourceValueString)
        : null;
  const unresolvedFields = [
    ...new Set([
      ...row.reviewReasons,
      ...(row.sourceUnit === null && (value.kind === 'numeric' || value.kind === 'bounded')
        ? ['unit']
        : []),
      ...(row.collectionDate.kind === 'missing' ? ['collectionDate'] : []),
    ]),
  ];
  return {
    id: `${reportId}-${index.toString().padStart(4, '0')}`,
    sourceLabel: row.sourceLabel,
    valueString: row.sourceValueString || null,
    valueType,
    parsedValue,
    comparator,
    unit: row.sourceUnit,
    referenceInterval: row.sourceReferenceInterval,
    flag: row.sourceFlag,
    collectionDate: row.collectionDate.kind === 'known' ? row.collectionDate.value : null,
    collectionGroup: row.collectionDateContext?.observationId ?? null,
    specimen: row.proposedSpecimenType === 'unknown' ? null : row.proposedSpecimenType,
    page: Number.isInteger(row.source.pageIndex) ? row.source.pageIndex + 1 : null,
    location: row.source.boundingBox,
    ambiguousFields: unresolvedFields,
    canonicalBiomarkerId: row.proposedBiomarkerId,
    trendEligible:
      value.kind === 'numeric' && row.proposedBiomarkerId !== null && row.sourceUnit !== null
        ? true
        : null,
    unresolvedFields,
    sourceIds: [...row.source.observationIds],
  };
}

export async function run(providedArgs?: Args): Promise<any> {
  const args = providedArgs ?? parseArgs();
  configureEvaluationRoot(args.privateRoot);
  if (!existsSync(args.report)) throw new Error('baseline-report-missing');
  assertEvaluationPath(args.report, 'report', true);
  assertEvaluationPath(args.output, 'output', false);
  const started = performance.now();
  const reportSha256 = sha256(args.report);
  const scriptDir = resolve(dirname(new URL(import.meta.url).pathname));
  const runtimeVersion = nativeRuntimeVersion();
  const sourceFingerprint = sourceProvenance(args, scriptDir);
  const reportServiceModule = await loadReportService(args);
  const model = await loadDocumentModel(args, scriptDir);
  const modelMetrics: DocumentModelMetrics = {
    prepareMs: 0,
    extractMs: 0,
    calls: 0,
    outputRows: 0,
    failures: 0,
  };
  const activeModel =
    model === null ? null : instrumentDocumentModel(model.extractor, modelMetrics);
  const pdfkitBinary = privatePath('native', 'alyte-mac-pdfkit-reader');
  const pdfkitSources = [
    join(scriptDir, 'alyte-mac-pdfkit-reader.swift'),
    resolve(scriptDir, '../../apps/mobile/modules/alyte-pdf/ios/AlytePDFTextLayer.swift'),
  ];
  compileReader('pdfkit', pdfkitSources, pdfkitBinary);
  const rawPdfKit = privatePath('raw', `${args.reportId}.service.pdfkit.json`);
  const pdfKitStarted = performance.now();
  const pdfKit = runReader(
    pdfkitBinary,
    args.report,
    rawPdfKit,
    'pdfkit',
    pdfkitSources,
    'alyte.mac.pdfkit-reader.v1',
    runtimeVersion,
  );
  const pdfKitElapsedMs = performance.now() - pdfKitStarted;
  const pdfKitForExtraction = args.forceVision ? forceVisionPages(pdfKit) : pdfKit;
  let vision: ReaderEnvelope | null = null;
  let visionElapsedMs = 0;
  if (!args.skipVision && pdfKitForExtraction.pages.some((page) => page.result === null)) {
    const visionBinary = privatePath('native', 'alyte-mac-vision-reader');
    const visionSources = [
      join(scriptDir, 'alyte-mac-vision-reader.swift'),
      resolve(scriptDir, '../../apps/mobile/modules/alyte-vision/ios/AlyteVisionObservation.swift'),
    ];
    compileReader('vision', visionSources, visionBinary);
    const visionStarted = performance.now();
    vision = runReader(
      visionBinary,
      args.report,
      privatePath('raw', `${args.reportId}.service.vision.json`),
      'vision',
      visionSources,
      'alyte.mac.vision-reader.v1',
      runtimeVersion,
    );
    visionElapsedMs = performance.now() - visionStarted;
  }
  const renderBinary = args.modelEnabled ? compileRenderBand(scriptDir) : null;
  const pdf = new EvaluationPdf(pdfKitForExtraction, vision, reportSha256, renderBinary);
  // Every invocation gets a fresh private database. Reusing a report-keyed path can resurrect a
  // deterministic checkpoint on a later model run (or a later immutable runner run), changing the
  // evaluated service behavior without changing the input artifact.
  const databaseDirectory = privatePath('runs', `service-${args.reportId}-${randomUUID()}`);
  mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
  const databasePath = join(databaseDirectory, 'evaluation.sqlite');
  const database = new NodeSqliteDatabase(databasePath);
  chmodSync(databasePath, 0o600);
  const repository: LabRepository = createLabRepository(database, {
    protection,
    now: () => args.currentTime ?? '2026-09-06T10:00:00.000Z',
    idGenerator: (prefix) => `${prefix}-eval-${Math.random().toString(36).slice(2)}`,
  });
  const files = new EvaluationFiles(join(databaseDirectory, 'files'));
  const service: LabReportsService = reportServiceModule.createLabReportsService({
    repositoryFactory: async () => repository,
    fileService: files,
    pdfInspector: pdf,
    visionOCR: new EvaluationVision(pdf),
    ...(activeModel === null ? {} : { documentVLM: activeModel }),
    now: () => args.currentTime ?? '2026-09-06T10:00:00.000Z',
    documentRefinementBudgetMs: 90_000,
  });
  const source: LabSourceSelection = {
    uri: args.report,
    name: basename(args.report),
    mimeType: 'application/pdf',
    sourceType: 'pdf',
    byteSize: statSync(args.report).size,
  };
  const importStarted = performance.now();
  const imported = await service.importPdf(source);
  if (imported === null) throw new Error('baseline-import-cancelled');
  const draftStarted = performance.now();
  let draft: Awaited<ReturnType<LabReportsService['startExtraction']>> | null = null;
  let extractionFailure: string | null = null;
  try {
    draft = await service.startExtraction(imported.report.id);
  } catch (error) {
    const reason =
      typeof error === 'object' &&
      error !== null &&
      'reason' in error &&
      typeof error.reason === 'string'
        ? error.reason
        : null;
    extractionFailure = reason === null ? 'service-error' : reason;
  }
  const rows = (draft?.rows ?? []).map((row, index) =>
    measurementFromRow(row, args.reportId, index),
  );
  const geometryAdmission = reportServiceModule.getGeometryAdmissionEvaluation?.() ?? null;
  await database.closeAsync();
  const extractionElapsedMs = performance.now() - draftStarted;
  const modelStageStatus =
    model === null ? 'omitted-runtime' : modelMetrics.calls > 0 ? 'complete' : 'not-invoked';
  const result = {
    schemaVersion: SCHEMA_VERSION,
    reportId: args.reportId,
    reportSha256,
    pipeline: {
      id: args.experiment === null ? PIPELINE_ID : `alyte-experiment-${args.experiment}`,
      version:
        args.experiment === GEOMETRY_EXPERIMENT_ID
          ? GEOMETRY_PIPELINE_VERSION
          : args.experiment === EXPERIMENT_ID
            ? args.modelEnabled
              ? EXPERIMENT_PIPELINE_VERSION_MODEL
              : EXPERIMENT_PIPELINE_VERSION_DETERMINISTIC
            : args.modelEnabled
              ? PIPELINE_VERSION_MODEL
              : PIPELINE_VERSION_DETERMINISTIC,
      configuration: {
        productionService:
          args.experiment === EXPERIMENT_ID
            ? 'apps/mobile/src/features/labs/report-service-date-exclusion.eval.ts'
            : args.experiment === GEOMETRY_EXPERIMENT_ID
              ? 'apps/mobile/src/features/labs/report-service-geometry-date-exclusion.eval.ts'
              : 'apps/mobile/src/features/labs/report-service.ts',
        experiment: args.experiment,
        ...(args.forceVision ? { forceVision: true } : {}),
        pdfTextLayerAdapterVersion: 'alyte.pdf.text-layer.v3',
        visionContractVersion: 'alyte.vision.document.v4',
        nativeReaderRuntimeVersion: runtimeVersion,
        documentModel: model === null ? 'omitted-in-this-run' : model.extractor.adapterVersion,
        ...(model === null ? {} : { documentModelProvenance: model.provenance }),
        refinementBudgetMs: 90_000,
        sourceProvenance: sourceFingerprint,
      },
      runtime: {
        os: process.platform,
        arch: process.arch,
        node: process.version,
        swift: 'swiftc / macOS PDFKit + Vision',
      },
    },
    stages: [
      {
        name: 'native-pdfkit-text-layer',
        elapsedMs: pdfKitElapsedMs,
        inputCount: pdfKitForExtraction.pageCount,
        outputCount: pdfKitForExtraction.pages.filter((page) => page.result !== null).length,
        status: args.forceVision ? 'discarded-for-vision-geometry' : 'complete',
      },
      {
        name: 'native-vision-fallback',
        elapsedMs: visionElapsedMs,
        inputCount: pdfKitForExtraction.pages.filter((page) => page.result === null).length,
        outputCount: vision?.pages.filter((page) => page.result !== null).length ?? 0,
        status: vision === null ? 'not-needed' : 'complete',
      },
      {
        name: 'production-report-service-extraction',
        elapsedMs: extractionElapsedMs,
        inputCount: pdfKitForExtraction.pageCount,
        outputCount: rows.length,
        status: extractionFailure === null ? 'complete' : 'failed',
      },
      {
        name: 'document-model-refinement',
        elapsedMs: model === null ? 0 : modelMetrics.prepareMs + modelMetrics.extractMs,
        inputCount: modelMetrics.calls,
        outputCount: modelMetrics.outputRows,
        status: modelStageStatus,
      },
    ],
    elapsedMs: performance.now() - started,
    measurements: rows,
    diagnostics: {
      counts: {
        pages: pdfKitForExtraction.pageCount,
        trustedPdfPages: pdfKitForExtraction.pages.filter((page) => page.result !== null).length,
        visionInputPages: pdfKitForExtraction.pages.filter((page) => page.result === null).length,
        visionOutputPages: vision?.pages.filter((page) => page.result !== null).length ?? 0,
        measurements: rows.length,
        modelRecoveryIncomplete:
          model !== null && (modelMetrics.failures > 0 || pdf.modelBandCalls > modelMetrics.calls)
            ? 1
            : 0,
        mappedMeasurements: rows.filter((row) => row.canonicalBiomarkerId !== null).length,
        unsupportedMapping: rows.filter((row) => row.canonicalBiomarkerId === null).length,
        reviewRows: rows.filter((row) => row.unresolvedFields.length > 0).length,
        ...(geometryAdmission === null
          ? {}
          : {
              geometryLatticeRows: geometryAdmission.latticeRows,
              geometryCandidateGroups: geometryAdmission.candidateGroups,
              geometryResultColumnAdmittedGroups: geometryAdmission.resultColumnAdmittedGroups,
              geometryResultColumnReviewGroups: geometryAdmission.resultColumnReviewGroups,
              geometryResultColumnExcludedGroups: geometryAdmission.resultColumnExcludedGroups,
              geometryAcceptedGroups: geometryAdmission.acceptedGroups,
              geometryRejectedGroups: geometryAdmission.rejectedGroups,
              geometryRejectedSourceObservations: geometryAdmission.rejectedSourceObservationCount,
              ...Object.fromEntries(
                Object.entries(geometryAdmission.rejectedReasons).map(([reason, count]) => [
                  `geometryRejectedReason${reason
                    .split('-')
                    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
                    .join('')}`,
                  count,
                ]),
              ),
            }),
        modelCalls: modelMetrics.calls,
        modelOutputRows: modelMetrics.outputRows,
        modelFailures: modelMetrics.failures,
        modelBandCalls: pdf.modelBandCalls,
        extractionFailed: extractionFailure === null ? 0 : 1,
      },
      limitations: [
        'This run invokes production report-service orchestration with private macOS native seams and SQLite persistence.',
        ...(model === null
          ? [
              'The optional document-model refinement seam was omitted; model-enabled results must be labeled separately.',
            ]
          : [
              'Document-model calls use the exact production DocumentVLM adapter over the private macOS renderer; accepted grounding rows remain source-rebuilt by report-service.',
            ]),
        'Production report-service does not expose grounding acceptance telemetry; no grounding count is claimed.',
        ...(geometryAdmission === null
          ? []
          : [
              'Rejected geometry source observations remain provenance-linked in the private native input and are reported only as aggregate manual-review diagnostics.',
            ]),
        ...(extractionFailure === null
          ? []
          : [
              `Production extraction terminated with ${extractionFailure}; no draft rows were scored.`,
            ]),
        'The private SQLite and native observation artifacts remain under .scratch/import-evaluation.',
      ],
    },
    timing: { importMs: draftStarted - importStarted, extractionMs: extractionElapsedMs },
    sourceReportId: imported.report.id,
  };
  return result;
}

export async function main(overrides: MainOverrides = {}): Promise<void> {
  try {
    const args = parseArgs(overrides);
    const result = await run(args);
    mkdirSync(dirname(args.output), { recursive: true, mode: 0o700 });
    writeFileSync(args.output, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
    chmodSync(args.output, 0o600);
    process.stdout.write(
      `report=${result.reportId} pages=${result.diagnostics.counts.pages} measurements=${result.diagnostics.counts.measurements} mapped=${result.diagnostics.counts.mappedMeasurements} elapsedMs=${Math.round(result.elapsedMs)}\n`,
    );
  } catch (error) {
    try {
      const failurePath = privatePath(
        'failures',
        `${process.argv.includes('--report-id') ? (arg('--report-id') ?? 'unknown') : 'unknown'}.service.txt`,
      );
      writeFileSync(
        failurePath,
        error instanceof Error
          ? `${error.name}: ${error.message}\n${error.stack ?? ''}\n`
          : 'unknown-error\n',
        { encoding: 'utf8', mode: 0o600 },
      );
      chmodSync(failurePath, 0o600);
    } catch {
      // Keep diagnostics private and never replace the stable CLI error.
    }
    process.stderr.write(
      error instanceof Error && /^baseline-[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'baseline-service-failed\n',
    );
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1]);
if (invokedPath === resolve(fileURLToPath(import.meta.url))) void main();

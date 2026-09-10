/**
 * Evaluation-only Poppler text-layer reader.
 *
 * This file stops at source evidence. It deliberately does not identify measurements, parse
 * values, infer rows, map biomarkers, or read expected results. The emitted line observations and
 * word spans are consumed by the existing source-grounding experiment.
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const POPPLER_LAYOUT_READER_VERSION = 'alyte.mac.poppler-layout-reader.v1' as const;
export const POPPLER_SOURCE_TEXT_CONSTRUCTION = 'poppler-word-lines.v1' as const;
export const POPPLER_SOURCE_OFFSET_KIND = 'synthetic-page-text-utf16' as const;

type Box = {
  readonly xMin: number;
  readonly yMin: number;
  readonly xMax: number;
  readonly yMax: number;
};

export type PopplerWord = Box & {
  readonly text: string;
  readonly id: string;
};

export type PopplerLine = Box & {
  readonly words: readonly PopplerWord[];
  readonly id: string;
};

export type PopplerPage = {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly lines: readonly PopplerLine[];
};

export type PopplerVisionSpan = {
  readonly id: string;
  readonly text: string;
  /** UTF-16 offsets relative to the containing line observation text. */
  readonly start: number;
  readonly end: number;
  readonly boundingBox: NormalizedBox;
};

export type NormalizedBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export type PopplerVisionObservation = {
  readonly id: string;
  readonly text: string;
  readonly pageIndex: number;
  readonly boundingBox: NormalizedBox;
  readonly sourceStart: number;
  readonly sourceEnd: number;
  readonly spans: readonly PopplerVisionSpan[];
};

export type PopplerVisionPage = {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly sourceText: string;
  readonly sourceTextConstruction: typeof POPPLER_SOURCE_TEXT_CONSTRUCTION;
  readonly sourceOffsetKind: typeof POPPLER_SOURCE_OFFSET_KIND;
  readonly result: {
    readonly contractVersion: 'alyte.poppler.word-lines.v1';
    readonly pageIndex: number;
    readonly orientation: 0;
    readonly observations: readonly PopplerVisionObservation[];
  };
};

type RawEnvelope = {
  readonly readerVersion: typeof POPPLER_LAYOUT_READER_VERSION;
  readonly runtimeVersion: string;
  readonly reportSha256: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
  readonly pdftotextBinarySha256: string;
  readonly pdftotextVersion: string;
  readonly sourceTextConstruction: typeof POPPLER_SOURCE_TEXT_CONSTRUCTION;
  readonly sourceOffsetKind: typeof POPPLER_SOURCE_OFFSET_KIND;
  readonly pageCount: number;
  readonly pages: readonly PopplerVisionPage[];
};

const XML_ENTITY = /&(?:amp|lt|gt|quot|apos|#x[0-9a-f]+|#\d+);/giu;
function attr(attrs: string, name: string): string | null {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const match = attrs.match(new RegExp(`(?:^|\\s)${escapedName}\\s*=\\s*"([^"]*)"`, 'u'));
  return match?.[1] ?? null;
}

function numberAttr(attrs: string, name: string): number {
  const raw = attr(attrs, name);
  const value = raw === null ? Number.NaN : Number(raw);
  if (raw === null || raw.trim().length === 0 || !Number.isFinite(value)) {
    throw new Error('poppler-layout-attribute-invalid');
  }
  return value;
}

/** Decode each XML entity once. In particular, `&amp;lt;` remains the literal text `&lt;`. */
function decodeXml(value: string): string {
  return value.replace(XML_ENTITY, (entity) => {
    const lower = entity.toLocaleLowerCase('en-US');
    if (lower === '&amp;') return '&';
    if (lower === '&lt;') return '<';
    if (lower === '&gt;') return '>';
    if (lower === '&quot;') return '"';
    if (lower === '&apos;') return "'";
    const hexadecimal = /^&#x([0-9a-f]+);$/iu.exec(entity);
    const decimal = /^&#([0-9]+);$/u.exec(entity);
    const codePoint = hexadecimal
      ? Number.parseInt(hexadecimal[1]!, 16)
      : decimal
        ? Number(decimal[1])
        : Number.NaN;
    if (!Number.isSafeInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
      throw new Error('poppler-layout-entity-invalid');
    }
    return String.fromCodePoint(codePoint);
  });
}

function boxFromAttributes(attrs: string): Box {
  const xMin = numberAttr(attrs, 'xMin');
  const yMin = numberAttr(attrs, 'yMin');
  const xMax = numberAttr(attrs, 'xMax');
  const yMax = numberAttr(attrs, 'yMax');
  if (!(xMax > xMin && yMax > yMin)) throw new Error('poppler-layout-box-invalid');
  return { xMin, yMin, xMax, yMax };
}

function parseWords(body: string, pageIndex: number, lineIndex: number): readonly PopplerWord[] {
  const words: PopplerWord[] = [];
  const wordPattern = /<word\s+([^>]+)>([\s\S]*?)<\/word>/gu;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(body)) !== null) {
    const text = decodeXml(match[2]!);
    if (text.length === 0 || /^\s+$/u.test(text)) continue;
    words.push({
      ...boxFromAttributes(match[1]!),
      text,
      id: `p${pageIndex + 1}-l${lineIndex + 1}-w${words.length + 1}`,
    });
  }
  return words;
}

function validatePageGeometry(page: PopplerPage): void {
  const boxes = page.lines.flatMap((line) => [line, ...line.words]);
  for (const box of boxes) {
    if (box.xMin < 0 || box.yMin < 0 || box.xMax > page.width || box.yMax > page.height) {
      throw new Error('poppler-layout-box-outside-page');
    }
  }
}

export function parseBboxLayoutDocument(input: string): readonly PopplerPage[] {
  const pages: PopplerPage[] = [];
  const pagePattern = /<page\s+([^>]+)>([\s\S]*?)<\/page>/gu;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = pagePattern.exec(input)) !== null) {
    const pageIndex = pages.length;
    const width = numberAttr(pageMatch[1]!, 'width');
    const height = numberAttr(pageMatch[1]!, 'height');
    if (!(width > 0 && height > 0)) throw new Error('poppler-layout-page-size-invalid');
    const lines: PopplerLine[] = [];
    const linePattern = /<line\s+([^>]+)>([\s\S]*?)<\/line>/gu;
    let lineMatch: RegExpExecArray | null;
    let sourceLineIndex = 0;
    while ((lineMatch = linePattern.exec(pageMatch[2]!)) !== null) {
      const lineBox = boxFromAttributes(lineMatch[1]!);
      const words = parseWords(lineMatch[2]!, pageIndex, sourceLineIndex);
      const lineId = `p${pageIndex + 1}-l${sourceLineIndex + 1}`;
      sourceLineIndex += 1;
      if (words.length === 0) continue;
      lines.push({
        ...lineBox,
        words,
        id: lineId,
      });
    }
    const page = { pageIndex, width, height, lines };
    validatePageGeometry(page);
    pages.push(page);
  }
  return pages;
}

function normalizedBox(box: Box, page: PopplerPage): NormalizedBox {
  return {
    x: box.xMin / page.width,
    y: box.yMin / page.height,
    width: (box.xMax - box.xMin) / page.width,
    height: (box.yMax - box.yMin) / page.height,
  };
}

function unionBox(boxes: readonly Box[]): Box {
  if (boxes.length === 0) throw new Error('poppler-layout-empty-line');
  return boxes.slice(1).reduce(
    (result, box) => ({
      xMin: Math.min(result.xMin, box.xMin),
      yMin: Math.min(result.yMin, box.yMin),
      xMax: Math.max(result.xMax, box.xMax),
      yMax: Math.max(result.yMax, box.yMax),
    }),
    boxes[0]!,
  );
}

function pageToVision(page: PopplerPage): PopplerVisionPage {
  let sourceCursor = 0;
  const observations: PopplerVisionObservation[] = [];
  const sourceLines: string[] = [];
  for (const line of page.lines) {
    const text = line.words.map((word) => word.text).join(' ');
    const spans: PopplerVisionSpan[] = [];
    let lineCursor = 0;
    for (const [index, word] of line.words.entries()) {
      if (index > 0) lineCursor += 1;
      const start = lineCursor;
      const end = start + word.text.length;
      spans.push({
        id: word.id,
        text: word.text,
        start,
        end,
        boundingBox: normalizedBox(word, page),
      });
      lineCursor = end;
    }
    observations.push({
      id: line.id,
      text,
      pageIndex: page.pageIndex,
      boundingBox: normalizedBox(unionBox(line.words), page),
      sourceStart: sourceCursor,
      sourceEnd: sourceCursor + text.length,
      spans,
    });
    sourceLines.push(text);
    sourceCursor += text.length + 1;
  }
  return {
    pageIndex: page.pageIndex,
    width: page.width,
    height: page.height,
    sourceText: sourceLines.join('\n'),
    sourceTextConstruction: POPPLER_SOURCE_TEXT_CONSTRUCTION,
    sourceOffsetKind: POPPLER_SOURCE_OFFSET_KIND,
    result: {
      contractVersion: 'alyte.poppler.word-lines.v1',
      pageIndex: page.pageIndex,
      orientation: 0,
      observations,
    },
  };
}

export function toVisionPages(pages: readonly PopplerPage[]): readonly PopplerVisionPage[] {
  return pages.map(pageToVision);
}

function sha256Bytes(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

function sha256File(path: string): string {
  return sha256Bytes(readFileSync(path));
}

function isPathInside(root: string, candidate: string): boolean {
  const remainder = relative(resolve(root), resolve(candidate));
  return (
    remainder === '' ||
    (remainder !== '..' && !remainder.startsWith(`..${sep}`) && !isAbsolute(remainder))
  );
}

function safeDataPath(path: string, privateRoot: string, output: boolean): string {
  const root = realpathSync(resolve(privateRoot));
  const candidate = resolve(path);
  if (!isPathInside(root, candidate)) throw new Error('poppler-layout-private-path');
  if (!output) {
    if (!existsSync(candidate) || !isPathInside(root, realpathSync(candidate))) {
      throw new Error('poppler-layout-private-path');
    }
    if (!statSync(candidate).isFile()) throw new Error('poppler-layout-private-path');
    return realpathSync(candidate);
  }
  const parent = dirname(candidate);
  if (!isPathInside(root, parent)) throw new Error('poppler-layout-private-path');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  chmodSync(parent, 0o700);
  if (!isPathInside(root, realpathSync(parent))) throw new Error('poppler-layout-private-path');
  if (existsSync(candidate)) {
    const entry = lstatSync(candidate);
    if (entry.isSymbolicLink() || !isPathInside(root, realpathSync(candidate))) {
      throw new Error('poppler-layout-private-path');
    }
  }
  return candidate;
}

function runtimeVersion(value: string): string {
  if (value.length === 0 || value.length > 256 || /[\r\n]/u.test(value)) {
    throw new Error('poppler-layout-runtime-invalid');
  }
  return value;
}

function pdftotextBinary(): { readonly path: string; readonly version: string } {
  const path = execFileSync('which', ['pdftotext'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  if (path.length === 0) throw new Error('poppler-layout-binary-missing');
  const versionResult = spawnSync(path, ['-v'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const version = `${versionResult.stdout ?? ''}\n${versionResult.stderr ?? ''}`
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
  if (version === undefined) throw new Error('poppler-layout-version-missing');
  return { path, version };
}

export function readPopplerLayout(options: {
  readonly reportPath: string;
  readonly outputPath: string;
  readonly privateRoot: string;
  readonly runtimeVersion: string;
}): {
  readonly rawText: string;
  readonly pages: readonly PopplerVisionPage[];
  readonly wordCount: number;
  readonly lineCount: number;
  readonly identity: {
    readonly reportSha256: string;
    readonly readerVersion: string;
    readonly runtimeVersion: string;
    readonly readerBinarySha256: string;
    readonly readerSourceSha256: string;
  };
} {
  const reportPath = safeDataPath(options.reportPath, options.privateRoot, false);
  const outputPath = safeDataPath(options.outputPath, options.privateRoot, true);
  const runtime = runtimeVersion(options.runtimeVersion);
  const reportSha256 = sha256File(reportPath);
  const readerBinarySha256 = sha256File(process.execPath);
  const readerSourceSha256 = sha256File(fileURLToPath(import.meta.url));
  const poppler = pdftotextBinary();
  const xml = execFileSync(poppler.path, ['-bbox-layout', '-enc', 'UTF-8', reportPath, '-'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 120_000,
    maxBuffer: 64 * 1024 * 1024,
  });
  const parsedPages = parseBboxLayoutDocument(xml);
  const pages = toVisionPages(parsedPages);
  if (sha256File(reportPath) !== reportSha256) {
    throw new Error('poppler-layout-report-mutated');
  }
  const envelope: RawEnvelope = {
    readerVersion: POPPLER_LAYOUT_READER_VERSION,
    runtimeVersion: runtime,
    reportSha256,
    readerBinarySha256,
    readerSourceSha256,
    pdftotextBinarySha256: sha256File(poppler.path),
    pdftotextVersion: poppler.version,
    sourceTextConstruction: POPPLER_SOURCE_TEXT_CONSTRUCTION,
    sourceOffsetKind: POPPLER_SOURCE_OFFSET_KIND,
    pageCount: pages.length,
    pages,
  };
  const rawText = `${JSON.stringify(envelope)}\n`;
  writeFileSync(outputPath, rawText, { encoding: 'utf8', mode: 0o600 });
  chmodSync(outputPath, 0o600);
  return {
    rawText,
    pages,
    lineCount: pages.reduce((count, page) => count + page.result.observations.length, 0),
    wordCount: pages.reduce(
      (count, page) =>
        count +
        page.result.observations.reduce((lineCount, line) => lineCount + line.spans.length, 0),
      0,
    ),
    identity: {
      reportSha256,
      readerVersion: POPPLER_LAYOUT_READER_VERSION,
      runtimeVersion: runtime,
      readerBinarySha256,
      readerSourceSha256,
    },
  };
}

type RawSnapshotIdentity = {
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
};

type RawSnapshotBinding = {
  readonly schemaVersion: string;
  readonly snapshotSha256: string;
  readonly reportSha256: string;
  readonly readerVersion: string;
  readonly runtimeVersion: string;
  readonly readerBinarySha256: string;
  readonly readerSourceSha256: string;
};

type RawSnapshotBindingModule = {
  readonly createRawSnapshotBinding: (
    rawText: string,
    identity: RawSnapshotIdentity,
  ) => RawSnapshotBinding;
  readonly verifyRawSnapshotBinding: (
    rawText: string,
    binding: unknown,
    expected: RawSnapshotIdentity,
  ) => unknown;
};

function defaultBindingPath(outputPath: string): string {
  return outputPath.endsWith('.json')
    ? outputPath.replace(/\.json$/u, '.binding.json')
    : `${outputPath}.binding.json`;
}

function bindingModulePath(value: string | undefined): string {
  const path = value ?? resolve(dirname(fileURLToPath(import.meta.url)), 'raw-snapshot-binding.ts');
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error('poppler-layout-binding-module-missing');
  }
  return realpathSync(path);
}

export function writePopplerBinding(options: {
  readonly rawText: string;
  readonly identity: RawSnapshotIdentity;
  readonly outputPath: string;
  readonly bindingModule: RawSnapshotBindingModule;
}): RawSnapshotBinding {
  const binding = options.bindingModule.createRawSnapshotBinding(options.rawText, options.identity);
  options.bindingModule.verifyRawSnapshotBinding(options.rawText, binding, options.identity);
  writeFileSync(options.outputPath, `${JSON.stringify(binding)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(options.outputPath, 0o600);
  return binding;
}

function argument(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  const value = args[index + 1];
  return index >= 0 && value !== undefined && !value.startsWith('--') ? value : undefined;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    process.stdout.write(
      'Usage: alyte-poppler-layout-reader --report <pdf> --output <json> --private-root <dir> --runtime-version <version>\n',
    );
    return;
  }
  const reportPath = argument(args, '--report');
  const outputPath = argument(args, '--output');
  const privateRoot = argument(args, '--private-root');
  const runtime = argument(args, '--runtime-version');
  if (
    reportPath === undefined ||
    outputPath === undefined ||
    privateRoot === undefined ||
    runtime === undefined
  ) {
    throw new Error('poppler-layout-arguments-invalid');
  }
  const resolvedOutputPath = resolve(outputPath);
  const bindingOutputPath = resolve(
    argument(args, '--binding-output') ?? defaultBindingPath(resolvedOutputPath),
  );
  if (bindingOutputPath === resolvedOutputPath) throw new Error('poppler-layout-binding-path');
  const result = readPopplerLayout({
    reportPath,
    outputPath: resolvedOutputPath,
    privateRoot,
    runtimeVersion: runtime,
  });
  const safeBindingOutputPath = safeDataPath(bindingOutputPath, privateRoot, true);
  const moduleUrl = pathToFileURL(bindingModulePath(argument(args, '--binding-module'))).href;
  const bindingModule = (await import(moduleUrl)) as unknown as RawSnapshotBindingModule;
  if (
    typeof bindingModule.createRawSnapshotBinding !== 'function' ||
    typeof bindingModule.verifyRawSnapshotBinding !== 'function'
  ) {
    throw new Error('poppler-layout-binding-module-invalid');
  }
  writePopplerBinding({
    rawText: result.rawText,
    identity: result.identity,
    outputPath: safeBindingOutputPath,
    bindingModule,
  });
  process.stdout.write(
    `${JSON.stringify({
      lines: result.lineCount,
      observations: result.lineCount,
      pages: result.pages.length,
      words: result.wordCount,
    })}\n`,
  );
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    process.stderr.write('alyte-poppler-layout-reader failed\n');
    process.exitCode = 1;
  });
}

/**
 * Evaluation-only Poppler adapter for selectable-text PDFs.
 *
 * `pdftotext -bbox-layout` is used only as a local text-and-geometry reader. The adapter has no
 * catalogue, report-specific labels, ground-truth access, OCR, model, or cloud path. Pages with
 * no Poppler words produce no measurements rather than guessed image text.
 */
import { execFileSync } from 'node:child_process';
import { createHash as sha256Hash } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SCHEMA_VERSION = 'alyte.import-eval.v1' as const;
const PIPELINE_ID = 'alyte-poppler-bbox' as const;
const PIPELINE_VERSION = 'poppler-pdftotext-bbox-layout.v1' as const;
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

type Candidate = {
  readonly word: PopplerWord;
  readonly parsedValue: number;
  readonly comparator: '<' | '>' | '<=' | '>=' | '=' | null;
  readonly valueString: string;
  readonly range: boolean;
};

type RangeCandidate = {
  readonly text: string;
  readonly box: Box;
  readonly xMin: number;
};

function attr(attrs: string, name: string): string | null {
  const match = attrs.match(new RegExp(`${name}="([^"]*)"`, 'u'));
  return match?.[1] ?? null;
}

function numberAttr(attrs: string, name: string): number {
  const value = Number(attr(attrs, name));
  if (!Number.isFinite(value)) throw new Error('poppler-bbox-attribute-invalid');
  return value;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&apos;/gu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#([0-9]+);/gu, (_, decimal: string) => String.fromCodePoint(Number(decimal)));
}

function boxFromAttributes(attrs: string): Box {
  const xMin = numberAttr(attrs, 'xMin');
  const yMin = numberAttr(attrs, 'yMin');
  const xMax = numberAttr(attrs, 'xMax');
  const yMax = numberAttr(attrs, 'yMax');
  if (!(xMax > xMin && yMax > yMin)) throw new Error('poppler-bbox-box-invalid');
  return { xMin, yMin, xMax, yMax };
}

function parseWords(body: string, pageIndex: number, lineIndex: number): readonly PopplerWord[] {
  const words: PopplerWord[] = [];
  const wordPattern = /<word\s+([^>]+)>([\s\S]*?)<\/word>/gu;
  let match: RegExpExecArray | null;
  while ((match = wordPattern.exec(body)) !== null) {
    const text = decodeXml(match[2]);
    if (text.length === 0 || /^\s+$/u.test(text)) continue;
    words.push({
      ...boxFromAttributes(match[1]),
      text,
      id: `p${pageIndex + 1}-l${lineIndex + 1}-w${words.length + 1}`,
    });
  }
  return words;
}

export function parseBboxLayoutDocument(input: string): readonly PopplerPage[] {
  const pages: PopplerPage[] = [];
  const pagePattern = /<page\s+([^>]+)>([\s\S]*?)<\/page>/gu;
  let pageMatch: RegExpExecArray | null;
  while ((pageMatch = pagePattern.exec(input)) !== null) {
    const pageIndex = pages.length;
    const lines: PopplerLine[] = [];
    const linePattern = /<line\s+([^>]+)>([\s\S]*?)<\/line>/gu;
    let lineMatch: RegExpExecArray | null;
    while ((lineMatch = linePattern.exec(pageMatch[2])) !== null) {
      const words = parseWords(lineMatch[2], pageIndex, lines.length);
      if (words.length === 0) continue;
      lines.push({
        ...boxFromAttributes(lineMatch[1]),
        words,
        id: `p${pageIndex + 1}-l${lines.length + 1}`,
      });
    }
    pages.push({
      pageIndex,
      width: numberAttr(pageMatch[1], 'width'),
      height: numberAttr(pageMatch[1], 'height'),
      lines,
    });
  }
  return pages;
}

function normalizedBox(
  box: Box,
  page: PopplerPage,
): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  return {
    x: box.xMin / page.width,
    y: box.yMin / page.height,
    width: (box.xMax - box.xMin) / page.width,
    height: (box.yMax - box.yMin) / page.height,
  };
}

function unionBox(boxes: readonly Box[]): Box {
  return boxes.reduce(
    (result, box) => ({
      xMin: Math.min(result.xMin, box.xMin),
      yMin: Math.min(result.yMin, box.yMin),
      xMax: Math.max(result.xMax, box.xMax),
      yMax: Math.max(result.yMax, box.yMax),
    }),
    boxes[0]!,
  );
}

function normalizedToken(value: string): string {
  return value
    .normalize('NFKC')
    .trim()
    .replace(/[\s  ]+/gu, ' ');
}

function numberFromToken(value: string): number | undefined {
  const cleaned = value
    .trim()
    .replace(/^[<>]=?|^[≤≥]/u, '')
    .replace(/[\s  ]/gu, '')
    .replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/u.test(cleaned)) return undefined;
  const number = Number(cleaned);
  return Number.isFinite(number) ? number : undefined;
}

function comparatorFromToken(value: string): Candidate['comparator'] {
  const match = value.trim().match(/^(<=|>=|<|>|=|≤|≥)/u)?.[1];
  if (match === undefined) return null;
  if (match === '≤') return '<=';
  if (match === '≥') return '>=';
  return match as Candidate['comparator'];
}

function isDateLike(value: string): boolean {
  return /^\d{1,4}[./-]\d{1,2}[./-]\d{1,4}(?:[T ]\d{1,2}:\d{2})?$/u.test(value);
}

function isIdentifierLike(value: string): boolean {
  return /^\d{6,}$/u.test(value) || /^[A-Z0-9]+-\d+$/u.test(value);
}

function unitKey(value: string): string {
  return normalizedToken(value).toLocaleLowerCase('en-US').replace(/[µμ]/gu, 'u');
}

export function tokenLooksLikeUnit(value: string): boolean {
  const token = unitKey(value);
  if (token === '%' || token === '°' || token === 'c') return true;
  if (token.includes('/') || token.includes('^') || token.includes('²') || token.includes('³')) {
    return /[a-zµμ]/iu.test(token);
  }
  return /^(?:u?mol|nmol|pmol|mmol|mg|mcg|ug|ng|pg|g|kg|ml|dl|fl|iu|miu|mu|kat|mmhg|kpa|bpm|ph|inr|sec|s|msec|meq|mosm|cells?)$/iu.test(
    token,
  );
}

function candidateFromWord(word: PopplerWord): Candidate | null {
  if (isDateLike(word.text) || isIdentifierLike(word.text)) return null;
  const parsedValue = numberFromToken(word.text);
  if (parsedValue === undefined) return null;
  return {
    word,
    parsedValue,
    comparator: comparatorFromToken(word.text),
    valueString: normalizedToken(word.text),
    range: false,
  };
}

function lineCenter(line: PopplerLine): number {
  return (line.yMin + line.yMax) / 2;
}

function groupRows(lines: readonly PopplerLine[]): readonly PopplerLine[][] {
  const groups: Array<{ center: number; lines: PopplerLine[] }> = [];
  for (const line of [...lines].sort((left, right) => lineCenter(left) - lineCenter(right))) {
    const threshold = Math.max(1.25, (line.yMax - line.yMin) * 0.35);
    const group = groups.find(
      (candidate) => Math.abs(candidate.center - lineCenter(line)) <= threshold,
    );
    if (group === undefined) groups.push({ center: lineCenter(line), lines: [line] });
    else {
      group.lines.push(line);
      group.center =
        group.lines.reduce((sum, item) => sum + lineCenter(item), 0) / group.lines.length;
    }
  }
  return groups.map((group) => group.lines.sort((left, right) => left.xMin - right.xMin));
}

function lineWords(lines: readonly PopplerLine[]): readonly PopplerWord[] {
  return lines.flatMap((line) => line.words).sort((left, right) => left.xMin - right.xMin);
}

function referenceCandidates(words: readonly PopplerWord[]): readonly RangeCandidate[] {
  const ranges: RangeCandidate[] = [];
  for (let index = 0; index < words.length - 2; index += 1) {
    const left = numberFromToken(words[index]!.text);
    const dash = words[index + 1]!.text;
    const right = numberFromToken(words[index + 2]!.text);
    if (left === undefined || right === undefined || !/^[-–—]$/u.test(dash)) continue;
    const box = unionBox(words.slice(index, index + 3));
    ranges.push({
      text: words
        .slice(index, index + 3)
        .map((word) => word.text)
        .join(' '),
      box,
      xMin: box.xMin,
    });
    index += 2;
  }
  return ranges;
}

function textLabel(lines: readonly PopplerLine[], value: Candidate): string | null {
  const candidates = lines
    .map((line) =>
      line.words.filter(
        (word) =>
          word.xMax < value.word.xMin &&
          numberFromToken(word.text) === undefined &&
          !isDateLike(word.text) &&
          !isIdentifierLike(word.text) &&
          !tokenLooksLikeUnit(word.text) &&
          !/^[-–—]$/u.test(word.text),
      ),
    )
    .filter((words) => words.length > 0)
    .sort((left, right) => {
      const leftX = Math.max(...left.map((word) => word.xMin));
      const rightX = Math.max(...right.map((word) => word.xMin));
      return rightX - leftX;
    });
  const label =
    candidates[0]
      ?.map((word) => word.text)
      .join(' ')
      .replace(/:$/u, '')
      .trim() ?? '';
  return label.length > 0 ? label : null;
}

function unitForValue(words: readonly PopplerWord[], value: Candidate): string | null {
  const units = words
    .filter((word) => tokenLooksLikeUnit(word.text))
    .sort(
      (left, right) =>
        Math.abs(left.xMin - value.word.xMin) - Math.abs(right.xMin - value.word.xMin),
    );
  if (units.length === 0) return null;
  const unit = units[0]!;
  const following = words.find(
    (word) => word.xMin >= unit.xMax && word.xMin - unit.xMax < 12 && tokenLooksLikeUnit(word.text),
  );
  return following === undefined ? normalizedToken(unit.text) : `${unit.text} ${following.text}`;
}

function associationForRow(page: PopplerPage, lines: readonly PopplerLine[], index: number) {
  const words = lineWords(lines);
  const ranges = referenceCandidates(words);
  const candidates = words
    .map(candidateFromWord)
    .filter((item): item is Candidate => item !== null);
  const rangeWords = new Set(
    ranges.flatMap((range) =>
      words.filter((word) => word.xMin >= range.xMin && word.xMax <= range.box.xMax),
    ),
  );
  const values = candidates.filter((candidate) => !rangeWords.has(candidate.word));
  if (values.length !== 1) return null;
  const value = values[0]!;
  const label = textLabel(lines, value);
  const unit = unitForValue(words, value);
  const reference = ranges.find((range) => range.xMin < value.word.xMin)?.text ?? null;
  if (label === null || (unit === null && reference === null)) return null;
  const rowBox = unionBox(words);
  return {
    id: `poppler-p${page.pageIndex + 1}-r${index + 1}`,
    sourceLabel: label,
    valueString: value.valueString,
    valueType: value.comparator === null ? 'numeric' : 'bounded',
    parsedValue: value.parsedValue,
    comparator: value.comparator,
    unit,
    referenceInterval: reference,
    flag: null,
    collectionDate: null,
    collectionGroup: null,
    specimen: null,
    page: page.pageIndex + 1,
    location: normalizedBox(rowBox, page),
    ambiguousFields: ['collectionDate'],
    canonicalBiomarkerId: null,
    trendEligible: null,
    unresolvedFields: ['collectionDate', 'canonicalBiomarkerId', 'trendEligible'],
    sourceIds: words.map((word) => word.id),
    // Kept in the private pipeline artifact for auditing exact Poppler provenance. The shared
    // evaluation contract ignores this extension when producing safe scores.
    sourceWordBoxes: words.map((word) => ({
      id: word.id,
      text: word.text,
      box: normalizedBox(word, page),
      page: page.pageIndex + 1,
    })),
  };
}

export function extractMeasurements(pages: readonly PopplerPage[]) {
  return pages.flatMap((page) =>
    groupRows(page.lines).flatMap((row, index) => {
      const measurement = associationForRow(page, row, index);
      return measurement === null ? [] : [measurement];
    }),
  );
}

function sha256(path: string): string {
  return sha256Hash('sha256').update(readFileSync(path)).digest('hex');
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function writeResult(output: string, result: unknown): void {
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
  writeFileSync(output, `${JSON.stringify(result)}\n`, { encoding: 'utf8', mode: 0o600 });
  chmodSync(output, 0o600);
}

export function main(): void {
  const report = argument('--report');
  const reportId = argument('--report-id');
  const output = argument('--output');
  if (report === undefined || reportId === undefined || output === undefined) {
    process.stderr.write('poppler-bbox-arguments-invalid\n');
    process.exitCode = 1;
    return;
  }
  const started = performance.now();
  try {
    const reportPath = resolve(report);
    const reportSha256 = sha256(reportPath);
    const popplerStarted = performance.now();
    const xml = execFileSync('pdftotext', ['-bbox-layout', '-enc', 'UTF-8', reportPath, '-'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    const pages = parseBboxLayoutDocument(xml);
    const popplerElapsedMs = performance.now() - popplerStarted;
    const extractionStarted = performance.now();
    const measurements = extractMeasurements(pages);
    const extractionElapsedMs = performance.now() - extractionStarted;
    const textPages = pages.filter((page) =>
      page.lines.some((line) => line.words.length > 0),
    ).length;
    const wordCount = pages.reduce(
      (count, page) =>
        count + page.lines.reduce((pageCount, line) => pageCount + line.words.length, 0),
      0,
    );
    const result = {
      schemaVersion: SCHEMA_VERSION,
      reportId,
      reportSha256,
      pipeline: {
        id: PIPELINE_ID,
        version: PIPELINE_VERSION,
        configuration: {
          command: 'pdftotext -bbox-layout -enc UTF-8',
          noOcr: true,
          noModel: true,
          noCloud: true,
          association: 'unique-numeric-value-with-generic-unit-or-reference',
          imageOnlyPolicy: 'zero-output',
        },
        runtime: {
          node: process.version,
          platform: `${process.platform}-${process.arch}`,
          poppler: (() => {
            try {
              return execFileSync('pdftotext', ['-v'], {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
              });
            } catch (error) {
              return error instanceof Error ? error.message : 'unavailable';
            }
          })()
            .split(/\r?\n/u)[0]
            .trim(),
        },
      },
      stages: [
        {
          name: 'poppler-pdftotext-bbox-layout',
          elapsedMs: popplerElapsedMs,
          inputCount: pages.length,
          outputCount: wordCount,
          status: 'complete',
        },
        {
          name: 'generic-geometry-association',
          elapsedMs: extractionElapsedMs,
          inputCount: pages.reduce((count, page) => count + page.lines.length, 0),
          outputCount: measurements.length,
          status: 'complete',
        },
      ],
      elapsedMs: performance.now() - started,
      measurements,
      diagnostics: {
        counts: {
          pages: pages.length,
          textPages,
          imageOnlyPages: pages.length - textPages,
          words: wordCount,
          lines: pages.reduce((count, page) => count + page.lines.length, 0),
          measurements: measurements.length,
          mappedMeasurements: 0,
          unsupportedMapping: measurements.length,
          reviewRows: measurements.length,
        },
        limitations: [
          'This evaluation adapter reads selectable PDF text and geometry only; it does not OCR image-only pages.',
          'Generic association intentionally leaves dates, specimen, canonical mapping, and trend eligibility unresolved.',
        ],
      },
    };
    writeResult(resolve(output), result);
  } catch {
    process.stderr.write('poppler-bbox-adapter-failed\n');
    process.exitCode = 1;
  }
}

if (resolve(process.argv[1] ?? '') === resolve(fileURLToPath(import.meta.url))) main();

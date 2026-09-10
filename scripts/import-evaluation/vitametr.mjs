#!/usr/bin/env node

/**
 * Private macOS import-evaluation adapter for Vitametr's public PDF parser.
 *
 * This file deliberately keeps the competitor tree out of Alyte. At runtime it
 * bundles Vitametr's own `lab-parsers.ts` graph from the pinned checkout under
 * /tmp, extracts the PDF text with the same PDF.js rounded-Y/X reconstruction
 * used by Vitametr's public `pdf.ts`, and adapts only the returned proposals to
 * the frozen Alyte import-evaluation contract.
 *
 * No source text is printed. The detailed JSON belongs under the private
 * .scratch/import-evaluation root supplied by the caller.
 */

import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { chmod, readFile, writeFile, mkdir, access } from 'node:fs/promises';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const SCHEMA_VERSION = 'alyte.import-eval.v1';
const ADAPTER_VERSION = 'vitametr-adapter.v4';
const DEFAULT_VITAMETR_ROOT = '/tmp/alyte-vitametr-research';
const DEFAULT_PRIVATE_ROOT = resolve(
  dirname(new URL(import.meta.url).pathname),
  '../../.scratch/import-evaluation',
);

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node scripts/import-evaluation/vitametr.mjs --report <pdf> --report-id <id> --output <json>',
      '',
      'Optional:',
      '  --vitametr-root <dir>  pinned external checkout (default /tmp/alyte-vitametr-research)',
      '  --private-root <dir>   private evaluation root for diagnostics (default project .scratch path)',
      '  --help',
      '',
    ].join('\n'),
  );
}

function fail(category) {
  // Keep errors structural and never include report text or parser output.
  process.stderr.write(`vitametr adapter error: ${category}\n`);
  process.exitCode = 2;
}

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      usage();
      process.exit(0);
    }
    if (!arg.startsWith('--')) throw new Error(`unknown option ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (!value || value.startsWith('--')) throw new Error(`missing value for --${key}`);
    options[key] = value;
    i += 1;
  }
  for (const key of ['report', 'report-id', 'output']) {
    if (!options[key]) throw new Error(`missing required --${key}`);
  }
  return options;
}

function sha256Bytes(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(text) {
  return createHash('sha256').update(text).digest('hex');
}

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
  } catch {
    return 'unavailable';
  }
}

function packageVersion(root, packageName) {
  try {
    const requireFromVitametr = createRequire(join(root, 'package.json'));
    return requireFromVitametr(`${packageName}/package.json`).version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function normalizedText(value) {
  return String(value).replace(/\s+/g, ' ').trim();
}

function isWithin(childPath, parentPath) {
  const child = resolve(childPath);
  const parent = resolve(parentPath);
  const remainder = relative(parent, child);
  return (
    remainder !== '' &&
    remainder !== '..' &&
    !remainder.startsWith(`..${sep}`) &&
    !isAbsolute(remainder)
  );
}

/**
 * Resolve an existing path fully, or resolve its nearest existing parent and append the
 * non-existent suffix. This catches symlink escapes before a caller creates an output directory.
 */
function privatePathError() {
  const error = new Error('private path rejected');
  error.code = 'private-path';
  return error;
}

function realpathWithNearestExisting(path) {
  const unresolved = [];
  let current = resolve(path);
  while (true) {
    let stats;
    try {
      stats = lstatSync(current);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw privatePathError();
      const parent = dirname(current);
      if (parent === current) return current;
      unresolved.unshift(basename(current));
      current = parent;
      continue;
    }
    if (stats.isSymbolicLink()) {
      try {
        return resolve(realpathSync(current), ...unresolved);
      } catch {
        throw privatePathError();
      }
    }
    return resolve(realpathSync(current), ...unresolved);
  }
  /* c8 ignore next -- the loop always returns or throws. */
  throw privatePathError();
}

async function ensurePrivateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function ensurePrivateFile(path, contents) {
  await writeFile(path, contents, { encoding: 'utf8', mode: 0o600 });
  await chmod(path, 0o600);
}

function validatePrivatePaths(options, reportPath, outputPath, privateRoot) {
  if (!/^[A-Za-z0-9._-]+$/u.test(options['report-id'] ?? '')) {
    const error = new Error('unsafe report id');
    error.code = 'unsafe-report-id';
    throw error;
  }
  const rootReal = realpathWithNearestExisting(privateRoot);
  const reportsReal = realpathWithNearestExisting(join(privateRoot, 'reports'));
  const runsReal = realpathWithNearestExisting(join(privateRoot, 'runs'));
  const reportReal = realpathWithNearestExisting(reportPath);
  const outputReal = realpathWithNearestExisting(outputPath);
  if (
    !isWithin(reportsReal, rootReal) ||
    !isWithin(runsReal, rootReal) ||
    !isWithin(reportReal, reportsReal)
  ) {
    const error = new Error('report outside private root');
    error.code = 'private-path';
    throw error;
  }
  if (!isWithin(outputReal, rootReal) || !outputPath.endsWith('.json')) {
    const error = new Error('output outside private root');
    error.code = 'private-path';
    throw error;
  }
}

function structuralErrorCategory(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  const name = error && typeof error === 'object' ? error.name : undefined;
  if (code === 'private-path') return 'private-path-rejected';
  if (code === 'unsafe-report-id') return 'unsafe-report-id';
  if (code === 'ENOENT') return 'input-not-found';
  if (name === 'PasswordException') return 'password-protected-pdf';
  if (name === 'InvalidPDFException') return 'invalid-pdf';
  if (code === 'contract-shape') return 'contract-shape-invalid';
  return 'adapter-failed';
}

async function writeFailureResult(options, category) {
  if (!options?.output || !options?.['report-id']) return;
  const privateRoot = resolve(options['private-root'] ?? DEFAULT_PRIVATE_ROOT);
  const outputPath = resolve(options.output);
  const reportPath = resolve(
    options.report ?? join(privateRoot, 'reports', `${options['report-id']}.pdf`),
  );
  try {
    validatePrivatePaths(options, reportPath, outputPath, privateRoot);
  } catch {
    return;
  }
  let reportSha256 = 'unavailable';
  try {
    reportSha256 = sha256Bytes(await readFile(reportPath));
  } catch {
    // Keep the failure envelope valid without exposing an input error message.
  }
  const result = {
    schemaVersion: SCHEMA_VERSION,
    reportId: options['report-id'],
    reportSha256,
    pipeline: {
      id: 'vitametr-public-pdf',
      version: ADAPTER_VERSION,
      configuration: { failureCategory: category, noOcr: true, noCloud: true },
      runtime: { node: process.version, platform: `${process.platform}-${process.arch}` },
    },
    stages: [],
    elapsedMs: 0,
    measurements: [],
    diagnostics: { counts: {}, limitations: [`adapter-failure:${category}`] },
  };
  await ensurePrivateDirectory(privateRoot);
  await ensurePrivateDirectory(join(privateRoot, 'reports'));
  await ensurePrivateDirectory(join(privateRoot, 'runs'));
  await ensurePrivateDirectory(dirname(outputPath));
  await ensurePrivateFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
}

function numericTokenValue(token) {
  const cleaned = String(token)
    .trim()
    .replace(/^[<>]=?|^[≤≥]/u, '')
    .replace(/[\s  ]/g, '')
    .replace(',', '.');
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(cleaned)) return undefined;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : undefined;
}

function valueMatches(token, value) {
  const parsed = numericTokenValue(token);
  return (
    parsed !== undefined && Math.abs(parsed - value) <= Math.max(1e-12, Math.abs(value) * 1e-12)
  );
}

function unitTokenKey(value) {
  return String(value)
    .trim()
    .toLowerCase()
    .replace(/[\s  ]/g, '')
    .replace(/[µμ]/g, 'u')
    .replace(/²/g, '2')
    .replace(/³/g, '3')
    .replace(/\^/g, '*');
}

function tokenLooksLikeUnit(token) {
  const key = unitTokenKey(token);
  return (
    /(?:\b(?:mmol|umol|nmol|pmol|mg|ug|mcg|ng|pg|g|m|u?kat|miu|mu|iu|10\*?\d+|ml|fl|mmhg|kpa|bpm)\b|[/‰%]|\[pH\]|\{INR\})/iu.test(
      key,
    ) || key === 'c'
  );
}

function sourceFieldsFromRaw(proposal) {
  const raw = normalizedText(proposal.rawText ?? '');
  const tokens = raw.split(' ').filter(Boolean);
  const numericCandidates =
    proposal.value === undefined
      ? []
      : tokens
          .map((token, index) => ({ token, index }))
          .filter(({ token }) => valueMatches(token, proposal.value));
  // Prefer the candidate immediately followed by the unit (the same local
  // association the public parser uses); this avoids treating a number in a
  // biomarker name such as "25-OH vitamin D" as the measured value.
  const numericIndex =
    numericCandidates.find(({ index }) => {
      const next = tokens[index + 1];
      const afterFlag = tokens[index + 2];
      return (
        tokenLooksLikeUnit(next ?? '') ||
        (/^(?:H|L|\*|↑|↓)$/iu.test(next ?? '') && tokenLooksLikeUnit(afterFlag ?? ''))
      );
    })?.index ??
    numericCandidates.at(-1)?.index ??
    -1;

  if (proposal.textValue !== undefined || proposal.textValues?.length) {
    const textValue = proposal.textValues?.join(', ') ?? proposal.textValue ?? '';
    const index = tokens.findIndex(
      (token) => token.toLocaleLowerCase() === textValue.toLocaleLowerCase(),
    );
    const sourceLabel = index > 0 ? tokens.slice(0, index).join(' ').replace(/:$/, '').trim() : raw;
    return {
      sourceLabel: sourceLabel || raw,
      valueString: textValue || null,
      unit: null,
      flag: null,
    };
  }

  if (numericIndex < 0) {
    return { sourceLabel: raw, valueString: null, unit: null, flag: null };
  }

  let valueStart = numericIndex;
  if (valueStart > 0 && /^(?:<=|>=|≤|≥|<|>)$/u.test(tokens[valueStart - 1])) valueStart -= 1;
  const valueString = tokens.slice(valueStart, numericIndex + 1).join(' ') || null;
  let unit = null;
  let flag = null;
  let after = numericIndex + 1;
  if (after < tokens.length && /^(?:H|L|\*|↑|↓)$/iu.test(tokens[after])) {
    flag = tokens[after];
    after += 1;
  }
  if (after < tokens.length && tokenLooksLikeUnit(tokens[after])) {
    const unitParts = [tokens[after]];
    // eGFR forms such as `mL/min/1.73 m2` are split by PDF.js at the space.
    if (after + 1 < tokens.length && /^(?:m2|m²|10\^?\d+)$/iu.test(tokens[after + 1]))
      unitParts.push(tokens[after + 1]);
    unit = unitParts.join(' ');
  }
  const sourceLabel = tokens.slice(0, valueStart).join(' ').replace(/:$/, '').trim();
  return {
    sourceLabel: sourceLabel || raw,
    valueString,
    unit,
    flag,
  };
}

function createEmptyProfile() {
  // Runtime shape required by Vitametr's public createCatalog. No data is
  // written back to the external app and no user profile is opened.
  return { metrics: [], sources: [], measurements: [], settings: {} };
}

async function loadPublicParser(vitametrRoot, revision) {
  const requireFromVitametr = createRequire(join(vitametrRoot, 'package.json'));
  const esbuild = requireFromVitametr('esbuild');
  const bundleKey = sha256Text(`${vitametrRoot}:${revision}:lab-parsers`).slice(0, 16);
  const output = join('/tmp', `alyte-vitametr-parser-${bundleKey}.mjs`);
  if (!existsSync(output)) {
    await esbuild.build({
      entryPoints: [join(vitametrRoot, 'src/plugins/import/lab-parsers.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: output,
      logLevel: 'silent',
    });
  }
  const module = await import(`${pathToFileURL(output).href}?${bundleKey}`);
  const catalogModule = await import(
    `${pathToFileURL(join(vitametrRoot, 'src/core/catalog-data.ts')).href}?${bundleKey}`
  ).catch(() => undefined);
  // The bundled graph has catalog-data internally; expose its parse function and
  // create a catalog from a second small bundle rather than copying seed data.
  const catalogBundle = join('/tmp', `alyte-vitametr-catalog-${bundleKey}.mjs`);
  if (!existsSync(catalogBundle)) {
    await esbuild.build({
      entryPoints: [join(vitametrRoot, 'src/core/catalog.ts')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: 'node20',
      outfile: catalogBundle,
      logLevel: 'silent',
    });
  }
  const catalog = await import(`${pathToFileURL(catalogBundle).href}?${bundleKey}`);
  return {
    parseLabDocument: module.parseLabDocument,
    createCatalog: catalog.createCatalog,
    catalogModule,
  };
}

async function extractText(vitametrRoot, reportPath) {
  const requireFromVitametr = createRequire(join(vitametrRoot, 'package.json'));
  const pdfjsPath = requireFromVitametr.resolve('pdfjs-dist/legacy/build/pdf.mjs');
  const pdfjs = await import(pathToFileURL(pdfjsPath).href);
  const data = new Uint8Array(await readFile(reportPath));
  const doc = await pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableWorker: true,
    verbosity: 0,
  }).promise;
  const pages = [];
  const lines = [];
  for (let pageNumber = 1; pageNumber <= doc.numPages; pageNumber += 1) {
    const page = await doc.getPage(pageNumber);
    const content = await page.getTextContent();
    const byRow = new Map();
    for (const item of content.items) {
      if (!item || !('str' in item)) continue;
      if (String(item.str).trim() === '') continue;
      const y = Math.round(item.transform[5]);
      const row = byRow.get(y);
      if (row) row.push(item);
      else byRow.set(y, [item]);
    }
    const pageLines = [...byRow.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([y, items]) => ({
        text: normalizedText(
          items
            .sort((a, b) => a.transform[4] - b.transform[4])
            .map((item) => item.str)
            .join(' '),
        ),
        y,
        x: items.length ? Math.min(...items.map((item) => item.transform[4])) : null,
      }))
      .filter((line) => line.text !== '');
    pages.push({ page: pageNumber, lines: pageLines });
    for (const line of pageLines) lines.push({ ...line, page: pageNumber });
  }
  return { pages, lines };
}

function locateProposalLine(proposal, lines, startAt) {
  const raw = normalizedText(proposal.rawText ?? '');
  for (let index = startAt; index < lines.length; index += 1) {
    if (lines[index].text === raw) return { line: lines[index], next: index + 1 };
  }
  // SmartMedix-specific blocks can be combined by the competitor parser. Keep
  // page provenance best-effort without changing or re-parsing that output.
  if (raw) {
    for (let index = startAt; index < lines.length; index += 1) {
      if (lines[index].text.includes(raw) || raw.includes(lines[index].text)) {
        return { line: lines[index], next: index + 1 };
      }
    }
  }
  return { line: null, next: startAt };
}

function adaptProposal(proposal, index, lineInfo, catalog) {
  const source = sourceFieldsFromRaw(proposal);
  const resolved = typeof proposal.metric === 'string';
  const metric = resolved ? catalog.byId(proposal.metric) : undefined;
  const unresolvedName = resolved ? null : (proposal.metric?.unresolvedName ?? null);
  const valueType =
    proposal.value !== undefined
      ? proposal.operator
        ? 'bounded'
        : 'numeric'
      : proposal.textValue !== undefined || proposal.textValues?.length
        ? 'categorical'
        : 'unknown';
  const valueString =
    source.valueString ??
    (proposal.value !== undefined ? String(proposal.value) : (proposal.textValue ?? null));
  const measurement = {
    id: `vitametr-${index + 1}`,
    sourceLabel: source.sourceLabel,
    valueString,
    valueType,
    parsedValue:
      proposal.value !== undefined
        ? proposal.value
        : (proposal.textValues?.join(', ') ?? proposal.textValue ?? null),
    comparator: proposal.operator ?? null,
    unit: source.unit ?? proposal.unit ?? null,
    referenceInterval: proposal.refText ?? null,
    flag: source.flag,
    collectionDate: proposal.takenAt ? proposal.takenAt.slice(0, 10) : null,
    collectionGroup: null,
    specimen: null,
    page: lineInfo?.page ?? null,
    location: null,
    ambiguousFields: [],
    canonicalBiomarkerId: null,
    trendEligible: null,
    unresolvedFields: [
      ...(resolved ? [] : ['canonicalBiomarkerId']),
      ...(proposal.takenAt ? [] : ['collectionDate']),
      ...(proposal.value !== undefined && !source.unit && !proposal.unit ? ['unit'] : []),
    ],
    sourceIds: [`vitametr-line-${index + 1}`],
    mappingStatus: resolved && metric ? 'resolved-in-vitametr' : 'unsupported-in-vitametr-catalog',
    vitametrMetricId: resolved ? proposal.metric : null,
    vitametrMetricKey: metric?.key ?? null,
    rawText: proposal.rawText ?? null,
    // Private provenance for auditing adapter-induced field changes. This is a
    // structured clone of the exact public parser proposal; it is never logged
    // and remains inside the private result artifact.
    rawProposal: structuredClone(proposal),
  };
  if (unresolvedName) measurement.sourceLabel = source.sourceLabel || unresolvedName;
  return measurement;
}

async function run(options) {
  const reportPath = resolve(options.report);
  const outputPath = resolve(options.output);
  const vitametrRoot = resolve(options['vitametr-root'] ?? DEFAULT_VITAMETR_ROOT);
  const privateRoot = resolve(options['private-root'] ?? DEFAULT_PRIVATE_ROOT);
  validatePrivatePaths(options, reportPath, outputPath, privateRoot);
  await ensurePrivateDirectory(privateRoot);
  await ensurePrivateDirectory(join(privateRoot, 'reports'));
  await ensurePrivateDirectory(join(privateRoot, 'runs'));
  await ensurePrivateDirectory(join(privateRoot, 'runs', 'vitametr'));
  await access(reportPath);
  // Keep the approved source artifact private even when it already existed with
  // a permissive mode. chmod follows only the already-validated report path.
  await chmod(reportPath, 0o600);
  await access(join(vitametrRoot, 'package.json'));
  const reportBytes = await readFile(reportPath);
  const reportSha256 = sha256Bytes(reportBytes);
  const revision = git(vitametrRoot, ['rev-parse', 'HEAD']);
  const started = performance.now();
  const stages = [];

  const textStart = performance.now();
  const extracted = await extractText(vitametrRoot, reportPath);
  stages.push({
    name: 'pdf-text',
    elapsedMs: Math.round((performance.now() - textStart) * 100) / 100,
    inputCount: extracted.pages.length,
    outputCount: extracted.lines.length,
    status: 'ok',
  });

  const parserStart = performance.now();
  const publicParser = await loadPublicParser(vitametrRoot, revision);
  const catalog = publicParser.createCatalog(createEmptyProfile());
  const parsed = publicParser.parseLabDocument(
    extracted.lines.map((line) => line.text),
    catalog,
  );
  stages.push({
    name: 'vitametr-parseLabDocument',
    elapsedMs: Math.round((performance.now() - parserStart) * 100) / 100,
    inputCount: extracted.lines.length,
    outputCount: parsed.proposals.length,
    status: 'ok',
  });

  const adaptStart = performance.now();
  let lineCursor = 0;
  const measurements = parsed.proposals.map((proposal, index) => {
    const found = locateProposalLine(proposal, extracted.lines, lineCursor);
    lineCursor = found.next;
    return adaptProposal(proposal, index, found.line, catalog);
  });
  stages.push({
    name: 'contract-adaptation',
    elapsedMs: Math.round((performance.now() - adaptStart) * 100) / 100,
    inputCount: parsed.proposals.length,
    outputCount: measurements.length,
    status: 'ok',
  });

  const sourceHashes = {};
  for (const relativePath of [
    'src/plugins/import/pdf.ts',
    'src/plugins/import/lab-parsers.ts',
    'src/plugins/import/lab-text.ts',
  ]) {
    sourceHashes[relativePath] = sha256Bytes(await readFile(join(vitametrRoot, relativePath)));
  }
  const resolvedCount = measurements.filter(
    (measurement) => measurement.mappingStatus === 'resolved-in-vitametr',
  ).length;
  const unresolvedCount = measurements.length - resolvedCount;
  const elapsedMs = Math.round((performance.now() - started) * 100) / 100;
  const result = {
    schemaVersion: SCHEMA_VERSION,
    reportId: options['report-id'],
    reportSha256,
    pipeline: {
      id: 'vitametr-public-pdf',
      version: ADAPTER_VERSION,
      configuration: {
        externalCheckout: vitametrRoot,
        externalRevision: revision,
        parserEntry: 'src/plugins/import/lab-parsers.ts',
        pdfExtraction:
          'public pdf.ts rounded transform[5] Y rows, descending Y, ascending transform[4] X',
        parserSelection: 'parseLabDocument built-in chain then generic fallback',
        catalog: 'Vitametr BUILTIN_METRICS through createCatalog(empty profile)',
        noOcr: true,
        noCloud: true,
        sourceHashes,
      },
      runtime: {
        node: process.version,
        platform: `${process.platform}-${process.arch}`,
        pdfjsDist: packageVersion(vitametrRoot, 'pdfjs-dist'),
        esbuild: packageVersion(vitametrRoot, 'esbuild'),
        vitametrPackage: packageVersion(vitametrRoot, '.'),
      },
    },
    stages,
    elapsedMs,
    measurements,
    diagnostics: {
      counts: {
        pages: extracted.pages.length,
        textLines: extracted.lines.length,
        proposals: parsed.proposals.length,
        measurements: measurements.length,
        resolvedMappings: resolvedCount,
        unsupportedMappings: unresolvedCount,
        missingCollectionDates: measurements.filter((measurement) => !measurement.collectionDate)
          .length,
        missingPages: measurements.filter((measurement) => measurement.page === null).length,
      },
      limitations: [
        'Vitametr public PDF path does not expose source bounding boxes or specimen context; those fields remain null.',
        'Vitametr proposals do not retain a separate source label; sourceLabel/valueString/unit are recovered from each proposal rawText for contract comparison.',
        'Vitametr metric IDs are reported as mapping diagnostics only and are not asserted as Alyte canonical biomarker IDs.',
        'This adapter executes PDF.js with disableWorker on Node while preserving the public text reconstruction and parser logic.',
      ],
      parserId: parsed.parserId,
      sourceName: parsed.sourceName ?? null,
    },
  };
  if (
    result.schemaVersion !== SCHEMA_VERSION ||
    typeof result.reportId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(result.reportSha256) ||
    !Array.isArray(result.measurements) ||
    !Array.isArray(result.stages) ||
    !result.diagnostics ||
    !Array.isArray(result.diagnostics.limitations)
  ) {
    const error = new Error('result shape invalid');
    error.code = 'contract-shape';
    throw error;
  }
  await ensurePrivateDirectory(dirname(outputPath));
  await ensurePrivateFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  // The explicit output path remains authoritative. Do not create a second
  // report-bearing copy under the private root unless it is requested there.
  process.stdout.write(
    `vitametr reportId=${options['report-id']} measurements=${measurements.length} elapsedMs=${elapsedMs}\n`,
  );
}

export {
  adaptProposal,
  ensurePrivateDirectory,
  ensurePrivateFile,
  parseArgs,
  sourceFieldsFromRaw,
  structuralErrorCategory,
  validatePrivatePaths,
};

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
    await run(options);
  } catch (error) {
    const category = structuralErrorCategory(error);
    await writeFailureResult(options, category);
    fail(category);
  }
}

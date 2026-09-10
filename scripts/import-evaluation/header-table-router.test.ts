import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  classifyHeaderTablePage,
  runRoutedHeaderTable,
  type RoutedHeaderTablePage,
} from './header-table-router';

function box(x: number, y: number, width = 0.16, height = 0.02) {
  return { x, y, width, height };
}

function cell(
  id: string,
  text: string,
  rowIndex: number,
  columnIndex: number,
  x: number,
  y: number,
) {
  return {
    id,
    text,
    pageIndex: 0,
    boundingBox: box(x, y),
    structure: {
      kind: 'table-cell' as const,
      tableId: 'table-a',
      rowIndex,
      columnIndex,
    },
    spans: [],
  };
}

function structuredPage(): RoutedHeaderTablePage {
  return {
    pageIndex: 0,
    width: 1000,
    height: 1000,
    readerVersion: 'alyte.mac.poppler-layout-reader.v1',
    sourceText: 'Test\nCurrent Result\nSynthetic marker\n7.3',
    sourceTextConstruction: 'poppler-word-lines.v1',
    sourceOffsetKind: 'synthetic-page-text-utf16',
    observations: [
      cell('header-label', 'Test', 0, 0, 0.08, 0.1),
      cell('header-value', 'Current Result', 0, 1, 0.42, 0.1),
      cell('result-label', 'Synthetic marker', 1, 0, 0.08, 0.16),
      cell('result-value', '7.3', 1, 1, 0.42, 0.16),
    ],
  };
}

function unstructuredPage(pageIndex = 1): RoutedHeaderTablePage {
  return {
    pageIndex,
    width: 1000,
    height: 1000,
    readerVersion: null,
    sourceText: null,
    sourceTextConstruction: null,
    sourceOffsetKind: null,
    observations: [
      {
        id: 'line-1',
        text: 'Synthetic marker 7.3',
        pageIndex,
        boundingBox: box(0.08, 0.1, 0.5),
        spans: [],
      },
    ],
  };
}

test('routes a bound selectable-text page regardless of table-cell richness', () => {
  assert.deepEqual(classifyHeaderTablePage(structuredPage()), {
    pageIndex: 0,
    kind: 'structured-text-table',
    reason: 'bound-selectable-text-source',
    observationCount: 4,
    structuredObservationCount: 0,
    tableCount: 0,
    rowCount: 0,
    columnCount: 0,
  });
  const deferred = classifyHeaderTablePage(unstructuredPage());
  assert.equal(deferred.kind, 'unstructured-or-image');
  assert.equal(deferred.reason, 'mixed-or-unknown-provenance');
});

test('Vision inferred cells never enter the deterministic route without source provenance', () => {
  const route = classifyHeaderTablePage({
    ...structuredPage(),
    readerVersion: 'alyte.mac.vision-reader.v1',
    sourceText: null,
    sourceTextConstruction: null,
    sourceOffsetKind: null,
  });
  assert.equal(route.kind, 'unstructured-or-image');
  assert.equal(route.reason, 'mixed-or-unknown-provenance');
});

test('a selectable-text page with no inferred cells still enters the deterministic route', () => {
  const page = structuredPage();
  const route = classifyHeaderTablePage({
    ...page,
    observations: [
      {
        ...page.observations[0]!,
        structure: undefined,
      },
    ],
  });
  assert.equal(route.kind, 'structured-text-table');
  assert.equal(route.reason, 'bound-selectable-text-source');
});

test('bound routed runner records deferred pages and fast-path output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-header-router-'));
  chmodSync(root, 0o700);
  const reportPath = join(root, 'report.pdf');
  const snapshotPath = join(root, 'source.json');
  const bindingPath = join(root, 'source.binding.json');
  const outputPath = join(root, 'pipeline.json');
  writeFileSync(reportPath, 'synthetic report', { mode: 0o600 });
  const reportSha256 = createHash('sha256').update(readFileSync(reportPath)).digest('hex');
  const raw = {
    readerVersion: 'alyte.mac.poppler-layout-reader.v1',
    runtimeVersion: 'synthetic-runtime.v1',
    reportSha256,
    sourceTextConstruction: 'poppler-word-lines.v1',
    sourceOffsetKind: 'synthetic-page-text-utf16',
    pages: [structuredPage(), unstructuredPage()].map((page) => ({
      ...page,
      result: { observations: page.observations },
    })),
  };
  const rawText = `${JSON.stringify(raw)}\n`;
  writeFileSync(snapshotPath, rawText, { mode: 0o600 });
  const snapshotSha256 = createHash('sha256').update(rawText, 'utf8').digest('hex');
  const identity = {
    reportSha256,
    readerVersion: raw.readerVersion,
    runtimeVersion: raw.runtimeVersion,
    readerBinarySha256: '1'.repeat(64),
    readerSourceSha256: '2'.repeat(64),
  };
  writeFileSync(
    bindingPath,
    JSON.stringify({
      schemaVersion: 'alyte.import-eval.raw-snapshot-binding.v1',
      ...identity,
      snapshotSha256,
    }),
    { mode: 0o600 },
  );
  const result = await runRoutedHeaderTable({
    reportPath,
    reportId: 'synthetic',
    snapshotPath,
    bindingPath,
    outputPath,
    privateRoot: root,
    bindingModule: {
      verifyRawSnapshotBinding(rawValue, bindingValue, expected) {
        assert.equal(rawValue, rawText);
        assert.deepEqual(expected, identity);
        assert.equal((bindingValue as { snapshotSha256: string }).snapshotSha256, snapshotSha256);
        return JSON.parse(rawValue) as typeof raw;
      },
    },
  });
  assert.deepEqual(result.deferredPageIndexes, [1]);
  assert.equal(result.routes[0]?.kind, 'structured-text-table');
  assert.equal(result.routes[1]?.reason, 'mixed-or-unknown-provenance');
  assert.equal(result.pipeline.measurements.length, 1);
  assert.equal(result.pipeline.pipeline.configuration.deferredPageCount, 1);
  assert.deepEqual(result.pipeline.pipeline.configuration.routeReasonCounts, {
    'bound-selectable-text-source': 1,
    'mixed-or-unknown-provenance': 1,
  });
  assert.equal(statSync(outputPath).mode & 0o777, 0o600);
});

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';

import { forceVisionPages } from './alyte-service-baseline';

function syntheticTextPdf(): Buffer {
  const stream = 'BT /F1 24 Tf 72 700 Td (SYNTHETIC LDL 118 mg/dL) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(Buffer.byteLength(pdf, 'latin1'));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = Buffer.byteLength(pdf, 'latin1');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf, 'latin1');
}

test('vision geometry experiment routes every page through Vision and keeps page geometry', () => {
  const reader = {
    readerVersion: 'synthetic-pdfkit-reader.v1',
    reportSha256: '0'.repeat(64),
    runtimeVersion: 'synthetic-runtime.v1',
    pageCount: 2,
    pages: [
      {
        pageIndex: 0,
        width: 612,
        height: 792,
        result: {
          contractVersion: 'synthetic-pdf-text.v1',
          observations: [],
        },
      },
      {
        pageIndex: 1,
        width: 595,
        height: 842,
        result: null,
      },
    ],
  } as const;

  const routed = forceVisionPages(reader);

  assert.notEqual(routed, reader);
  assert.equal(routed.pageCount, reader.pageCount);
  assert.deepEqual(
    routed.pages.map(({ pageIndex, width, height, result }) => ({
      pageIndex,
      width,
      height,
      result,
    })),
    [
      { pageIndex: 0, width: 612, height: 792, result: null },
      { pageIndex: 1, width: 595, height: 842, result: null },
    ],
  );
  assert.notEqual(reader.pages[0]?.result, null);
});

const nativeSmokeTest =
  process.platform === 'darwin' && existsSync('/usr/bin/swiftc') ? test : test.skip;

nativeSmokeTest('mac Vision reader emits boxed observations for a synthetic text page', () => {
  const root = mkdtempSync(join(tmpdir(), 'alyte-vision-smoke-'));
  try {
    const report = join(root, 'synthetic.pdf');
    const output = join(root, 'vision.json');
    const binary = join(root, 'vision-reader');
    const moduleCache = join(root, 'module-cache');
    const scriptDir = resolve(dirname(new URL(import.meta.url).pathname));
    const reportBytes = syntheticTextPdf();
    writeFileSync(report, reportBytes, { mode: 0o600 });
    execFileSync(
      '/usr/bin/swiftc',
      [
        '-module-cache-path',
        moduleCache,
        join(scriptDir, 'alyte-mac-vision-reader.swift'),
        resolve(
          scriptDir,
          '../../apps/mobile/modules/alyte-vision/ios/AlyteVisionObservation.swift',
        ),
        '-o',
        binary,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'], timeout: 30_000 },
    );
    execFileSync(
      binary,
      ['--input', report, '--output', output, '--runtime-version', 'synthetic-runtime.v1'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 30_000,
      },
    );
    const result = JSON.parse(readFileSync(output, 'utf8')) as {
      pageCount: number;
      readerVersion: string;
      reportSha256: string;
      runtimeVersion: string;
      pages: readonly [
        {
          pageIndex: number;
          width: number;
          height: number;
          result: {
            observations: readonly [{ pageIndex: number; boundingBox: Record<string, number> }];
          } | null;
        },
      ];
    };
    assert.equal(result.readerVersion, 'alyte.mac.vision-reader.v1');
    assert.equal(result.reportSha256, createHash('sha256').update(reportBytes).digest('hex'));
    assert.equal(result.runtimeVersion, 'synthetic-runtime.v1');
    assert.equal(statSync(output).mode & 0o777, 0o600);
    assert.equal(result.pageCount, 1);
    const page = result.pages[0];
    assert.equal(page.pageIndex, 0);
    assert.ok(page.width > 0 && page.height > 0);
    assert.ok(page.result !== null);
    assert.ok(page.result.observations.length > 0);
    assert.ok(page.result.observations.every((observation) => observation.pageIndex === 0));
    assert.ok(
      page.result.observations.every((observation) =>
        ['x', 'y', 'width', 'height'].every((key) => Number.isFinite(observation.boundingBox[key])),
      ),
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

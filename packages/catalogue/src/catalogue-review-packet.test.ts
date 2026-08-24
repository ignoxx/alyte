import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bundledCatalogueArtifact } from './index';
import { renderCatalogueReviewPacket } from '../scripts/catalogue-review-packet-generation';

const packetPath = resolve(process.cwd(), 'review/catalogue-review-packet.md');

const BLANK_DECISION_FIELDS = [
  '- **Human decision (leave blank; select exactly one later):** `________________` (`approve` / `revise` / `withhold`)',
  '- Qualified reviewer identity: `________________`',
  '- Reviewer qualification: `________________`',
  '- Review date (ISO 8601): `________________`',
  '- Reviewed content version: `________________` (source content version: `0.2.0`)',
  '- Reviewer notes: `________________`',
];

type PacketSection = {
  readonly heading: string;
  readonly lines: readonly string[];
};

function splitSections(
  packet: string,
  headingPattern: RegExp,
  boundaryPattern: RegExp = headingPattern,
): PacketSection[] {
  const lines = packet.split('\n');
  const starts = lines.flatMap((line, index) =>
    headingPattern.test(line) ? [{ heading: line, index }] : [],
  );
  const boundaries = lines.flatMap((line, index) =>
    boundaryPattern.test(line) ? [{ index }] : [],
  );
  return starts.map(({ heading, index }) => ({
    heading,
    lines: lines.slice(
      index,
      boundaries.find((boundary) => boundary.index > index)?.index ?? lines.length,
    ),
  }));
}

function sourceArea(section: PacketSection): string {
  const headingIndent = section.heading.match(/^\s*/)?.[0] ?? '';
  const sourceMarker = `${headingIndent}- source metadata and links:`;
  const reviewMarker = `${headingIndent}- source review metadata:`;
  const sourceStart = section.lines.indexOf(sourceMarker);
  const reviewStart = section.lines.indexOf(reviewMarker);
  assert.notEqual(sourceStart, -1, `${section.heading} is missing its source metadata block`);
  assert.notEqual(reviewStart, -1, `${section.heading} is missing its source review block`);
  assert.ok(sourceStart < reviewStart, `${section.heading} has malformed source block order`);
  return section.lines
    .slice(sourceStart + 1, reviewStart)
    .map((line) => line.trimStart())
    .join('\n');
}

function exactSourceMetadata(source: (typeof bundledCatalogueArtifact.sourceSet)[number]): string {
  return [
    `- [${source.id} — ${source.title}](${source.url})`,
    `- publisher: ${source.publisher}`,
    `- publication date: \`${source.publicationDate ?? 'null'}\``,
    `- accessed date: \`${source.accessedAt}\``,
    `- source kind: \`${source.sourceKind}\``,
    `- URL: ${source.url}`,
  ].join('\n');
}

function decisionBlocks(section: PacketSection): string[][] {
  const lines = section.lines.map((line) => line.trimStart());
  const marker = '- blank human decision fields:';
  return lines.flatMap((line, index) =>
    line === marker ? [lines.slice(index + 1, index + 7)] : [],
  );
}

function assertBlankDecisionBlock(block: readonly string[]): void {
  assert.deepEqual(block, BLANK_DECISION_FIELDS);
}

describe('qualified catalogue review packet', () => {
  it('renders deterministically when artifact collection order changes', () => {
    const first = renderCatalogueReviewPacket(bundledCatalogueArtifact);
    const reordered = renderCatalogueReviewPacket({
      ...bundledCatalogueArtifact,
      entries: [...bundledCatalogueArtifact.entries].reverse(),
      sourceSet: [...bundledCatalogueArtifact.sourceSet].reverse(),
    });
    assert.equal(reordered, first);
  });

  it('contains every launch entry and guidance item exactly once with traceable sources', async () => {
    const packet = await readFile(packetPath, 'utf8');
    const entrySections = splitSections(packet, /^## \d+\. `[^`]+` — /, /^## /);
    const guidanceSections = splitSections(
      packet,
      /^  ### Guidance item `[^`]+`$/,
      /^(?:## |  ### |- blank human decision fields:)/,
    );
    const entryIds = entrySections.map((section) => section.heading.match(/`([^`]+)`/)?.[1]);
    const guidanceIds = guidanceSections.map((section) => section.heading.match(/`([^`]+)`/)?.[1]);
    const expectedEntryIds = bundledCatalogueArtifact.entries.map((entry) => entry.id).sort();
    const expectedGuidanceIds = bundledCatalogueArtifact.entries
      .flatMap((entry) => entry.generalGuidance ?? [])
      .map((guidance) => guidance.id)
      .sort();

    assert.deepEqual(entryIds, expectedEntryIds);
    assert.deepEqual(guidanceIds, expectedGuidanceIds);
    assert.equal(new Set(entryIds).size, 15);
    assert.equal(new Set(guidanceIds).size, expectedGuidanceIds.length);

    for (const entry of bundledCatalogueArtifact.entries) {
      const entrySection = entrySections.find((section) =>
        section.heading.includes(`\`${entry.id}\``),
      );
      assert.ok(entrySection, `${entry.id} section is missing`);
      const entrySources = bundledCatalogueArtifact.sourceSet.filter((source) =>
        (entry.sources ?? []).some((entrySource) => entrySource.id === source.id),
      );
      const entrySourceArea = sourceArea(entrySection);
      assert.equal(
        entrySourceArea.split('\n').filter((line) => line.startsWith('- [')).length,
        entrySources.length,
        `${entry.id} source link count is not local to its entry block`,
      );
      for (const source of entrySources)
        assert.ok(entrySourceArea.includes(exactSourceMetadata(source)));

      for (const guidance of entry.generalGuidance ?? []) {
        const guidanceSection = guidanceSections.find((section) =>
          section.heading.includes(`\`${guidance.id}\``),
        );
        assert.ok(guidanceSection, `${guidance.id} section is missing`);
        const guidanceSources = bundledCatalogueArtifact.sourceSet.filter((source) =>
          guidance.sources.includes(source.id),
        );
        const guidanceSourceArea = sourceArea(guidanceSection);
        assert.equal(
          guidanceSourceArea.split('\n').filter((line) => line.startsWith('- [')).length,
          guidanceSources.length,
          `${guidance.id} source link count is not local to its guidance block`,
        );
        for (const source of guidanceSources)
          assert.ok(guidanceSourceArea.includes(exactSourceMetadata(source)));
      }
    }
  });

  it('keeps every entry and guidance decision field blank and pending', async () => {
    const packet = await readFile(packetPath, 'utf8');
    const entrySections = splitSections(packet, /^## \d+\. `[^`]+` — /, /^## /);
    const guidanceSections = splitSections(
      packet,
      /^  ### Guidance item `[^`]+`$/,
      /^(?:## |  ### |- blank human decision fields:)/,
    );
    assert.equal(entrySections.length, bundledCatalogueArtifact.entries.length);
    assert.equal(
      guidanceSections.length,
      bundledCatalogueArtifact.entries.flatMap((entry) => entry.generalGuidance ?? []).length,
    );
    for (const section of entrySections) {
      const entryId = section.heading.match(/`([^`]+)`/)?.[1];
      const entry = bundledCatalogueArtifact.entries.find((candidate) => candidate.id === entryId);
      assert.ok(entry, `${section.heading} does not map to catalogue data`);
      const blocks = decisionBlocks(section);
      assert.equal(
        blocks.length,
        1 + (entry.generalGuidance?.length ?? 0),
        `${section.heading} must contain one entry block plus one block per guidance item`,
      );
      for (const block of blocks) assertBlankDecisionBlock(block);
    }
    for (const section of guidanceSections) {
      const blocks = decisionBlocks(section);
      assert.equal(blocks.length, 1, `${section.heading} must contain one decision block`);
      assertBlankDecisionBlock(blocks[0]!);
    }
    assert.equal(packet.includes('☒'), false);
    assert.equal(packet.includes('status: `approved`'), false);
    assert.doesNotMatch(packet, /source reviewer: `(?!null`)/);
    assert.match(packet, /PENDING HUMAN REVIEW — NOT APPROVED/);
    assert.match(packet, /packet status: `pending-human-review`/);
  });

  it('rejects a representative prefilled agent decision block', () => {
    const prefilled = [...BLANK_DECISION_FIELDS];
    prefilled[0] =
      '- **Human decision (leave blank; select exactly one later):** `approve` (`approve` / `revise` / `withhold`)';
    prefilled[1] = '- Qualified reviewer identity: `agent`';
    assert.throws(() => assertBlankDecisionBlock(prefilled));
  });

  it('refuses to render a packet for a publication-approved manifest', () => {
    assert.throws(
      () =>
        renderCatalogueReviewPacket({
          ...bundledCatalogueArtifact,
          manifest: { ...bundledCatalogueArtifact.manifest, status: 'approved' },
        }),
      /review-pending manifest/,
    );
  });

  it('matches the checked-in packet generated from the bundled artifact', async () => {
    const packet = await readFile(packetPath, 'utf8');
    assert.equal(packet, renderCatalogueReviewPacket(bundledCatalogueArtifact));
  });
});

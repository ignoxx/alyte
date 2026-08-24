import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { bundledCatalogueArtifact } from './index';
import { renderCatalogueReviewPacket } from '../scripts/catalogue-review-packet-generation';

const packetPath = resolve(process.cwd(), 'review/catalogue-review-packet.md');

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
    const entryIds = [...packet.matchAll(/^## \d+\. `([^`]+)` — /gm)].map((match) => match[1]);
    const guidanceIds = [...packet.matchAll(/^  ### Guidance item `([^`]+)`$/gm)].map(
      (match) => match[1],
    );
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
      for (const source of entry.sources ?? []) assert.match(packet, new RegExp(source.id));
      for (const guidance of entry.generalGuidance ?? []) {
        for (const sourceId of guidance.sources) assert.match(packet, new RegExp(sourceId));
      }
    }
  });

  it('keeps every entry and guidance decision field blank and pending', async () => {
    const packet = await readFile(packetPath, 'utf8');
    const itemCount = bundledCatalogueArtifact.entries.reduce(
      (count, entry) => count + 1 + (entry.generalGuidance?.length ?? 0),
      0,
    );
    const decisions =
      packet.match(/\*\*Human decision \(leave blank; select exactly one later\):\*\*/g) ?? [];

    assert.equal(decisions.length, itemCount);
    assert.equal(packet.includes('☒'), false);
    assert.equal(packet.includes('status: `approved`'), false);
    assert.doesNotMatch(packet, /source reviewer: `(?!null`)/);
    assert.match(packet, /PENDING HUMAN REVIEW — NOT APPROVED/);
    assert.match(packet, /packet status: `pending-human-review`/);
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

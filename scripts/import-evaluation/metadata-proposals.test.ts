import assert from 'node:assert/strict';
import test from 'node:test';
import { proposeCollectionDateMetadata, type MetadataObservation } from './metadata-proposals';

function observation(
  id: string,
  text: string,
  x: number,
  y = 0.1,
  overrides: Partial<MetadataObservation> = {},
): MetadataObservation {
  return {
    id,
    text,
    pageIndex: 0,
    boundingBox: { x, y, width: 0.2, height: 0.04 },
    locale: 'en-US',
    ...overrides,
  };
}

test('accepts one explicit inline page date with exact source spans', () => {
  const result = proposeCollectionDateMetadata([
    observation('header', 'Date Collected: 04/01/2025', 0.1),
  ]);
  const proposal = result.proposals[0];
  assert.equal(proposal?.reason, 'accepted');
  assert.deepEqual(proposal?.state, { kind: 'known', value: '2025-04-01' });
  assert.equal(proposal?.scope.kind, 'page');
  assert.equal(proposal?.rawDate.observationId, 'header');
  assert.equal(proposal?.collectionLabel?.observationId, 'header');
  assert.equal(proposal?.rawDate.text, '04/01/2025');
  assert.equal(proposal?.collectionLabel?.text, 'Date Collected');
  assert.deepEqual(result.pageContexts, [
    {
      pageIndex: 0,
      state: { kind: 'known', value: '2025-04-01' },
      proposalIds: ['collection-date:0:header:16'],
      reason: 'unique-page-date-pair',
    },
  ]);
});

test('keeps an explicit collection date in a body row at visual-row scope', () => {
  const result = proposeCollectionDateMetadata([
    observation('body', 'Date Collected: 04/01/2025', 0.1, 0.4),
  ]);
  assert.equal(result.proposals[0]?.reason, 'accepted');
  assert.equal(result.proposals[0]?.scope.kind, 'visual-row');
  assert.equal(result.pageContexts[0]?.reason, 'no-page-date-pair');
});

test('pairs separate header observations only when their geometry shares a row', () => {
  const result = proposeCollectionDateMetadata([
    observation('label', 'Date Collected', 0.1),
    observation('date', '04/01/2025', 0.4),
  ]);
  assert.equal(result.proposals[0]?.reason, 'accepted');
  assert.equal(result.proposals[0]?.collectionLabel?.observationId, 'label');
  assert.equal(result.proposals[0]?.scope.kind, 'page');
});

test('does not treat a bare sample or specimen label as collection-date ownership', () => {
  const result = proposeCollectionDateMetadata([
    observation('sample', 'Sample: 04/01/2025', 0.1),
    observation('specimen', 'Specimen 05/01/2025', 0.1, 0.3),
  ]);
  assert.equal(
    result.proposals.every((proposal) => proposal.reason !== 'accepted'),
    true,
  );
  assert.equal(result.pageContexts[0]?.state.kind, 'missing');
});

test('does not let repeated unlabeled dates borrow the page label', () => {
  const result = proposeCollectionDateMetadata([
    observation('header', 'Date Collected: 04/01/2025', 0.1),
    observation('administrative-date', '05/01/2025', 0.7, 0.3),
  ]);
  assert.equal(result.proposals.filter((proposal) => proposal.reason === 'accepted').length, 1);
  assert.equal(result.proposals[1]?.reason, 'no-explicit-collection-label');
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'known', value: '2025-04-01' });
  assert.equal(result.pageContexts[0]?.reason, 'unique-page-date-pair');
});

test('ignores received and issued footer dates when an explicit collection date is present', () => {
  const result = proposeCollectionDateMetadata([
    observation(
      'footer',
      'Date Collected: 04/01/2025 Date Received: 04/02/2025 Issued: 04/03/2025',
      0.1,
      0.9,
    ),
  ]);
  assert.equal(result.proposals.filter((proposal) => proposal.reason === 'accepted').length, 1);
  assert.equal(
    result.proposals.filter((proposal) => proposal.reason === 'non-collection-date').length,
    2,
  );
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'known', value: '2025-04-01' });
});

test('does not let an unlabeled body date block a unique page collection date', () => {
  const result = proposeCollectionDateMetadata([
    observation('header', 'Date Collected: 04/01/2025', 0.1),
    observation('body-date', '05/01/2025', 0.1, 0.4),
  ]);
  assert.equal(result.proposals.filter((proposal) => proposal.reason === 'accepted').length, 1);
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'known', value: '2025-04-01' });
  assert.equal(result.pageContexts[0]?.reason, 'unique-page-date-pair');
});

test('keeps two same-page events ambiguous without a table or event scope', () => {
  const result = proposeCollectionDateMetadata([
    observation('event-one', 'Date Collected: 04/01/2025', 0.1, 0.1),
    observation('event-two', 'Date Collected: 05/01/2025', 0.1, 0.3),
  ]);
  assert.equal(result.proposals.filter((proposal) => proposal.reason === 'accepted').length, 2);
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'missing' });
  assert.equal(result.pageContexts[0]?.reason, 'ambiguous-page-date-pairs');
});

test('ignores a nearby non-collection date while retaining the explicit collection date', () => {
  const result = proposeCollectionDateMetadata([
    observation('header', 'Date Collected: 04/01/2025 Date of Birth: 01/02/1990', 0.1),
  ]);
  assert.equal(result.proposals.filter((proposal) => proposal.reason === 'accepted').length, 1);
  assert.equal(
    result.proposals.filter((proposal) => proposal.reason === 'non-collection-date').length,
    1,
  );
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'known', value: '2025-04-01' });
});

test('keeps a numeric date missing when its locale is not source-attributed', () => {
  const result = proposeCollectionDateMetadata([
    observation('ambiguous-locale', 'Date Collected: 04/01/2025', 0.1, 0.1, { locale: null }),
  ]);
  assert.equal(result.proposals[0]?.reason, 'ambiguous-date-locale');
  assert.deepEqual(result.proposals[0]?.state, { kind: 'missing' });
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'missing' });
});

test('uses table-row scope for an explicit collection date in a table row', () => {
  const structure = {
    kind: 'table-cell',
    tableId: 'table-a',
    rowIndex: 3,
    columnIndex: 0,
  } as const;
  const result = proposeCollectionDateMetadata([
    observation('label', 'Collection Date', 0.1, 0.5, { structure }),
    observation('date', '2026-08-22', 0.4, 0.5, {
      structure: { ...structure, columnIndex: 1 },
    }),
  ]);
  assert.equal(result.proposals[0]?.reason, 'accepted');
  assert.deepEqual(result.proposals[0]?.scope, {
    kind: 'table-row',
    key: 'page:0:table:table-a:row:3',
  });
  assert.equal(result.pageContexts[0]?.reason, 'no-page-date-pair');
});

test('does not cross a geometry gap to attach a collection label', () => {
  const result = proposeCollectionDateMetadata([
    observation('date', '2026-08-22', 0.8, 0.5),
    observation('far-label', 'Date Collected', 0.1, 0.5),
  ]);
  assert.equal(result.proposals[0]?.reason, 'no-explicit-collection-label');
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'missing' });
});

test('does not pair adjacent small-font rows despite the old absolute gap tolerance', () => {
  const height = 0.008;
  const result = proposeCollectionDateMetadata([
    observation('row-one-label', 'Date Collected', 0.1, 0.4, {
      boundingBox: { x: 0.1, y: 0.4, width: 0.2, height },
    }),
    observation('row-two-date', '04/01/2025', 0.4, 0.4112, {
      boundingBox: { x: 0.4, y: 0.4112, width: 0.2, height },
    }),
  ]);
  assert.equal(result.proposals[0]?.reason, 'no-explicit-collection-label');
});

test('preserves a missing state when the label has no date token', () => {
  const result = proposeCollectionDateMetadata([observation('missing', 'Date Collected', 0.1)]);
  assert.deepEqual(result.proposals, []);
  assert.deepEqual(result.pageContexts[0]?.state, { kind: 'missing' });
  assert.equal(result.pageContexts[0]?.reason, 'no-page-date-pair');
});

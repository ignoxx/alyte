import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { canonicalJson, exportTextOutputs, tableCsv, type ExportSnapshot } from './export-contract';

const snapshot: ExportSnapshot = {
  schemaVersion: 10,
  tables: [
    {
      name: 'lab_records',
      columns: ['id', 'collection_date', 'notes'],
      rows: [
        { id: 'record-2', collection_date: null, notes: '=SUM(A1:A2)' },
        { id: 'record-1', collection_date: '2026-08-20', notes: 'line 1\nline "two"' },
      ],
    },
    {
      name: 'measurements',
      columns: ['id', 'original_value_json', 'current_value_json'],
      rows: [
        {
          id: 'measurement-1',
          original_value_json: '{"value":{"kind":"bounded","comparator":"<","value":5}}',
          current_value_json: null,
        },
      ],
    },
  ],
};

describe('local export serialization', () => {
  test('canonical JSON is stable and preserves SQL nulls', () => {
    assert.equal(canonicalJson({ z: 1, a: null }), '{"a":null,"z":1}\n');
    const outputs = exportTextOutputs(snapshot);
    const json = outputs.find((output) => output.path === 'data/lab-records.json');
    assert.ok(json);
    assert.match(json.content, /null/);
    assert.match(json.content, /=SUM/);
  });

  test('CSV has fixed columns, LF, quote escaping, explicit null, and formula neutralization', () => {
    const table = snapshot.tables[0]!;
    const csv = tableCsv(table);
    assert.equal(csv.split('\r').length, 1);
    assert.match(csv, /,NULL,/);
    assert.match(csv, /"'=SUM\(A1:A2\)"/);
    assert.match(csv, /"line 1\nline ""two"""/);
  });

  test('CSV neutralizes a formula after leading whitespace without changing JSON', () => {
    const table = {
      name: 'intake_events' as const,
      columns: ['notes'],
      rows: [{ notes: ' \uFEFF+1+1' }],
    };
    assert.equal(tableCsv(table), '"notes"\n" \uFEFF\'+1+1"\n');
  });

  test('exports distinct source and corrected measurement snapshots with correction provenance', () => {
    const correctedSnapshot: ExportSnapshot = {
      schemaVersion: 14,
      tables: [
        {
          name: 'measurements',
          columns: [
            'id',
            'original_label',
            'original_value_json',
            'current_label',
            'current_value_json',
            'provenance',
          ],
          rows: [
            {
              id: 'measurement-corrected-extraction',
              original_label: 'Synthetic source label',
              original_value_json: '{"kind":"free_text","value":"100 118"}',
              current_label: 'Synthetic corrected label',
              current_value_json: '{"kind":"numeric","value":118}',
              provenance: 'user-corrected',
            },
          ],
        },
      ],
    };

    const outputs = exportTextOutputs(correctedSnapshot);
    const json = outputs.find((output) => output.path === 'data/measurements.json');
    const csv = outputs.find((output) => output.path === 'csv/measurements.csv');
    assert.ok(json);
    assert.ok(csv);
    assert.match(json.content, /Synthetic source label/);
    assert.match(json.content, /Synthetic corrected label/);
    assert.match(json.content, /user-corrected/);
    assert.match(csv.content, /Synthetic source label/);
    assert.match(csv.content, /Synthetic corrected label/);
    assert.match(csv.content, /user-corrected/);
  });
});

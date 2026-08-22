import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProtectedIntakeMediaStore } from './media-store';

test('Intake media cleanup is restricted to owned protected paths', async () => {
  const files = new Set(['file:///sandbox/alyte-protected/intake-media/photo.jpg']);
  const store = createProtectedIntakeMediaStore({
    async remove(path) {
      files.delete(path);
    },
    async exists(path) {
      return files.has(path);
    },
  });

  await store.remove('file:///sandbox/alyte-protected/intake-media/photo.jpg');
  assert.equal(
    await store.verifyRemoved('file:///sandbox/alyte-protected/intake-media/photo.jpg'),
    true,
  );
  await assert.rejects(
    store.remove('file:///sandbox/alyte-protected/intake-media/../original-reports/report.pdf'),
    /owned Intake Image/,
  );
  await assert.rejects(store.remove('file:///sandbox/other/photo.jpg'), /owned Intake Image/);
});

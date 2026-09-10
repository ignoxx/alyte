import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createHomeLayoutPreferenceController,
  decodeHomeLayout,
  HOME_LAYOUT_PREFERENCE,
  type HomeLayoutPreferenceSource,
} from './home-layout-preference';

function sourceWith(
  values: Map<string, string>,
  overrides: Partial<HomeLayoutPreferenceSource> = {},
) {
  return {
    getLocalPreference: async (key: string) => values.get(key) ?? null,
    setLocalPreference: async (key: string, value: string) => {
      values.set(key, value);
    },
    ...overrides,
  } satisfies HomeLayoutPreferenceSource;
}

test('missing and invalid Home layout preferences default to masonry', () => {
  assert.equal(decodeHomeLayout(null), 'masonry');
  assert.equal(decodeHomeLayout(undefined), 'masonry');
  assert.equal(decodeHomeLayout('grid'), 'masonry');
  assert.equal(decodeHomeLayout('masonry'), 'masonry');
  assert.equal(decodeHomeLayout('list'), 'list');
});

test('Home layout loads the saved choice and writes the stable preference key', async () => {
  const values = new Map([[HOME_LAYOUT_PREFERENCE, 'list']]);
  const controller = createHomeLayoutPreferenceController(sourceWith(values));

  await controller.load();
  assert.deepEqual(controller.getSnapshot(), {
    layout: 'list',
    loading: false,
    saving: false,
    error: null,
  });

  await controller.setLayout('masonry');
  assert.equal(values.get(HOME_LAYOUT_PREFERENCE), 'masonry');
  assert.equal(controller.getSnapshot().layout, 'masonry');

  const reopened = createHomeLayoutPreferenceController(sourceWith(values));
  await reopened.load();
  assert.equal(reopened.getSnapshot().layout, 'masonry');
});

test('a failed read is visible and does not masquerade as a saved preference', async () => {
  let shouldFail = true;
  const controller = createHomeLayoutPreferenceController(
    sourceWith(new Map(), {
      getLocalPreference: async () => {
        if (!shouldFail) return 'list';
        throw new Error('storage unavailable');
      },
    }),
  );

  await controller.load();
  assert.deepEqual(controller.getSnapshot(), {
    layout: 'masonry',
    loading: false,
    saving: false,
    error: 'read-failed',
  });

  shouldFail = false;
  await controller.retry();
  assert.deepEqual(controller.getSnapshot(), {
    layout: 'list',
    loading: false,
    saving: false,
    error: null,
  });
});

test('a failed write preserves the previous choice and concurrent callers share one save', async () => {
  let releaseWrite!: () => void;
  const writeFinished = new Promise<void>((resolve) => {
    releaseWrite = resolve;
  });
  const values = new Map([[HOME_LAYOUT_PREFERENCE, 'masonry']]);
  const controller = createHomeLayoutPreferenceController(
    sourceWith(values, {
      setLocalPreference: async () => {
        await writeFinished;
        throw new Error('storage unavailable');
      },
    }),
  );
  await controller.load();

  const first = controller.setLayout('list');
  const second = controller.setLayout('masonry');
  assert.equal(controller.getSnapshot().layout, 'masonry');
  assert.equal(controller.getSnapshot().saving, true);
  releaseWrite();
  await Promise.all([first, second]);

  assert.deepEqual(controller.getSnapshot(), {
    layout: 'masonry',
    loading: false,
    saving: false,
    error: 'write-failed',
  });
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import type * as ImagePickerTypes from 'expo-image-picker';
import { createSystemLabSourcePicker, LabSourceSelectionError } from './pickers';

test('Photos picker requests one image and returns one source', async () => {
  let receivedOptions: ImagePickerTypes.ImagePickerOptions | null = null;
  const picker = createSystemLabSourcePicker({
    imagePicker: {
      launchImageLibraryAsync: async (options: ImagePickerTypes.ImagePickerOptions) => {
        receivedOptions = options;
        return {
          canceled: false,
          assets: [
            {
              uri: 'file:///synthetic/report-page.jpg',
              fileName: 'report-page.jpg',
              mimeType: 'image/jpeg',
              fileSize: 128,
              width: 1200,
              height: 900,
            },
          ],
        } as ImagePickerTypes.ImagePickerResult;
      },
    } as unknown as typeof ImagePickerTypes,
  });

  const selected = await picker.pickImages();
  assert.equal(
    (receivedOptions as unknown as { allowsMultipleSelection?: boolean } | null)
      ?.allowsMultipleSelection,
    false,
  );
  assert.deepEqual(selected, {
    uri: 'file:///synthetic/report-page.jpg',
    name: 'report-page.jpg',
    mimeType: 'image/jpeg',
    sourceType: 'image',
    byteSize: 128,
    width: 1200,
    height: 900,
  });
});

test('Photos picker cancellation returns no source', async () => {
  const picker = createSystemLabSourcePicker({
    imagePicker: {
      launchImageLibraryAsync: async () =>
        ({ canceled: true, assets: null }) as unknown as ImagePickerTypes.ImagePickerResult,
    } as unknown as typeof ImagePickerTypes,
  });

  assert.equal(await picker.pickImages(), null);
});

test('Photos picker rejects an adapter response containing multiple assets', async () => {
  const picker = createSystemLabSourcePicker({
    imagePicker: {
      launchImageLibraryAsync: async () =>
        ({
          canceled: false,
          assets: [{ uri: 'file:///synthetic/one.jpg' }, { uri: 'file:///synthetic/two.jpg' }],
        }) as unknown as ImagePickerTypes.ImagePickerResult,
    } as unknown as typeof ImagePickerTypes,
  });

  await assert.rejects(picker.pickImages(), (error: unknown) => {
    assert.ok(error instanceof LabSourceSelectionError);
    assert.equal(error.reason, 'multiple-images');
    return true;
  });
});

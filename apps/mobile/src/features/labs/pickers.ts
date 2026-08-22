import type * as DocumentPickerTypes from 'expo-document-picker';
import type * as ImagePickerTypes from 'expo-image-picker';
import type { LabSourceSelection } from './file-service';

export interface LabSourcePicker {
  pickPdf(): Promise<LabSourceSelection | null>;
  pickImages(): Promise<readonly LabSourceSelection[]>;
}

export type LabSourcePickerOptions = {
  readonly documentPicker?: typeof DocumentPickerTypes;
  readonly imagePicker?: typeof ImagePickerTypes;
};

export function createSystemLabSourcePicker(options: LabSourcePickerOptions = {}): LabSourcePicker {
  let documentPickerPromise: Promise<typeof DocumentPickerTypes> | null = options.documentPicker
    ? Promise.resolve(options.documentPicker)
    : null;
  let imagePickerPromise: Promise<typeof ImagePickerTypes> | null = options.imagePicker
    ? Promise.resolve(options.imagePicker)
    : null;

  async function pickPdf(): Promise<LabSourceSelection | null> {
    documentPickerPromise ??= import('expo-document-picker');
    const documentPicker = await documentPickerPromise;
    const result = await documentPicker.getDocumentAsync({
      type: 'application/pdf',
      multiple: false,
      copyToCacheDirectory: false,
    });
    if (result.canceled || result.assets.length === 0) return null;
    const asset = result.assets[0];
    if (asset === undefined) return null;
    return {
      uri: asset.uri,
      name: asset.name,
      mimeType: asset.mimeType ?? 'application/pdf',
      sourceType: 'pdf',
      byteSize: asset.size ?? null,
    };
  }

  async function pickImages(): Promise<readonly LabSourceSelection[]> {
    imagePickerPromise ??= import('expo-image-picker');
    const imagePicker = await imagePickerPromise;
    const result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: true,
      quality: 1,
    });
    if (result.canceled) return [];
    return result.assets.map((asset, index) => ({
      uri: asset.uri,
      name: asset.fileName ?? `lab-report-image-${index + 1}.jpg`,
      mimeType: asset.mimeType ?? 'image/jpeg',
      sourceType: 'image' as const,
      byteSize: asset.fileSize ?? null,
      width: asset.width,
      height: asset.height,
    }));
  }

  return { pickPdf, pickImages };
}

import type * as DocumentPickerTypes from 'expo-document-picker';
import type * as ImagePickerTypes from 'expo-image-picker';
import type { LabSourceSelection } from './file-service';

export class LabSourceSelectionError extends Error {
  override readonly name = 'LabSourceSelectionError';
  readonly reason: 'multiple-images' | 'invalid-image';

  constructor(reason: LabSourceSelectionError['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

export interface LabSourcePicker {
  pickPdf(): Promise<LabSourceSelection | null>;
  /** Photos import is intentionally one image per Lab Report until ordered page provenance exists. */
  pickImages(): Promise<LabSourceSelection | null>;
}

export type LabSourcePickerOptions = {
  readonly documentPicker?: typeof DocumentPickerTypes;
  readonly imagePicker?: typeof ImagePickerTypes;
};

const SUPPORTED_STILL_IMAGE_MIME_TYPES = new Set([
  'image/heic',
  'image/heif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/webp',
]);
const SUPPORTED_STILL_IMAGE_EXTENSIONS = new Set([
  '.heic',
  '.heif',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
]);

function isSupportedStillImageAsset(value: unknown): value is ImagePickerTypes.ImagePickerAsset {
  if (value === null || typeof value !== 'object') return false;
  const asset = value as Partial<ImagePickerTypes.ImagePickerAsset>;
  if (typeof asset.uri !== 'string' || asset.uri.length === 0) return false;
  if (asset.type !== undefined && asset.type !== null && asset.type !== 'image') return false;
  // A live photo has an image-shaped primary asset but also carries a paired video. It is not a
  // still source and must not be persisted as one by assuming the URI is an image.
  if (asset.pairedVideoAsset !== undefined && asset.pairedVideoAsset !== null) return false;

  const mimeType =
    typeof asset.mimeType === 'string'
      ? (asset.mimeType.toLowerCase().split(';', 1)[0] ?? null)
      : null;
  if (mimeType !== null && !SUPPORTED_STILL_IMAGE_MIME_TYPES.has(mimeType)) return false;
  const fileName = typeof asset.fileName === 'string' ? asset.fileName.toLowerCase() : '';
  const extension = fileName.match(/\.[a-z0-9]{1,8}$/)?.[0] ?? null;
  if (extension !== null && !SUPPORTED_STILL_IMAGE_EXTENSIONS.has(extension)) return false;
  return mimeType !== null || extension !== null || asset.type === 'image';
}

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

  async function pickImages(): Promise<LabSourceSelection | null> {
    imagePickerPromise ??= import('expo-image-picker');
    const imagePicker = await imagePickerPromise;
    const result = await imagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      allowsMultipleSelection: false,
      quality: 1,
    });
    if (result.canceled) return null;
    if (!Array.isArray(result.assets) || result.assets.length === 0) return null;
    if (result.assets.length !== 1) {
      throw new LabSourceSelectionError(
        'multiple-images',
        'Choose one report image at a time; each image becomes one Lab Report',
      );
    }
    const asset = result.assets[0];
    if (!isSupportedStillImageAsset(asset)) {
      throw new LabSourceSelectionError('invalid-image', 'The selected item is not a report image');
    }
    return {
      uri: asset.uri,
      name: asset.fileName ?? 'lab-report-image.jpg',
      mimeType: asset.mimeType ?? 'image/jpeg',
      sourceType: 'image' as const,
      byteSize: asset.fileSize ?? null,
      width: asset.width,
      height: asset.height,
    };
  }

  return { pickPdf, pickImages };
}

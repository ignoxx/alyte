import type * as ImagePicker from 'expo-image-picker';

export type CameraCaptureResult =
  | { readonly kind: 'permission-denied' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'captured'; readonly asset: ImagePicker.ImagePickerAsset };

/** One picker launch owns one durable identity, including repeated native callbacks. */
export function createCaptureAttemptId(
  generate: () => string = () => `snap-${Date.now()}-${Math.random().toString(36).slice(2)}`,
): { get(): string; reset(): void } {
  let current: string | null = null;
  return {
    get() {
      current ??= generate();
      return current;
    },
    reset() {
      current = null;
    },
  };
}

/**
 * Keeps permission and picker outcomes deterministic at the feature boundary. The screen owns
 * copy/navigation; tests and a future native picker adapter can exercise denial without a device.
 */
export async function captureFromCamera(
  requestPermission: () => Promise<{ readonly granted: boolean }>,
  launchCamera: () => Promise<ImagePicker.ImagePickerResult>,
): Promise<CameraCaptureResult> {
  const permission = await requestPermission();
  if (!permission.granted) return { kind: 'permission-denied' };
  const result = await launchCamera();
  if (result.canceled || result.assets[0] === undefined) return { kind: 'cancelled' };
  return { kind: 'captured', asset: result.assets[0] };
}

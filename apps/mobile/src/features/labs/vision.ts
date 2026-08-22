import { decodeVisionOCRResult, type VisionOCRResult } from '@alyte/domain';

type NativeVisionModule = {
  recognize(
    path: string,
    pageIndex: number,
    orientation: number,
    password: string | null,
  ): Promise<unknown>;
};

export interface VisionOCR {
  recognize(
    path: string,
    pageIndex: number,
    orientation: number,
    password?: string | null,
  ): Promise<VisionOCRResult>;
}

export const nativeVisionOCR: VisionOCR = {
  async recognize(path, pageIndex, orientation, password = null) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeVisionModule>('AlyteVision');
    if (native === null) throw new Error('AlyteVision is unavailable for local report extraction');
    // Decode at the adapter boundary: native results are untrusted, even though the module is
    // local. No OCR text is logged when decoding fails.
    return decodeVisionOCRResult(await native.recognize(path, pageIndex, orientation, password));
  },
};

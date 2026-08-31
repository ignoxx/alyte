import { decodeVisionOCRResult, type VisionOCRResult } from '@alyte/domain';

export type NativeVisionBoundingBox = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

/** Exact source text span emitted by the iOS 26 Vision document request. */
export type NativeVisionTokenSpan = {
  readonly id: string;
  readonly parentObservationId: string;
  /** Inclusive UTF-16 code-unit offset into the parent observation text. */
  readonly start: number;
  /** Exclusive UTF-16 code-unit offset into the parent observation text. */
  readonly end: number;
  readonly text: string;
  readonly boundingBox: NativeVisionBoundingBox;
};

/** Native v4 observation shape; the parent remains complete when spans are omitted. */
export type NativeVisionObservation = {
  readonly id: string;
  readonly text: string;
  readonly alternatives: readonly string[];
  readonly boundingBox: NativeVisionBoundingBox;
  readonly pageIndex: number;
  readonly orientation: number;
  readonly structure?: {
    readonly kind: 'text' | 'table-cell';
    readonly tableId: string | null;
    readonly rowIndex: number | null;
    readonly columnIndex: number | null;
  };
  readonly recognition: {
    readonly level: 'fast' | 'accurate';
    readonly language: string | null;
    readonly internalConfidence: number | null;
  };
  readonly spans?: readonly NativeVisionTokenSpan[];
};

type NativeVisionModule = {
  recognize(
    path: string,
    pageIndex: number,
    orientation: number,
    password: string | null,
  ): Promise<{
    readonly contractVersion:
      'alyte.vision.document.v2' | 'alyte.vision.document.v3' | 'alyte.vision.document.v4';
    readonly pageIndex: number;
    readonly orientation: number;
    readonly observations: readonly NativeVisionObservation[];
  }>;
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

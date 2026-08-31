import {
  decodeVisionOCRResult,
  PDF_TEXT_LAYER_ADAPTER_VERSION,
  VISION_OCR_CONTRACT_VERSION,
  type VisionOCRResult,
} from '@alyte/domain';
import type { SanitizationRecipe, SensitiveRegionSuggestion } from '@alyte/domain';

export const PDF_TEXT_LAYER_CONTRACT_VERSION = PDF_TEXT_LAYER_ADAPTER_VERSION;

export type PdfTextLayerPageResult = VisionOCRResult | null;

export type PdfPageInspection = {
  readonly pageIndex: number;
  readonly width: number;
  readonly height: number;
  readonly hasTextLayer: boolean;
};

export type PdfInspection = {
  readonly encrypted: boolean;
  readonly locked: boolean;
  readonly pageCount: number;
  readonly metadata: Readonly<Record<string, string>>;
  readonly pages: readonly PdfPageInspection[];
};

/** A native PDFKit document held by an opaque, short-lived capability. */
export interface PdfViewerSession {
  readonly pageCount: number;
  readonly sessionId: string;
  close(): Promise<void>;
}

/** Lightweight result from opening a PDF viewer; full page inspection stays on import paths. */
export type PdfViewerOpenResult =
  | { readonly locked: true; readonly pageCount: number; readonly session: null }
  | { readonly locked: false; readonly pageCount: number; readonly session: PdfViewerSession };

export interface PdfInspectionSession {
  readonly inspection: PdfInspection;
  renderPreview(): Promise<readonly string[]>;
  /** Optional because pure/test adapters may not expose PDFKit's trusted text layer. */
  readTextLayerPage?(pageIndex: number): Promise<PdfTextLayerPageResult>;
  exportUnlocked(destinationPath: string): Promise<void>;
  sanitize?(destinationPath: string, recipe: SanitizationRecipe): Promise<PdfSanitizationResult>;
  suggestSensitiveRegions?(): Promise<readonly SensitiveRegionSuggestion[]>;
  close(): Promise<void>;
}

export type PdfSanitizedVerification = {
  readonly verified: boolean;
  readonly selectableText: boolean;
  readonly annotations: boolean;
  readonly attachments: boolean;
  readonly metadata: boolean;
  readonly removableRedactions: boolean;
  readonly reloadChecked: boolean;
  readonly sourceAwareChecked: boolean;
  readonly sourceContentRemoved: boolean;
  readonly verificationVersion: string;
  readonly failureReasons: readonly string[];
};

export type PdfSanitizationResult = {
  readonly destinationPath: string;
  readonly pageCount: number;
  readonly verification?: PdfSanitizedVerification;
};

export interface PdfInspector {
  /** Declares the trusted text-layer contract even when only unlocked sessions expose a reader. */
  readonly textLayerAdapterVersion?: typeof PDF_TEXT_LAYER_ADAPTER_VERSION;
  inspect(path: string): Promise<PdfInspection>;
  unlock(path: string, password: string): Promise<PdfInspectionSession>;
  renderPreview(path: string): Promise<readonly string[]>;
  renderExtractionBand?(
    path: string,
    pageIndex: number,
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    password?: string | null,
  ): Promise<{ readonly uri: string; readonly width: number; readonly height: number }>;
  deleteExtractionBand?(uri: string): Promise<void>;
  /** Optional PDFKit text-layer source; unavailable pages return null for Vision fallback. */
  readTextLayerPage?(
    path: string,
    pageIndex: number,
    password?: string | null,
  ): Promise<PdfTextLayerPageResult>;
  /** Native-only lazy viewer operations remain optional for non-iOS test adapters. */
  openViewer?(path: string): Promise<PdfViewerOpenResult>;
  unlockViewer?(path: string, password: string): Promise<PdfViewerSession>;
  /** Native-only operations remain optional so pure import tests do not require an iOS runtime. */
  sanitize?(
    sourcePath: string,
    destinationPath: string,
    recipe: SanitizationRecipe,
  ): Promise<PdfSanitizationResult>;
  verifySanitized?(path: string): Promise<PdfSanitizedVerification>;
  suggestSensitiveRegions?(path: string): Promise<readonly SensitiveRegionSuggestion[]>;
}

type NativePdfModule = {
  inspect(path: string): Promise<PdfInspection>;
  unlock(path: string, password: string): Promise<PdfInspection & { readonly sessionId: string }>;
  openViewer(path: string): Promise<{
    readonly locked: boolean;
    readonly pageCount: number;
    readonly sessionId?: string;
  }>;
  unlockViewer(
    path: string,
    password: string,
  ): Promise<{ readonly pageCount: number; readonly sessionId: string }>;
  renderPreview(path: string): Promise<readonly string[]>;
  renderExtractionBand(
    path: string,
    pageIndex: number,
    rect: {
      readonly x: number;
      readonly y: number;
      readonly width: number;
      readonly height: number;
    },
    password: string | null,
  ): Promise<{ readonly uri: string; readonly width: number; readonly height: number }>;
  deleteExtractionBand(uri: string): Promise<void>;
  textLayerPage(path: string, pageIndex: number, password: string | null): Promise<unknown>;
  textLayerPageSession(sessionId: string, pageIndex: number): Promise<unknown>;
  renderPreviewSession(sessionId: string): Promise<readonly string[]>;
  exportUnlockedSession(sessionId: string, destinationPath: string): Promise<void>;
  close(sessionId: string): Promise<void>;
  sanitizeSession(
    sessionId: string,
    destinationPath: string,
    recipe: SanitizationRecipe,
  ): Promise<PdfSanitizationResult>;
  suggestSensitiveRegionsSession(sessionId: string): Promise<readonly SensitiveRegionSuggestion[]>;
  sanitize(
    sourcePath: string,
    destinationPath: string,
    recipe: SanitizationRecipe,
  ): Promise<PdfSanitizationResult>;
  verifySanitized(path: string): Promise<PdfSanitizedVerification>;
  suggestSensitiveRegions(path: string): Promise<readonly SensitiveRegionSuggestion[]>;
};

type UnknownRecord = Record<string, unknown>;

const PDF_TEXT_LAYER_MAXIMUM_CHARACTERS = 64 * 1024;
const PDF_TEXT_LAYER_MAXIMUM_OBSERVATIONS = 512;
const PDF_TEXT_LAYER_MAXIMUM_SPANS = 4096;
const PDF_TEXT_LAYER_MAXIMUM_ID_LENGTH = 256;
const PDF_TEXT_LAYER_MAXIMUM_ALTERNATIVE_LENGTH = 4096;
const PDF_TEXT_LAYER_MAXIMUM_LANGUAGE_LENGTH = 128;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`Invalid PDF text-layer ${field}`);
  return value;
}

function requireExactKeys(value: UnknownRecord, keys: readonly string[], field: string): void {
  const expected = new Set(keys);
  if (
    Object.keys(value).length !== expected.size ||
    Object.keys(value).some((key) => !expected.has(key)) ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(value, key))
  ) {
    throw new Error(`Invalid PDF text-layer ${field}`);
  }
}

function requireString(value: unknown, field: string, nonEmpty = true): string {
  if (typeof value !== 'string' || (nonEmpty && value.length === 0))
    throw new Error(`Invalid PDF text-layer ${field}`);
  return value;
}

function requireBoundedString(value: unknown, field: string, maximum: number): string {
  const string = requireString(value, field);
  if (string.length > maximum) throw new Error(`Invalid PDF text-layer ${field}`);
  return string;
}

function requireInteger(value: unknown, field: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum)
    throw new Error(`Invalid PDF text-layer ${field}`);
  return value;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new Error(`Invalid PDF text-layer ${field}`);
  return value;
}

function requireNormalizedBox(value: unknown, field: string): void {
  const box = requireRecord(value, `${field} bounding box`);
  requireExactKeys(box, ['x', 'y', 'width', 'height'], `${field} bounding box`);
  const x = requireFiniteNumber(box.x, `${field} bounding-box x`);
  const y = requireFiniteNumber(box.y, `${field} bounding-box y`);
  const width = requireFiniteNumber(box.width, `${field} bounding-box width`);
  const height = requireFiniteNumber(box.height, `${field} bounding-box height`);
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1 || y + height > 1)
    throw new Error(`Invalid PDF text-layer ${field} bounding box`);
}

function codePointBefore(text: string, offset: number): number | undefined {
  if (offset <= 0) return undefined;
  const previousUnit = text.charCodeAt(offset - 1);
  if (previousUnit >= 0xdc00 && previousUnit <= 0xdfff && offset >= 2)
    return text.codePointAt(offset - 2);
  return text.codePointAt(offset - 1);
}

function isUnicodeMark(codePoint: number | undefined): boolean {
  return codePoint !== undefined && /^\p{Mark}$/u.test(String.fromCodePoint(codePoint));
}

function isEmojiModifier(codePoint: number | undefined): boolean {
  return codePoint !== undefined && codePoint >= 0x1f3fb && codePoint <= 0x1f3ff;
}

function isEmojiTag(codePoint: number | undefined): boolean {
  return codePoint !== undefined && codePoint >= 0xe0020 && codePoint <= 0xe007f;
}

function isRegionalIndicator(codePoint: number | undefined): boolean {
  return codePoint !== undefined && codePoint >= 0x1f1e6 && codePoint <= 0x1f1ff;
}

/** Returns true only at a UTF-16 boundary that does not split a composed sequence. */
function isComposedBoundary(text: string, offset: number): boolean {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const previousCodeUnit = text.charCodeAt(offset - 1);
  const currentCodeUnit = text.charCodeAt(offset);
  // A high-surrogate/low-surrogate boundary splits one scalar value.
  if (
    previousCodeUnit >= 0xd800 &&
    previousCodeUnit <= 0xdbff &&
    currentCodeUnit >= 0xdc00 &&
    currentCodeUnit <= 0xdfff
  )
    return false;

  const previous = codePointBefore(text, offset);
  const current = text.codePointAt(offset);
  // Intl.Segmenter is not available in every React Native JS runtime. These are the composition
  // components that PDFKit's NSString composed-character ranges can join without an ICU bridge:
  // combining marks/variation selectors, emoji modifiers and tag sequences, ZWJ chains, and
  // adjacent regional indicators (flags).
  if (current === 0x200d || previous === 0x200d) return false;
  if (isUnicodeMark(current) || isEmojiModifier(current) || isEmojiTag(current)) return false;
  if (isRegionalIndicator(previous) && isRegionalIndicator(current)) return false;
  return true;
}

function validateVisibleSpanCoverage(text: string, spans: readonly UnknownRecord[]): void {
  for (let offset = 0; offset < text.length;) {
    const codePoint = text.codePointAt(offset);
    if (codePoint === undefined) throw new Error('Invalid PDF text-layer source text');
    const width = codePoint > 0xffff ? 2 : 1;
    const character = text.slice(offset, offset + width);
    if (!/^\s$/u.test(character)) {
      const containing = spans.filter((span) => {
        const start = span.start;
        const end = span.end;
        return (
          typeof start === 'number' &&
          typeof end === 'number' &&
          start <= offset &&
          offset + width <= end
        );
      });
      if (containing.length !== 1) throw new Error('Invalid PDF text-layer span coverage');
    }
    offset += width;
  }
}

/**
 * Strictly decodes one PDFKit text-layer page. `null` is the sole normal unavailable-page value;
 * every malformed or partial envelope throws before it can enter extraction. Trusted output is
 * intentionally converted to the existing Vision v3 result shape for unchanged downstream code.
 */
export function decodePdfTextLayerPage(
  input: unknown,
  expectedPageIndex: number,
): PdfTextLayerPageResult {
  if (!Number.isSafeInteger(expectedPageIndex) || expectedPageIndex < 0)
    throw new Error('Invalid PDF text-layer expected page index');
  if (input === null) return null;
  const envelope = requireRecord(input, 'page result');
  if (
    envelope.sourceText !== undefined ||
    Object.prototype.hasOwnProperty.call(envelope, 'sourceText')
  )
    throw new Error('PDF text-layer page must not include raw sourceText');
  requireExactKeys(
    envelope,
    ['contractVersion', 'pageIndex', 'orientation', 'observations'],
    'page result',
  );
  if (envelope.contractVersion !== PDF_TEXT_LAYER_CONTRACT_VERSION)
    throw new Error('Unsupported PDF text-layer contract version');
  if (envelope.pageIndex !== expectedPageIndex)
    throw new Error('PDF text-layer page index does not match request');
  if (envelope.orientation !== 0) throw new Error('PDF text-layer orientation must be zero');
  if (
    !Array.isArray(envelope.observations) ||
    envelope.observations.length === 0 ||
    envelope.observations.length > PDF_TEXT_LAYER_MAXIMUM_OBSERVATIONS
  )
    throw new Error('PDF text-layer observations are missing');

  const IDs = new Set<string>();
  let spansCount = 0;
  let previousSourceEnd = 0;
  const observations = envelope.observations.map((rawObservation, observationIndex) => {
    const observation = requireRecord(rawObservation, `observation ${observationIndex}`);
    requireExactKeys(
      observation,
      [
        'id',
        'text',
        'sourceStart',
        'sourceEnd',
        'alternatives',
        'boundingBox',
        'pageIndex',
        'orientation',
        'structure',
        'spans',
        'recognition',
      ],
      `observation ${observationIndex}`,
    );
    const id = requireBoundedString(
      observation.id,
      `observation ${observationIndex} id`,
      PDF_TEXT_LAYER_MAXIMUM_ID_LENGTH,
    );
    if (IDs.has(id)) throw new Error('Duplicate PDF text-layer ID');
    IDs.add(id);
    const text = requireString(observation.text, `observation ${observationIndex} text`);
    if (text.length > PDF_TEXT_LAYER_MAXIMUM_CHARACTERS || text.trim().length === 0)
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} text`);
    const sourceStart = requireInteger(
      observation.sourceStart,
      `observation ${observationIndex} source start`,
    );
    const sourceEnd = requireInteger(
      observation.sourceEnd,
      `observation ${observationIndex} source end`,
    );
    if (
      sourceStart >= sourceEnd ||
      sourceStart < previousSourceEnd ||
      sourceEnd > PDF_TEXT_LAYER_MAXIMUM_CHARACTERS ||
      sourceEnd - sourceStart !== text.length
    )
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} source range`);
    previousSourceEnd = sourceEnd;
    requireNormalizedBox(observation.boundingBox, `observation ${observationIndex}`);
    if (observation.pageIndex !== expectedPageIndex || observation.orientation !== 0)
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} page context`);

    const alternatives = observation.alternatives;
    if (
      !Array.isArray(alternatives) ||
      alternatives.length > 5 ||
      alternatives.some(
        (value) =>
          typeof value !== 'string' || value.length > PDF_TEXT_LAYER_MAXIMUM_ALTERNATIVE_LENGTH,
      )
    )
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} alternatives`);

    const structure = requireRecord(
      observation.structure,
      `observation ${observationIndex} structure`,
    );
    requireExactKeys(
      structure,
      ['kind', 'tableId', 'rowIndex', 'columnIndex'],
      `observation ${observationIndex} structure`,
    );
    if (
      structure.kind !== 'text' ||
      structure.tableId !== null ||
      structure.rowIndex !== null ||
      structure.columnIndex !== null
    )
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} structure`);

    const recognition = requireRecord(
      observation.recognition,
      `observation ${observationIndex} recognition`,
    );
    requireExactKeys(
      recognition,
      ['level', 'language', 'internalConfidence'],
      `observation ${observationIndex} recognition`,
    );
    if (
      recognition.level !== 'accurate' ||
      (recognition.language !== null &&
        (typeof recognition.language !== 'string' ||
          recognition.language.length > PDF_TEXT_LAYER_MAXIMUM_LANGUAGE_LENGTH))
    )
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} recognition`);
    if (recognition.internalConfidence !== null)
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} confidence`);

    if (
      !Array.isArray(observation.spans) ||
      observation.spans.length === 0 ||
      spansCount + observation.spans.length > PDF_TEXT_LAYER_MAXIMUM_SPANS
    )
      throw new Error(`Invalid PDF text-layer observation ${observationIndex} spans`);
    spansCount += observation.spans.length;
    const spans = observation.spans.map((rawSpan, spanIndex) => {
      const span = requireRecord(rawSpan, `observation ${observationIndex} span ${spanIndex}`);
      requireExactKeys(
        span,
        ['id', 'parentObservationId', 'start', 'end', 'text', 'boundingBox'],
        `observation ${observationIndex} span ${spanIndex}`,
      );
      const spanID = requireBoundedString(
        span.id,
        `observation ${observationIndex} span ${spanIndex} id`,
        PDF_TEXT_LAYER_MAXIMUM_ID_LENGTH,
      );
      if (IDs.has(spanID)) throw new Error('Duplicate PDF text-layer ID');
      IDs.add(spanID);
      if (span.parentObservationId !== id)
        throw new Error(`Invalid PDF text-layer span ${spanIndex} parent`);
      const start = requireInteger(
        span.start,
        `observation ${observationIndex} span ${spanIndex} start`,
      );
      const end = requireInteger(span.end, `observation ${observationIndex} span ${spanIndex} end`);
      if (
        start >= end ||
        end > text.length ||
        !isComposedBoundary(text, start) ||
        !isComposedBoundary(text, end)
      )
        throw new Error(`Invalid PDF text-layer span ${spanIndex} range`);
      if (span.text !== text.slice(start, end))
        throw new Error(`Invalid PDF text-layer span ${spanIndex} source text`);
      requireNormalizedBox(span.boundingBox, `observation ${observationIndex} span ${spanIndex}`);
      return span;
    });
    let previousSpanEnd = 0;
    for (const span of spans) {
      if ((span.start as number) < previousSpanEnd)
        throw new Error('Overlapping PDF text-layer spans');
      previousSpanEnd = span.end as number;
    }
    validateVisibleSpanCoverage(text, spans);
    return rawObservation;
  });

  return decodeVisionOCRResult({
    contractVersion: VISION_OCR_CONTRACT_VERSION,
    pageIndex: expectedPageIndex,
    orientation: 0,
    observations,
  });
}

export const nativePdfInspector: PdfInspector = {
  textLayerAdapterVersion: PDF_TEXT_LAYER_ADAPTER_VERSION,
  async inspect(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF inspection');
    return native.inspect(path);
  },
  async unlock(path, password) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF inspection');
    const result = await native.unlock(path, password);
    // The caller owns this short-lived session. The password itself never crosses this boundary
    // again and the native PDFDocument is released in close().
    return {
      inspection: result,
      renderPreview: () => native.renderPreviewSession(result.sessionId),
      readTextLayerPage: async (pageIndex) =>
        decodePdfTextLayerPage(
          await native.textLayerPageSession(result.sessionId, pageIndex),
          pageIndex,
        ),
      exportUnlocked: (destinationPath) =>
        native.exportUnlockedSession(result.sessionId, destinationPath),
      sanitize: (destinationPath, recipe) =>
        native.sanitizeSession(result.sessionId, destinationPath, recipe),
      suggestSensitiveRegions: () => native.suggestSensitiveRegionsSession(result.sessionId),
      close: () => native.close(result.sessionId),
    };
  },
  async renderPreview(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF preview');
    return native.renderPreview(path);
  },
  async renderExtractionBand(path, pageIndex, rect, password = null) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local document rendering');
    return native.renderExtractionBand(path, pageIndex, rect, password ?? null);
  },
  async deleteExtractionBand(uri) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local document cleanup');
    await native.deleteExtractionBand(uri);
  },
  async readTextLayerPage(path, pageIndex, password = null) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF text extraction');
    return decodePdfTextLayerPage(
      await native.textLayerPage(path, pageIndex, password ?? null),
      pageIndex,
    );
  },
  async openViewer(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF viewing');
    const result = await native.openViewer(path);
    if (result.locked) return { locked: true, pageCount: result.pageCount, session: null };
    if (result.sessionId === undefined) {
      throw new Error('AlytePDF did not return a viewer capability');
    }
    const sessionId = result.sessionId;
    return {
      locked: false,
      pageCount: result.pageCount,
      session: {
        pageCount: result.pageCount,
        sessionId,
        close: () => native.close(sessionId),
      },
    };
  },
  async unlockViewer(path, password) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF viewing');
    const result = await native.unlockViewer(path, password);
    return {
      pageCount: result.pageCount,
      sessionId: result.sessionId,
      close: () => native.close(result.sessionId),
    };
  },
  async sanitize(sourcePath, destinationPath, recipe) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for sanitization');
    return native.sanitize(sourcePath, destinationPath, recipe);
  },
  async verifySanitized(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for sanitization verification');
    return native.verifySanitized(path);
  },
  async suggestSensitiveRegions(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) return [];
    return native.suggestSensitiveRegions(path);
  },
};

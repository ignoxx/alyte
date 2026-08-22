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

export interface PdfInspectionSession {
  readonly inspection: PdfInspection;
  renderPreview(): Promise<readonly string[]>;
  close(): Promise<void>;
}

export type PdfSanitizedVerification = {
  readonly verified: boolean;
  readonly selectableText: boolean;
  readonly annotations: boolean;
  readonly attachments: boolean;
  readonly metadata: boolean;
  readonly removableRedactions: boolean;
  readonly recoveryChecked: boolean;
  readonly failureReasons: readonly string[];
};

export type PdfSanitizationResult = {
  readonly destinationPath: string;
  readonly pageCount: number;
};

export interface PdfInspector {
  inspect(path: string): Promise<PdfInspection>;
  unlock(path: string, password: string): Promise<PdfInspectionSession>;
  renderPreview(path: string): Promise<readonly string[]>;
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
  renderPreview(path: string): Promise<readonly string[]>;
  renderPreviewSession(sessionId: string): Promise<readonly string[]>;
  close(sessionId: string): Promise<void>;
  sanitize(
    sourcePath: string,
    destinationPath: string,
    recipe: SanitizationRecipe,
  ): Promise<PdfSanitizationResult>;
  verifySanitized(path: string): Promise<PdfSanitizedVerification>;
  suggestSensitiveRegions(path: string): Promise<readonly SensitiveRegionSuggestion[]>;
};

export const nativePdfInspector: PdfInspector = {
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
      close: () => native.close(result.sessionId),
    };
  },
  async renderPreview(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF preview');
    return native.renderPreview(path);
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
import type { SanitizationRecipe, SensitiveRegionSuggestion } from '@alyte/domain';

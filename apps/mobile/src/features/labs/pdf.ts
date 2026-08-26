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
  readonly inspection: PdfInspection;
  readonly sessionId: string;
  close(): Promise<void>;
}

export interface PdfInspectionSession {
  readonly inspection: PdfInspection;
  renderPreview(): Promise<readonly string[]>;
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
  inspect(path: string): Promise<PdfInspection>;
  unlock(path: string, password: string): Promise<PdfInspectionSession>;
  renderPreview(path: string): Promise<readonly string[]>;
  /** Native-only lazy viewer operations remain optional for non-iOS test adapters. */
  openViewer?(path: string): Promise<PdfViewerSession>;
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
  openViewer(path: string): Promise<PdfInspection & { readonly sessionId: string }>;
  unlockViewer(
    path: string,
    password: string,
  ): Promise<PdfInspection & { readonly sessionId: string }>;
  renderPreview(path: string): Promise<readonly string[]>;
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
  async openViewer(path) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF viewing');
    const result = await native.openViewer(path);
    return {
      inspection: result,
      sessionId: result.sessionId,
      close: () => native.close(result.sessionId),
    };
  },
  async unlockViewer(path, password) {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativePdfModule>('AlytePDF');
    if (native === null) throw new Error('AlytePDF is unavailable for local PDF viewing');
    const result = await native.unlockViewer(path, password);
    return {
      inspection: result,
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
import type { SanitizationRecipe, SensitiveRegionSuggestion } from '@alyte/domain';

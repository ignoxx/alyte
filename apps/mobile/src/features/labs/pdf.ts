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
  close(): Promise<void>;
}

export interface PdfInspector {
  inspect(path: string): Promise<PdfInspection>;
  unlock(path: string, password: string): Promise<PdfInspectionSession>;
}

type NativePdfModule = {
  inspect(path: string): Promise<PdfInspection>;
  unlock(path: string, password: string): Promise<PdfInspection & { readonly sessionId: string }>;
  close(sessionId: string): Promise<void>;
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
      close: () => native.close(result.sessionId),
    };
  },
};

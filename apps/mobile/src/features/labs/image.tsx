import type { ComponentType, Ref } from 'react';
import type { ViewProps } from 'react-native';
import type { RedactionRegion, SanitizationRecipe } from '@alyte/domain';

export type ImageInspection = {
  readonly width: number;
  readonly height: number;
  readonly pixelWidth: number;
  readonly pixelHeight: number;
  readonly hasMetadata: boolean;
};

export type ImageSanitizedVerification = {
  readonly verified: boolean;
  readonly selectableText: false;
  readonly annotations: false;
  readonly attachments: false;
  readonly metadata: boolean;
  readonly removableRedactions: false;
  readonly reloadChecked: boolean;
  readonly sourceAwareChecked: true;
  readonly sourceContentRemoved: true;
  readonly verificationVersion: 'image-source-aware-v2';
  readonly failureReasons: readonly string[];
  readonly pixelWidth: number;
  readonly pixelHeight: number;
};

export type ImageSanitizationResult = {
  readonly destinationPath: string;
  readonly byteSize: number;
  readonly verification: ImageSanitizedVerification;
};

export type ImageViewerSession = {
  readonly sessionId: string;
  readonly width: number;
  readonly height: number;
};

export interface ImageInspector {
  inspect(path: string): Promise<ImageInspection>;
  sanitize(
    sourcePath: string,
    destinationPath: string,
    recipe: SanitizationRecipe,
  ): Promise<ImageSanitizationResult>;
  verifySanitized(
    path: string,
    sourcePath: string,
    recipe: SanitizationRecipe,
  ): Promise<ImageSanitizedVerification>;
  /** Opens a verified native image session without exposing its protected path to React. */
  openViewer?(path: string): Promise<ImageViewerSession>;
  closeViewer?(sessionId: string): Promise<void>;
}

type NativeImageModule = ImageInspector & {
  openViewer(path: string): Promise<ImageViewerSession>;
  closeViewer(sessionId: string): Promise<void>;
};

export const nativeImageInspector: ImageInspector = {
  async inspect(path: string): Promise<ImageInspection> {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeImageModule>('AlyteImage');
    if (native === null) throw new Error('AlyteImage is unavailable for local image inspection');
    return native.inspect(path);
  },
  async sanitize(
    sourcePath: string,
    destinationPath: string,
    recipe: SanitizationRecipe,
  ): Promise<ImageSanitizationResult> {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeImageModule>('AlyteImage');
    if (native === null) throw new Error('AlyteImage is unavailable for image sanitization');
    return native.sanitize(sourcePath, destinationPath, recipe);
  },
  async verifySanitized(
    path: string,
    sourcePath: string,
    recipe: SanitizationRecipe,
  ): Promise<ImageSanitizedVerification> {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeImageModule>('AlyteImage');
    if (native === null) {
      throw new Error('AlyteImage is unavailable for image sanitization verification');
    }
    return native.verifySanitized(path, sourcePath, recipe);
  },
  async openViewer(path: string): Promise<ImageViewerSession> {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeImageModule>('AlyteImage');
    if (native === null) throw new Error('AlyteImage is unavailable for local image viewing');
    return native.openViewer(path);
  },
  async closeViewer(sessionId: string): Promise<void> {
    const { requireOptionalNativeModule } = await import('expo-modules-core');
    const native = requireOptionalNativeModule<NativeImageModule>('AlyteImage');
    if (native === null) return;
    await native.closeViewer(sessionId);
  },
};

export type NativeImageRedactionChange = {
  readonly pageIndex: 0;
  readonly redactions: readonly Pick<RedactionRegion, 'id' | 'rect'>[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

type ImageWorkspaceProps = ViewProps & {
  /** Source paths are retained for the editable privacy workspace only. */
  readonly sourcePath?: string;
  /** Opaque native capability used by the read-only Original Report viewer. */
  readonly viewerSessionId?: string;
  readonly redactMode: boolean;
  /** Read-only source navigation mode: show the stored region without editable redaction chrome. */
  readonly inspectionMode?: boolean;
  /** Normalized page-0 region to center and zoom when the workspace opens. */
  readonly focusRegion?: RedactionRegion['rect'] | null;
  readonly redactions: readonly RedactionRegion[];
  readonly accessibilityLabels: Readonly<Record<string, string>>;
  readonly onRedactionsChange?: (event: { nativeEvent: NativeImageRedactionChange }) => void;
  readonly onReady?: (event: {
    nativeEvent: { readonly width: number; readonly height: number };
  }) => void;
  readonly onFailure?: (event: { nativeEvent: { readonly message: string } }) => void;
  readonly onSelectionChange?: (event: { nativeEvent: { readonly selected: boolean } }) => void;
};

export type AlyteImageWorkspaceHandle = {
  undo(): Promise<void>;
  redo(): Promise<void>;
  clearSelection(): Promise<void>;
  removeSelected(): Promise<void>;
};

export function AlyteImageWorkspace(
  props: ImageWorkspaceProps & { readonly ref?: Ref<AlyteImageWorkspaceHandle> },
) {
  // Keep Expo's native-view registration out of the service adapter's module evaluation so the
  // local report lifecycle remains runnable in the Node test harness.
  const { requireNativeView } = require('expo') as {
    requireNativeView: <Props extends object>(moduleName: string) => ComponentType<Props>;
  };
  const NativeWorkspace = requireNativeView<ImageWorkspaceProps>('AlyteImage');
  return <NativeWorkspace {...props} />;
}

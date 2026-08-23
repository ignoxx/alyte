import { requireNativeView } from 'expo';
import type { Ref } from 'react';
import type { ViewProps } from 'react-native';
import type { RedactionRegion } from '@alyte/domain';

export type NativeRedactionChange = {
  readonly pageIndex: number;
  readonly redactions: readonly Pick<RedactionRegion, 'id' | 'rect'>[];
  readonly canUndo: boolean;
  readonly canRedo: boolean;
};

type Props = ViewProps & {
  readonly sourcePath: string;
  readonly pageIndex: number;
  readonly redactMode: boolean;
  readonly rotation: number;
  readonly crop: RedactionRegion['rect'] | null;
  readonly redactions: readonly RedactionRegion[];
  readonly accessibilityLabels: Readonly<Record<string, string>>;
  readonly onRedactionsChange?: (event: { nativeEvent: NativeRedactionChange }) => void;
  readonly onPageChange?: (event: { nativeEvent: { readonly pageIndex: number } }) => void;
  readonly onReady?: (event: { nativeEvent: { readonly pageCount: number } }) => void;
  readonly onFailure?: (event: { nativeEvent: { readonly message: string } }) => void;
};

const NativeWorkspace = requireNativeView<Props>('AlytePDF');
export type AlytePDFWorkspaceHandle = {
  undo(): Promise<void>;
  redo(): Promise<void>;
  clearSelection(): Promise<void>;
  removeSelected(): Promise<void>;
};

export function AlytePDFWorkspace(props: Props & { readonly ref?: Ref<AlytePDFWorkspaceHandle> }) {
  return <NativeWorkspace {...props} />;
}

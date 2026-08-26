import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Alert, AppState, StyleSheet, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import { AlytePDFWorkspace } from './AlytePDFWorkspace';
import { AlyteImageWorkspace } from './image';
import {
  LabReportImportError,
  type OriginalReportViewerSession,
  type PasswordRequest,
} from './report-service';

type Route = RouteProp<RootStackParamList, 'OriginalSourcePreview'>;

function clampPage(value: number, pageCount: number): number {
  return Math.max(0, Math.min(pageCount - 1, Math.round(value)));
}

export function OriginalSourcePreviewScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<Route>();
  const { reports } = useServices();
  const [viewer, setViewer] = useState<OriginalReportViewerSession | null>(null);
  const [failure, setFailure] = useState<'cancelled' | 'password' | 'failed' | null>(null);
  const [pageIndex, setPageIndex] = useState(0);
  const [attempt, setAttempt] = useState(0);
  const sessionRef = useRef<OriginalReportViewerSession | null>(null);
  const interruptedRef = useRef(false);
  const passwordPromptRef = useRef(false);
  const mountedRef = useRef(false);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <AppButton
          label={t('labs.reportPreviewClose')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      ),
    });
  }, [navigation]);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    interruptedRef.current = false;
    setViewer(null);
    setFailure(null);
    setPageIndex(Math.max(0, route.params.pageIndex ?? 0));

    void reports
      .openOriginalViewer(route.params.reportId, promptPassword)
      .then((next) => {
        if (!active || interruptedRef.current) {
          void next.close();
          return;
        }
        sessionRef.current = next;
        setViewer(next);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setFailure(
          error instanceof LabReportImportError
            ? error.reason === 'cancelled'
              ? 'cancelled'
              : error.reason === 'wrong-password'
                ? 'password'
                : 'failed'
            : 'failed',
        );
      });

    return () => {
      active = false;
      mountedRef.current = false;
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.close();
    };
  }, [attempt, reports, route.params.pageIndex, route.params.reportId]);

  function handleNativeViewerFailure() {
    interruptedRef.current = true;
    const session = sessionRef.current;
    sessionRef.current = null;
    void session?.close();
    if (!mountedRef.current) return;
    setViewer(null);
    setFailure('failed');
  }

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'background' && !(nextState === 'inactive' && !passwordPromptRef.current))
        return;
      interruptedRef.current = true;
      const session = sessionRef.current;
      sessionRef.current = null;
      void session?.close();
      setViewer(null);
      setFailure('failed');
    });
    return () => subscription.remove();
  }, []);

  function promptPassword({ report }: Parameters<PasswordRequest>[0]): Promise<string | null> {
    passwordPromptRef.current = true;
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value: string | null) => {
        if (settled) return;
        settled = true;
        passwordPromptRef.current = false;
        resolve(value);
      };
      Alert.prompt(
        t('labs.reportPasswordTitle'),
        t('labs.reportPasswordBody').replace('{filename}', report.originalFilename),
        (value) => finish(value),
        'secure-text',
        undefined,
        undefined,
        { onDismiss: () => finish(null) },
      );
    });
  }

  if (failure !== null) {
    return (
      <View style={styles.center}>
        <AppText selectable>
          {failure === 'cancelled'
            ? t('labs.reportViewerCancelled')
            : failure === 'password'
              ? t('labs.reportViewerPasswordError')
              : t('labs.reportViewerError')}
        </AppText>
        <AppButton
          label={t('labs.reportViewerRetry')}
          onPress={() => {
            setFailure(null);
            setAttempt((current) => current + 1);
          }}
          tone="secondary"
        />
      </View>
    );
  }

  if (viewer === null) {
    return (
      <View accessibilityLabel={t('labs.reportViewerLoading')} style={styles.center}>
        <AppText>{t('labs.loading')}</AppText>
      </View>
    );
  }

  const currentPage = clampPage(pageIndex, viewer.pageCount);
  const previousDisabled = currentPage === 0;
  const nextDisabled = currentPage >= viewer.pageCount - 1;

  return (
    <SafeAreaView edges={['bottom']} style={styles.root}>
      <View style={styles.viewer}>
        {viewer.sourceType === 'image' ? (
          <AlyteImageWorkspace
            accessibilityLabel={t('labs.reportPreviewImageLabel')}
            accessibilityLabels={{}}
            inspectionMode
            onFailure={handleNativeViewerFailure}
            redactMode={false}
            redactions={[]}
            style={styles.workspace}
            viewerSessionId={viewer.sessionId}
          />
        ) : (
          <AlytePDFWorkspace
            accessibilityLabel={t('labs.reportPreviewImageLabel')}
            accessibilityLabels={{}}
            crop={null}
            inspectionMode
            pageIndex={currentPage}
            redactMode={false}
            readOnlyViewer
            redactions={[]}
            rotation={0}
            onPageChange={({ nativeEvent }) => {
              setPageIndex(clampPage(nativeEvent.pageIndex, viewer.pageCount));
            }}
            onFailure={handleNativeViewerFailure}
            style={styles.workspace}
            viewerSessionId={viewer.sessionId}
          />
        )}
      </View>
      <View style={styles.controls}>
        <AppButton
          accessibilityLabel={t('labs.reportViewerPreviousPage')}
          disabled={previousDisabled}
          label={t('labs.reportViewerPreviousPage')}
          onPress={() => setPageIndex(clampPage(currentPage - 1, viewer.pageCount))}
          tone="quiet"
        />
        <AppText
          accessibilityLabel={t('labs.reportViewerPageCounter')
            .replace('{current}', String(currentPage + 1))
            .replace('{total}', String(viewer.pageCount))}
          selectable
          style={styles.pageCounter}
        >
          {`${currentPage + 1} / ${viewer.pageCount}`}
        </AppText>
        <AppButton
          accessibilityLabel={t('labs.reportViewerNextPage')}
          disabled={nextDisabled}
          label={t('labs.reportViewerNextPage')}
          onPress={() => setPageIndex(clampPage(currentPage + 1, viewer.pageCount))}
          tone="quiet"
        />
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  root: { backgroundColor: colors.canvas, flex: 1 },
  viewer: { backgroundColor: colors.elevatedSurface, flex: 1 },
  workspace: { flex: 1 },
  controls: {
    alignItems: 'center',
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    justifyContent: 'space-between',
    minHeight: 64,
    paddingHorizontal: spacing.sm,
  },
  pageCounter: {
    color: colors.mutedInk,
    fontVariant: ['tabular-nums'],
    textAlign: 'center',
  },
  center: {
    alignItems: 'center',
    backgroundColor: colors.canvas,
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
});

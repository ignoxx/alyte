import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Image as ExpoImage } from 'expo-image';
import {
  Alert,
  Image,
  Modal,
  Pressable,
  StyleSheet,
  View,
  type ColorValue,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  useNavigation,
  usePreventRemove,
  useRoute,
  type RouteProp,
} from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  reorderSanitizationPages,
  updateSanitizationPage,
  type RedactionRegion,
  type SanitizationRecipe,
} from '@alyte/domain';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { colors, spacing } from '../../theme';
import {
  AlytePDFWorkspace,
  type AlytePDFWorkspaceHandle,
  type NativeRedactionChange,
} from './AlytePDFWorkspace';
import {
  AlyteImageWorkspace,
  type AlyteImageWorkspaceHandle,
  type NativeImageRedactionChange,
} from './image';
import { sanitizedEditorToolbarState, sanitizedPageCounter } from './sanitized-editor-ui-model';
import type {
  PasswordRequest,
  SanitizationEditorState,
  SanitizedReportPreview,
} from './report-service';

type EditorRoute = RouteProp<RootStackParamList, 'PrivacyWorkspace'>;
type EditorNavigation = NativeStackNavigationProp<RootStackParamList, 'PrivacyWorkspace'>;

function passwordRequest(): PasswordRequest {
  return ({ report }) =>
    new Promise<string | null>((resolve) => {
      Alert.prompt(
        t('labs.reportPasswordTitle'),
        t('labs.reportPasswordBody').replace('{filename}', report.originalFilename),
        (value) => resolve(value),
        'secure-text',
        undefined,
        undefined,
        { onDismiss: () => resolve(null) },
      );
    });
}

export function SanitizedReportEditorScreen() {
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<EditorNavigation>();
  const route = useRoute<EditorRoute>();
  const { reports } = useServices();
  const pdfViewer = useRef<AlytePDFWorkspaceHandle>(null);
  const imageViewer = useRef<AlyteImageWorkspaceHandle>(null);
  const [state, setState] = useState<SanitizationEditorState | null>(null);
  const [recipe, setRecipe] = useState<SanitizationRecipe | null>(null);
  const [baseline, setBaseline] = useState('');
  const [pageIndex, setPageIndex] = useState(0);
  const [redactMode, setRedactMode] = useState(false);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [hasSelection, setHasSelection] = useState(false);
  const [pagesOpen, setPagesOpen] = useState(false);
  const [preview, setPreview] = useState<SanitizedReportPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const next = await reports.openSanitizationEditor(route.params.reportId, passwordRequest());
      setState(next);
      setRecipe(next.recipe);
      setBaseline(JSON.stringify(next.recipe));
    } catch {
      setError(t('labs.sanitizedEditorLoadError'));
    }
  }, [reports, route.params.reportId]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (recipe === null || JSON.stringify(recipe) === baseline) return;
    const timer = setTimeout(() => {
      void reports.saveSanitizationDraft(route.params.reportId, recipe);
    }, 250);
    return () => clearTimeout(timer);
  }, [baseline, recipe, reports, route.params.reportId]);
  useEffect(
    () => () => {
      void reports.closeSanitizationEditor(route.params.reportId);
    },
    [reports, route.params.reportId],
  );
  const dirty = recipe !== null && JSON.stringify(recipe) !== baseline;
  usePreventRemove(dirty, ({ data }) =>
    Alert.alert(t('labs.sanitizedDiscardTitle'), t('labs.sanitizedDiscardBody'), [
      { text: t('labs.sanitizedKeepEditing'), style: 'cancel' },
      {
        text: t('labs.sanitizedDiscard'),
        style: 'destructive',
        onPress: () => {
          void reports
            .discardSanitizationDraft(route.params.reportId)
            .then(() => navigation.dispatch(data.action));
        },
      },
    ]),
  );
  useEffect(() => {
    navigation.setOptions({
      headerShown: true,
      title:
        preview === null ? t('labs.sanitizedEditorTitle') : t('labs.sanitizedEditorPreviewTitle'),
      headerLeft: () => (
        <AppButton
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      ),
      headerRight: () => (
        <AppButton
          disabled={busy}
          label={t('labs.sanitizedDone')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      ),
    });
  }, [busy, navigation, preview]);
  const currentPage = useMemo(
    () => recipe?.pages.find((page) => page.pageIndex === pageIndex) ?? null,
    [pageIndex, recipe],
  );
  const toolbarState = useMemo(
    () => sanitizedEditorToolbarState({ busy, canUndo, canRedo, hasSelection }),
    [busy, canRedo, canUndo, hasSelection],
  );
  const pageCounter = useMemo(
    () => sanitizedPageCounter(recipe?.pages ?? [], pageIndex, t('labs.sanitizedPages')),
    [pageIndex, recipe],
  );
  const displayedPageIndex =
    preview === null
      ? pageIndex
      : Math.max(
          0,
          (recipe?.pages ?? [])
            .filter((page) => page.selected)
            .findIndex((page) => page.pageIndex === pageIndex),
        );

  function applyNativeRedactions(change: NativeRedactionChange) {
    if (recipe === null) return;
    const page = recipe.pages.find((item) => item.pageIndex === change.pageIndex);
    if (page === undefined) return;
    const nextRegions: RedactionRegion[] = change.redactions.map((changed) => {
      const existing = page.redactions.find((item) => item.id === changed.id);
      return {
        ...(existing ?? {
          id: changed.id,
          origin: 'user',
          label: null,
        }),
        rect: changed.rect,
      };
    });
    const next = {
      ...recipe,
      pages: recipe.pages.map((item) =>
        item.pageIndex === change.pageIndex ? { ...item, redactions: nextRegions } : item,
      ),
    };
    setRecipe(next);
    setPreview(null);
    setCanUndo(change.canUndo);
    setCanRedo(change.canRedo);
  }
  function applyImageRedactions(change: NativeImageRedactionChange) {
    applyNativeRedactions(change);
  }
  function updatePageFor(target: number, update: Parameters<typeof updateSanitizationPage>[2]) {
    if (recipe === null) return;
    try {
      setRecipe(updateSanitizationPage(recipe, target, update));
      setPreview(null);
    } catch {
      setError(t('labs.sanitizedEditorEditError'));
    }
  }
  function move(target: number, direction: -1 | 1) {
    if (recipe === null) return;
    const order = recipe.pages.map((page) => page.pageIndex);
    const from = order.indexOf(target);
    const to = from + direction;
    if (to < 0 || to >= order.length) return;
    [order[from], order[to]] = [order[to]!, order[from]!];
    setRecipe(reorderSanitizationPages(recipe, order));
    setPreview(null);
  }
  function adjustCrop(target: number, inset: number) {
    if (recipe === null) return;
    const page = recipe.pages.find((item) => item.pageIndex === target);
    if (page === undefined) return;
    const current = page.crop ?? { x: 0, y: 0, width: 1, height: 1 };
    const next = {
      x: Math.max(0, current.x + inset),
      y: Math.max(0, current.y + inset),
      width: Math.min(1, current.width - inset * 2),
      height: Math.min(1, current.height - inset * 2),
    };
    updatePageFor(target, {
      crop: inset < 0 && next.width >= 1 && next.height >= 1 ? null : next,
    });
  }
  async function sanitize() {
    if (recipe === null) return;
    setBusy(true);
    setError(null);
    try {
      await reports.saveSanitizedReport(route.params.reportId, recipe);
      setPreview(await reports.previewSanitizedReport(route.params.reportId));
      setBaseline(JSON.stringify(recipe));
      setRedactMode(false);
    } catch {
      setError(t('labs.sanitizedEditorVerificationError'));
    } finally {
      setBusy(false);
    }
  }
  if (state === null || recipe === null || currentPage === null)
    return (
      <View style={styles.center}>
        <AppText>{error ?? t('labs.loading')}</AppText>
        {error !== null && <AppButton label={t('labs.retry')} onPress={() => void load()} />}
      </View>
    );
  return (
    <View style={styles.root}>
      {error !== null && (
        <View style={styles.error}>
          <AppText style={styles.errorText}>{error}</AppText>
          <AppButton label={t('labs.retry')} onPress={() => void sanitize()} tone="quiet" />
        </View>
      )}
      {state.report.sourceType === 'image' ? (
        <AlyteImageWorkspace
          ref={imageViewer}
          style={styles.viewer}
          sourcePath={preview?.artifactPath ?? state.sourcePath}
          redactMode={redactMode && preview === null && !busy}
          redactions={preview === null ? currentPage.redactions : []}
          accessibilityLabels={{
            redaction: t('labs.sanitizedEditorOverlayLabel'),
            moveLeft: t('labs.sanitizedEditorMoveLeft'),
            moveRight: t('labs.sanitizedEditorMoveRight'),
            moveUp: t('labs.sanitizedEditorMoveUp'),
            moveDown: t('labs.sanitizedEditorMoveDown'),
            grow: t('labs.sanitizedEditorResize'),
            shrink: t('labs.sanitizedEditorResizeSmaller'),
            resize: t('labs.sanitizedEditorResize'),
            value: t('labs.sanitizedEditorOverlayValue'),
            selected: t('labs.sanitizedEditorSelected'),
            notSelected: t('labs.sanitizedEditorNotSelected'),
            remove: t('labs.sanitizedEditorRemove'),
          }}
          onRedactionsChange={(event) => applyImageRedactions(event.nativeEvent)}
          onSelectionChange={(event) => setHasSelection(event.nativeEvent.selected)}
          onFailure={() => setError(t('labs.sanitizedEditorLoadError'))}
          accessibilityLabel={
            preview === null ? t('labs.sanitizedOriginalCanvas') : t('labs.sanitizedExactCanvas')
          }
        />
      ) : (
        <AlytePDFWorkspace
          ref={pdfViewer}
          style={styles.viewer}
          sourcePath={preview?.artifactPath ?? state.sourcePath}
          pageIndex={displayedPageIndex}
          redactMode={redactMode && preview === null && !busy}
          rotation={preview === null ? currentPage.rotation : 0}
          crop={preview === null ? currentPage.crop : null}
          redactions={preview === null ? currentPage.redactions : []}
          accessibilityLabels={{
            redaction: t('labs.sanitizedEditorOverlayLabel'),
            moveLeft: t('labs.sanitizedEditorMoveLeft'),
            moveRight: t('labs.sanitizedEditorMoveRight'),
            moveUp: t('labs.sanitizedEditorMoveUp'),
            moveDown: t('labs.sanitizedEditorMoveDown'),
            grow: t('labs.sanitizedEditorResize'),
            shrink: t('labs.sanitizedEditorResizeSmaller'),
            resize: t('labs.sanitizedEditorResize'),
            value: t('labs.sanitizedEditorOverlayValue'),
            selected: t('labs.sanitizedEditorSelected'),
            notSelected: t('labs.sanitizedEditorNotSelected'),
            remove: t('labs.sanitizedEditorRemove'),
          }}
          onRedactionsChange={(event) => applyNativeRedactions(event.nativeEvent)}
          onSelectionChange={(event) => setHasSelection(event.nativeEvent.selected)}
          onFailure={() => setError(t('labs.sanitizedEditorLoadError'))}
          accessibilityLabel={
            preview === null ? t('labs.sanitizedOriginalCanvas') : t('labs.sanitizedExactCanvas')
          }
        />
      )}
      {preview !== null && (
        <View style={styles.verified}>
          <AppText>{t('labs.sanitizedEditorVerified')}</AppText>
        </View>
      )}
      <View
        style={[styles.toolbar, { paddingBottom: Math.max(insets.bottom, spacing.sm) }]}
        accessibilityLabel={busy ? t('labs.loading') : undefined}
        accessibilityRole="toolbar"
        accessibilityState={{ busy }}
      >
        {preview === null ? (
          <>
            <View style={styles.editingTools}>
              <ToolbarAction
                symbol="rectangle.dashed"
                label={t('labs.sanitizedRedact')}
                disabled={toolbarState.redactDisabled}
                onPress={() => {
                  setRedactMode((value) => !value);
                  void (state.report.sourceType === 'image'
                    ? imageViewer.current?.clearSelection()
                    : pdfViewer.current?.clearSelection());
                }}
                selected={redactMode}
              />
              <ToolbarAction
                symbol="arrow.uturn.backward"
                disabled={toolbarState.undoDisabled}
                label={t('labs.sanitizedUndo')}
                onPress={() =>
                  void (state.report.sourceType === 'image'
                    ? imageViewer.current?.undo()
                    : pdfViewer.current?.undo())
                }
              />
              <ToolbarAction
                symbol="arrow.uturn.forward"
                disabled={toolbarState.redoDisabled}
                label={t('labs.sanitizedRedo')}
                onPress={() =>
                  void (state.report.sourceType === 'image'
                    ? imageViewer.current?.redo()
                    : pdfViewer.current?.redo())
                }
              />
              <ToolbarAction
                symbol="trash"
                disabled={toolbarState.removeDisabled}
                label={t('labs.sanitizedEditorRemove')}
                onPress={() =>
                  void (state.report.sourceType === 'image'
                    ? imageViewer.current?.removeSelected()
                    : pdfViewer.current?.removeSelected())
                }
              />
              {state.report.sourceType === 'pdf' && (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={pageCounter}
                  accessibilityState={{ disabled: toolbarState.pagesDisabled }}
                  disabled={toolbarState.pagesDisabled}
                  onPress={() => setPagesOpen(true)}
                  style={({ pressed }) => [
                    styles.pageControl,
                    toolbarState.pagesDisabled && styles.pageControlDisabled,
                    pressed && styles.toolbarActionPressed,
                  ]}
                >
                  <ExpoImage
                    source="sf:square.grid.2x2"
                    style={{ color: colors.mutedInk, height: 18, width: 18 }}
                  />
                  <AppText style={styles.pageCounter} variant="caption">
                    {pageCounter}
                  </AppText>
                </Pressable>
              )}
            </View>
            <AppButton
              disabled={toolbarState.sanitizeDisabled}
              style={styles.sanitizeButton}
              label={
                state.current === null ? t('labs.sanitizeReport') : t('labs.sanitizeReportAgain')
              }
              onPress={() => void sanitize()}
            />
          </>
        ) : (
          <AppButton
            disabled={busy}
            label={t('labs.editRedactions')}
            onPress={() => setPreview(null)}
            style={styles.sanitizeButton}
            tone="secondary"
          />
        )}
      </View>
      <Modal
        animationType="slide"
        presentationStyle="pageSheet"
        visible={pagesOpen}
        onRequestClose={() => setPagesOpen(false)}
      >
        <View style={styles.manager}>
          <View style={styles.managerHeader}>
            <AppText variant="heading">{t('labs.sanitizedPages')}</AppText>
            <AppButton
              label={t('labs.sanitizedDone')}
              onPress={() => setPagesOpen(false)}
              tone="quiet"
            />
          </View>
          {recipe.pages.map((page, index) => (
            <Pressable
              key={page.pageIndex}
              accessibilityRole="button"
              onPress={() => {
                setPageIndex(page.pageIndex);
                setPagesOpen(false);
              }}
              style={[styles.pageRow, page.pageIndex === pageIndex && styles.pageSelected]}
            >
              <Image
                accessibilityIgnoresInvertColors
                accessibilityLabel={t('labs.sanitizedEditorPage').replace(
                  '{page}',
                  String(page.pageIndex + 1),
                )}
                resizeMode="contain"
                source={{ uri: state.pagePreviewUris[page.pageIndex] }}
                style={[styles.pageThumbnail, !page.selected && styles.pageThumbnailExcluded]}
              />
              <View style={styles.pageDetails}>
                <AppText>
                  {t('labs.sanitizedEditorPage').replace('{page}', String(page.pageIndex + 1))}
                </AppText>
                <View style={styles.pageActions}>
                  <AppButton
                    label={
                      page.selected
                        ? t('labs.sanitizedEditorExclude')
                        : t('labs.sanitizedEditorInclude')
                    }
                    onPress={() => updatePageFor(page.pageIndex, { selected: !page.selected })}
                    tone="quiet"
                  />
                  {state.report.sourceType === 'pdf' && (
                    <>
                      <AppButton
                        label={t('labs.sanitizedEditorRotate')}
                        onPress={() =>
                          updatePageFor(page.pageIndex, {
                            rotation: ((page.rotation + 90) % 360) as 0 | 90 | 180 | 270,
                          })
                        }
                        tone="quiet"
                      />
                      <AppButton
                        label={t('labs.sanitizedEditorCropIn')}
                        onPress={() => adjustCrop(page.pageIndex, 0.025)}
                        tone="quiet"
                      />
                      <AppButton
                        disabled={page.crop === null}
                        label={t('labs.sanitizedEditorCropOut')}
                        onPress={() => adjustCrop(page.pageIndex, -0.025)}
                        tone="quiet"
                      />
                      <AppButton
                        disabled={page.crop === null}
                        label={t('labs.sanitizedEditorCropReset')}
                        onPress={() => updatePageFor(page.pageIndex, { crop: null })}
                        tone="quiet"
                      />
                    </>
                  )}
                  <ToolbarAction
                    symbol="arrow.up"
                    label={t('labs.sanitizedEditorMovePageEarlier')}
                    disabled={index === 0}
                    onPress={() => move(page.pageIndex, -1)}
                    style={styles.pageIconAction}
                  />
                  <ToolbarAction
                    symbol="arrow.down"
                    label={t('labs.sanitizedEditorMovePageLater')}
                    disabled={index === recipe.pages.length - 1}
                    onPress={() => move(page.pageIndex, 1)}
                    style={styles.pageIconAction}
                  />
                </View>
              </View>
            </Pressable>
          ))}
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  center: {
    alignItems: 'center',
    flex: 1,
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  error: {
    alignItems: 'center',
    backgroundColor: colors.surface,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  errorText: { color: colors.danger, flex: 1 },
  manager: { backgroundColor: colors.canvas, flex: 1, padding: spacing.lg },
  managerHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: spacing.md,
  },
  pageActions: { alignItems: 'center', flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  pageDetails: { flex: 1, gap: spacing.xs },
  pageRow: {
    alignItems: 'center',
    borderBottomColor: colors.border,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.md,
    minHeight: 72,
    padding: spacing.sm,
  },
  pageSelected: { backgroundColor: colors.surface },
  pageThumbnail: { backgroundColor: colors.surface, borderRadius: 4, height: 92, width: 70 },
  pageThumbnailExcluded: { opacity: 0.4 },
  root: { backgroundColor: colors.canvas, flex: 1 },
  toolbar: {
    alignItems: 'stretch',
    backgroundColor: colors.elevatedSurface,
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingTop: spacing.sm,
  },
  editingTools: {
    alignItems: 'stretch',
    flexDirection: 'row',
    justifyContent: 'space-around',
  },
  pageControl: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 10,
    flexDirection: 'row',
    gap: spacing.xs,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 96,
    paddingHorizontal: spacing.xs,
  },
  pageControlDisabled: { opacity: 0.38 },
  pageCounter: { flexShrink: 1, textAlign: 'center' },
  toolbarAction: {
    alignItems: 'center',
    borderCurve: 'continuous',
    borderRadius: 10,
    height: 44,
    justifyContent: 'center',
    minHeight: 44,
    minWidth: 44,
    width: 44,
  },
  pageIconAction: { flexGrow: 0 },
  sanitizeButton: { alignSelf: 'stretch' },
  toolbarActionPressed: { backgroundColor: colors.accentSoft },
  toolbarActionSelected: { backgroundColor: colors.accentSoft },
  toolbarActionDisabled: { opacity: 0.38 },
  verified: {
    backgroundColor: colors.surface,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.xs,
  },
  viewer: { flex: 1 },
});

function ToolbarAction({
  symbol,
  label,
  disabled = false,
  selected = false,
  style,
  onPress,
}: {
  readonly symbol: string;
  readonly label: string;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly style?: StyleProp<ViewStyle>;
  readonly onPress: () => void;
}) {
  const tint: ColorValue = selected ? colors.accent : colors.mutedInk;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled, selected }}
      disabled={disabled}
      hitSlop={2}
      onPress={onPress}
      style={({ pressed }) => [
        styles.toolbarAction,
        style,
        selected && styles.toolbarActionSelected,
        pressed && !disabled && styles.toolbarActionPressed,
        disabled && styles.toolbarActionDisabled,
      ]}
    >
      <ExpoImage source={`sf:${symbol}`} style={{ color: tint, height: 18, width: 18 }} />
    </Pressable>
  );
}

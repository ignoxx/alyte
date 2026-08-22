import { useCallback, useEffect, useState } from 'react';
import {
  Image,
  PanResponder,
  ScrollView,
  StyleSheet,
  View,
  useWindowDimensions,
} from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  addRedaction,
  removeRedaction,
  reorderSanitizationPages,
  updateRedaction,
  updateSanitizationPage,
  type RedactionRegion,
  type SanitizationRecipe,
} from '@alyte/domain';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { colors, screenStyles, spacing } from '../../theme';
import type { SanitizationEditorState, SanitizedReportPreview } from './report-service';

type EditorRoute = RouteProp<LabsStackParamList, 'SanitizedReportEditor'>;
type EditorNavigation = NativeStackNavigationProp<LabsStackParamList, 'SanitizedReportEditor'>;

function nextUserRegion(pageIndex: number): RedactionRegion {
  return {
    id: `user-redaction-${pageIndex}-${Date.now()}`,
    rect: { x: 0.35, y: 0.4, width: 0.3, height: 0.08 },
    origin: 'user',
    label: null,
  };
}

export function SanitizedReportEditorScreen() {
  const navigation = useNavigation<EditorNavigation>();
  const route = useRoute<EditorRoute>();
  const { reports } = useServices();
  const { width: windowWidth } = useWindowDimensions();
  const previewWidth = Math.max(240, windowWidth - spacing.lg * 2);
  const previewHeight = 220;
  const [state, setState] = useState<SanitizationEditorState | null>(null);
  const [recipe, setRecipe] = useState<SanitizationRecipe | null>(null);
  const [preview, setPreview] = useState<SanitizedReportPreview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await reports.openSanitizationEditor(route.params.reportId);
      setState(next);
      setRecipe(next.recipe);
      setPreview(null);
    } catch {
      setError(t('labs.sanitizedEditorLoadError'));
    } finally {
      setLoading(false);
    }
  }, [reports, route.params.reportId]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    return navigation.addListener('beforeRemove', () => {
      void reports.closeSanitizationEditor(route.params.reportId);
    });
  }, [navigation, reports, route.params.reportId]);

  function setPage(recipeUpdate: SanitizationRecipe) {
    setRecipe(recipeUpdate);
    setPreview(null);
  }

  function addSuggested(
    pageIndex: number,
    suggestion: {
      readonly id: string;
      readonly rect: RedactionRegion['rect'];
      readonly label: string | null;
    },
  ) {
    if (recipe === null) return;
    try {
      setPage(
        addRedaction(recipe, pageIndex, {
          id: suggestion.id,
          rect: suggestion.rect,
          origin: 'suggested',
          label: suggestion.label,
        }),
      );
    } catch {
      setError(t('labs.sanitizedEditorEditError'));
    }
  }

  function addUser(pageIndex: number) {
    if (recipe === null) return;
    try {
      setPage(addRedaction(recipe, pageIndex, nextUserRegion(pageIndex)));
    } catch {
      setError(t('labs.sanitizedEditorEditError'));
    }
  }

  function nudge(pageIndex: number, region: RedactionRegion, delta: number) {
    if (recipe === null) return;
    try {
      setPage(
        updateRedaction(recipe, pageIndex, region.id, {
          ...region.rect,
          x: Math.max(0, Math.min(1 - region.rect.width, region.rect.x + delta)),
        }),
      );
    } catch {
      setError(t('labs.sanitizedEditorEditError'));
    }
  }

  function adjustRegion(
    pageIndex: number,
    region: RedactionRegion,
    dx: number,
    dy: number,
    dw = 0,
    dh = 0,
  ) {
    if (recipe === null) return;
    try {
      const width = Math.max(0.02, Math.min(1 - region.rect.x, region.rect.width + dw));
      const height = Math.max(0.02, Math.min(1 - region.rect.y, region.rect.height + dh));
      setPage(
        updateRedaction(recipe, pageIndex, region.id, {
          x: Math.max(0, Math.min(1 - width, region.rect.x + dx)),
          y: Math.max(0, Math.min(1 - height, region.rect.y + dy)),
          width,
          height,
        }),
      );
    } catch {
      setError(t('labs.sanitizedEditorEditError'));
    }
  }

  function updateRegionFromGesture(
    pageIndex: number,
    region: RedactionRegion,
    dx: number,
    dy: number,
    resize: boolean,
  ) {
    setRecipe((current) => {
      if (current === null) return current;
      const currentRegion = current.pages
        .find((candidate) => candidate.pageIndex === pageIndex)
        ?.redactions.find((candidate) => candidate.id === region.id);
      if (currentRegion === undefined) return current;
      const base = currentRegion.rect;
      const nextWidth = resize ? Math.max(0.02, Math.min(1 - base.x, base.width + dx)) : base.width;
      const nextHeight = resize
        ? Math.max(0.02, Math.min(1 - base.y, base.height + dy))
        : base.height;
      try {
        setPreview(null);
        return updateRedaction(current, pageIndex, region.id, {
          x: resize ? region.rect.x : Math.max(0, Math.min(1 - nextWidth, base.x + dx)),
          y: resize ? region.rect.y : Math.max(0, Math.min(1 - nextHeight, base.y + dy)),
          width: nextWidth,
          height: nextHeight,
        });
      } catch {
        return current;
      }
    });
  }

  function regionResponder(pageIndex: number, region: RedactionRegion, resize: boolean) {
    let previousX = 0;
    let previousY = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        previousX = 0;
        previousY = 0;
      },
      onPanResponderMove: (_event, gesture) => {
        const x = gesture.dx / previewWidth;
        const y = gesture.dy / previewHeight;
        updateRegionFromGesture(pageIndex, region, x - previousX, y - previousY, resize);
        previousX = x;
        previousY = y;
      },
    });
  }

  function adjustCrop(pageIndex: number, page: SanitizationRecipe['pages'][number], delta: number) {
    const crop = page.crop;
    try {
      setPage(
        updateSanitizationPage(recipe as SanitizationRecipe, pageIndex, {
          crop:
            crop === null
              ? { x: 0.05, y: 0.05, width: 0.9, height: 0.9 }
              : {
                  x: Math.max(0, Math.min(1 - crop.width, crop.x - delta)),
                  y: Math.max(0, Math.min(1 - crop.height, crop.y - delta)),
                  width: Math.max(0.2, Math.min(1, crop.width + delta * 2)),
                  height: Math.max(0.2, Math.min(1, crop.height + delta * 2)),
                },
        }),
      );
    } catch {
      setError(t('labs.sanitizedEditorEditError'));
    }
  }

  function cropResponder(pageIndex: number) {
    let previousX = 0;
    let previousY = 0;
    return PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderGrant: () => {
        previousX = 0;
        previousY = 0;
      },
      onPanResponderMove: (_event, gesture) => {
        const dx = gesture.dx / previewWidth - previousX;
        const dy = gesture.dy / previewHeight - previousY;
        previousX += dx;
        previousY += dy;
        try {
          setRecipe((current) => {
            if (current === null) return current;
            setPreview(null);
            const crop = current.pages.find((candidate) => candidate.pageIndex === pageIndex)
              ?.crop ?? {
              x: 0,
              y: 0,
              width: 1,
              height: 1,
            };
            return updateSanitizationPage(current, pageIndex, {
              crop: {
                x: crop.x,
                y: crop.y,
                width: Math.max(0.2, Math.min(1 - crop.x, crop.width + dx)),
                height: Math.max(0.2, Math.min(1 - crop.y, crop.height + dy)),
              },
            });
          });
        } catch {
          setError(t('labs.sanitizedEditorEditError'));
        }
      },
    });
  }

  function movePage(pageIndex: number, direction: -1 | 1) {
    if (recipe === null) return;
    const order = recipe.pages.map((page) => page.pageIndex);
    const index = order.indexOf(pageIndex);
    const next = index + direction;
    if (index < 0 || next < 0 || next >= order.length) return;
    const current = order[index];
    const target = order[next];
    if (current === undefined || target === undefined) return;
    order[index] = target;
    order[next] = current;
    setPage(reorderSanitizationPages(recipe, order));
  }

  async function saveAndPreview() {
    if (recipe === null) return;
    setBusy(true);
    setError(null);
    try {
      await reports.saveSanitizedReport(route.params.reportId, recipe);
      setPreview(await reports.previewSanitizedReport(route.params.reportId));
    } catch {
      // No preview is shown for an unverified artifact. The original remains untouched.
      setPreview(null);
      setError(t('labs.sanitizedEditorVerificationError'));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <AppText>{t('labs.loading')}</AppText>;
  if (error !== null && state === null) {
    return (
      <View style={styles.center}>
        <AppText>{error}</AppText>
        <AppButton label={t('labs.retry')} onPress={() => void load()} tone="secondary" />
      </View>
    );
  }
  if (state === null || recipe === null) return null;

  return (
    <ScrollView contentContainerStyle={screenStyles.content} style={screenStyles.scroll}>
      <View style={styles.header}>
        <StatusPill>{t('labs.sanitizedEditorLocalOnly')}</StatusPill>
      </View>
      <AppText style={styles.body}>{t('labs.sanitizedEditorBody')}</AppText>
      <AppSurface tone="soft" style={styles.privacyCard}>
        <AppText variant="heading">{t('labs.sanitizedEditorExactTitle')}</AppText>
        <AppText>{t('labs.sanitizedEditorExactBody')}</AppText>
      </AppSurface>
      {error !== null && <AppText style={styles.error}>{error}</AppText>}
      {recipe.pages.map((page) => {
        const suggestions = state.suggestions.filter((item) => item.pageIndex === page.pageIndex);
        return (
          <AppSurface key={page.pageIndex} style={styles.pageCard}>
            <View style={styles.pageHeader}>
              <AppText variant="heading">
                {t('labs.sanitizedEditorPage').replace('{page}', String(page.pageIndex + 1))}
              </AppText>
              <StatusPill>
                {page.selected
                  ? t('labs.sanitizedEditorIncluded')
                  : t('labs.sanitizedEditorExcluded')}
              </StatusPill>
            </View>
            <View style={[styles.sourcePreview, { height: previewHeight, width: previewWidth }]}>
              {state.pagePreviewUris[page.pageIndex] !== undefined && (
                <Image
                  accessibilityLabel={t('labs.sanitizedEditorSourcePreview').replace(
                    '{page}',
                    String(page.pageIndex + 1),
                  )}
                  resizeMode="stretch"
                  source={{ uri: state.pagePreviewUris[page.pageIndex] }}
                  style={styles.sourceImage}
                />
              )}
              {page.redactions.map((region) => (
                <View
                  key={`overlay-${region.id}`}
                  accessibilityLabel={t('labs.sanitizedEditorOverlayLabel')}
                  style={[
                    styles.overlay,
                    {
                      backgroundColor: region.origin === 'suggested' ? colors.warm : colors.danger,
                      left: region.rect.x * previewWidth,
                      top: region.rect.y * previewHeight,
                      width: region.rect.width * previewWidth,
                      height: region.rect.height * previewHeight,
                    },
                  ]}
                  {...regionResponder(page.pageIndex, region, false).panHandlers}
                >
                  <View
                    accessibilityLabel={t('labs.sanitizedEditorResize')}
                    style={styles.resizeHandle}
                    {...regionResponder(page.pageIndex, region, true).panHandlers}
                  />
                </View>
              ))}
              <View
                accessibilityLabel={t('labs.sanitizedEditorCropBounds')}
                pointerEvents="none"
                style={[
                  styles.cropOverlay,
                  {
                    left: (page.crop?.x ?? 0) * previewWidth,
                    top: (page.crop?.y ?? 0) * previewHeight,
                    width: (page.crop?.width ?? 1) * previewWidth,
                    height: (page.crop?.height ?? 1) * previewHeight,
                  },
                ]}
              />
              <View
                accessibilityLabel={t('labs.sanitizedEditorResizeCrop')}
                style={[
                  styles.cropHandle,
                  {
                    left: ((page.crop?.x ?? 0) + (page.crop?.width ?? 1)) * previewWidth - 16,
                    top: ((page.crop?.y ?? 0) + (page.crop?.height ?? 1)) * previewHeight - 16,
                  },
                ]}
                {...cropResponder(page.pageIndex).panHandlers}
              />
            </View>
            <View style={styles.actions}>
              <AppButton
                label={t('labs.sanitizedEditorMovePageEarlier')}
                accessibilityLabel={t('labs.sanitizedEditorMovePageEarlier')}
                onPress={() => movePage(page.pageIndex, -1)}
                tone="quiet"
              />
              <AppButton
                label={t('labs.sanitizedEditorMovePageLater')}
                accessibilityLabel={t('labs.sanitizedEditorMovePageLater')}
                onPress={() => movePage(page.pageIndex, 1)}
                tone="quiet"
              />
            </View>
            <View style={styles.actions}>
              <AppButton
                label={
                  page.selected
                    ? t('labs.sanitizedEditorExclude')
                    : t('labs.sanitizedEditorInclude')
                }
                onPress={() =>
                  setPage(
                    updateSanitizationPage(recipe, page.pageIndex, { selected: !page.selected }),
                  )
                }
                tone="secondary"
              />
              <AppButton
                label={t('labs.sanitizedEditorRotate')}
                onPress={() =>
                  setPage(
                    updateSanitizationPage(recipe, page.pageIndex, {
                      rotation: ((page.rotation + 90) % 360) as 0 | 90 | 180 | 270,
                    }),
                  )
                }
                tone="secondary"
              />
              <AppButton
                label={t('labs.sanitizedEditorCrop')}
                onPress={() => adjustCrop(page.pageIndex, page, page.crop === null ? 0.05 : 0.02)}
                tone="secondary"
              />
              <AppButton
                label={t('labs.sanitizedEditorCropExpand')}
                accessibilityLabel={t('labs.sanitizedEditorCropExpand')}
                onPress={() => adjustCrop(page.pageIndex, page, -0.02)}
                tone="quiet"
              />
              <AppButton
                label={t('labs.sanitizedEditorAdd')}
                onPress={() => addUser(page.pageIndex)}
                tone="secondary"
              />
            </View>
            {suggestions.map((suggestion) => (
              <AppButton
                key={suggestion.id}
                label={t('labs.sanitizedEditorAddSuggestion').replace(
                  '{label}',
                  suggestion.label ?? t('labs.sanitizedEditorSensitiveRegion'),
                )}
                onPress={() => addSuggested(page.pageIndex, suggestion)}
                tone="quiet"
              />
            ))}
            {page.redactions.map((region) => (
              <View key={region.id} style={styles.redactionRow}>
                <AppText>
                  {region.label ?? t('labs.sanitizedEditorSensitiveRegion')} —{' '}
                  {region.origin === 'suggested'
                    ? t('labs.sanitizedEditorOriginSuggested')
                    : t('labs.sanitizedEditorOriginUser')}
                </AppText>
                <View style={styles.actions}>
                  <AppButton
                    label="←"
                    accessibilityLabel={t('labs.sanitizedEditorMoveLeft')}
                    onPress={() => nudge(page.pageIndex, region, -0.02)}
                    tone="quiet"
                  />
                  <AppButton
                    label="↑"
                    accessibilityLabel={t('labs.sanitizedEditorMoveUp')}
                    onPress={() => adjustRegion(page.pageIndex, region, 0, -0.02)}
                    tone="quiet"
                  />
                  <AppButton
                    label="↓"
                    accessibilityLabel={t('labs.sanitizedEditorMoveDown')}
                    onPress={() => adjustRegion(page.pageIndex, region, 0, 0.02)}
                    tone="quiet"
                  />
                  <AppButton
                    label="+"
                    accessibilityLabel={t('labs.sanitizedEditorResize')}
                    onPress={() => adjustRegion(page.pageIndex, region, 0, 0, 0.02, 0.02)}
                    tone="quiet"
                  />
                  <AppButton
                    label="−"
                    accessibilityLabel={t('labs.sanitizedEditorResizeSmaller')}
                    onPress={() => adjustRegion(page.pageIndex, region, 0, 0, -0.02, -0.02)}
                    tone="quiet"
                  />
                  <AppButton
                    label="→"
                    accessibilityLabel={t('labs.sanitizedEditorMoveRight')}
                    onPress={() => nudge(page.pageIndex, region, 0.02)}
                    tone="quiet"
                  />
                  <AppButton
                    label={t('labs.sanitizedEditorRemove')}
                    onPress={() => setPage(removeRedaction(recipe, page.pageIndex, region.id))}
                    tone="quiet"
                  />
                </View>
              </View>
            ))}
          </AppSurface>
        );
      })}
      <AppButton
        disabled={busy}
        label={t('labs.sanitizedEditorPreview')}
        onPress={() => void saveAndPreview()}
      />
      {state.current !== null && (
        <AppButton
          label={t('labs.sanitizedEditorDelete')}
          onPress={() =>
            void reports
              .deleteSanitizedReport(route.params.reportId)
              .then(() => {
                setPreview(null);
                setState((current) => (current === null ? current : { ...current, current: null }));
              })
              .catch(() => setError(t('labs.sanitizedEditorDeleteError')))
          }
          tone="quiet"
        />
      )}
      {preview !== null && (
        <AppSurface tone="soft" style={styles.previewCard}>
          <AppText variant="heading">{t('labs.sanitizedEditorPreviewTitle')}</AppText>
          <AppText>{t('labs.sanitizedEditorVerified')}</AppText>
          <ScrollView contentContainerStyle={styles.previewPages}>
            {preview.uris.map((uri, index) => (
              <Image
                key={`${uri}-${index}`}
                accessibilityLabel={`${t('labs.reportPreviewImageLabel')} ${index + 1}`}
                resizeMode="contain"
                source={{ uri }}
                style={styles.previewImage}
              />
            ))}
          </ScrollView>
        </AppSurface>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  body: { color: colors.mutedInk, marginTop: spacing.sm },
  center: { alignItems: 'center', gap: spacing.md, justifyContent: 'center', padding: spacing.lg },
  error: { color: colors.danger, marginTop: spacing.sm },
  header: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  pageCard: { gap: spacing.sm, marginTop: spacing.md },
  pageHeader: { alignItems: 'center', flexDirection: 'row', justifyContent: 'space-between' },
  privacyCard: { gap: spacing.xs, marginTop: spacing.md },
  previewCard: { gap: spacing.sm, marginTop: spacing.md },
  previewImage: { height: 520, width: '100%' },
  sourcePreview: { backgroundColor: colors.surface, overflow: 'hidden', position: 'relative' },
  sourceImage: { height: '100%', width: '100%' },
  overlay: { borderColor: colors.ink, borderWidth: 1, opacity: 0.55, position: 'absolute' },
  resizeHandle: {
    backgroundColor: colors.ink,
    bottom: -5,
    height: 12,
    position: 'absolute',
    right: -5,
    width: 12,
  },
  cropOverlay: { borderColor: colors.accent, borderWidth: 2, position: 'absolute' },
  cropHandle: { backgroundColor: colors.accent, height: 16, position: 'absolute', width: 16 },
  previewPages: { flexGrow: 1, gap: spacing.md, paddingVertical: spacing.md },
  redactionRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingTop: spacing.sm,
  },
});

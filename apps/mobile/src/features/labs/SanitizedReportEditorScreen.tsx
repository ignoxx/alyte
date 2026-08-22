import { useCallback, useEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import {
  addRedaction,
  removeRedaction,
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

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type EditorRoute = RouteProp<LabsStackParamList, 'SanitizedReportEditor'>;

function nextUserRegion(pageIndex: number): RedactionRegion {
  return {
    id: `user-redaction-${pageIndex}-${Date.now()}`,
    rect: { x: 0.35, y: 0.4, width: 0.3, height: 0.08 },
    origin: 'user',
    label: null,
  };
}

export function SanitizedReportEditorScreen() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<EditorRoute>();
  const { reports } = useServices();
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
        <AppButton
          label={t('labs.recordCancel')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
        <StatusPill>{t('labs.sanitizedEditorLocalOnly')}</StatusPill>
      </View>
      <AppText variant="title">{t('labs.sanitizedEditorTitle')}</AppText>
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
                onPress={() =>
                  setPage(
                    updateSanitizationPage(recipe, page.pageIndex, {
                      crop: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 },
                    }),
                  )
                }
                tone="secondary"
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
                  {region.label ?? t('labs.sanitizedEditorSensitiveRegion')} ({region.origin})
                </AppText>
                <View style={styles.actions}>
                  <AppButton
                    label="←"
                    accessibilityLabel={t('labs.sanitizedEditorMoveLeft')}
                    onPress={() => nudge(page.pageIndex, region, -0.02)}
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
  previewPages: { flexGrow: 1, gap: spacing.md, paddingVertical: spacing.md },
  redactionRow: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.xs,
    paddingTop: spacing.sm,
  },
});

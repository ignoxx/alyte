import { useEffect, useLayoutEffect, useState } from 'react';
import { Image, ScrollView, StyleSheet, View } from 'react-native';
import {
  useNavigation,
  useRoute,
  type NavigationProp,
  type RouteProp,
} from '@react-navigation/native';
import type { RootStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { AppButton, AppText } from '../../ui/primitives';
import { colors, spacing } from '../../theme';

type PreviewRoute = RouteProp<RootStackParamList, 'SanitizedSourcePreview'>;

export function SanitizedSourcePreviewScreen() {
  const navigation = useNavigation<NavigationProp<RootStackParamList>>();
  const route = useRoute<PreviewRoute>();
  const { reports } = useServices();
  const [uri, setUri] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useLayoutEffect(() => {
    navigation.setOptions({
      headerLeft: () => (
        <AppButton label={t('labs.done')} onPress={() => navigation.goBack()} tone="quiet" />
      ),
    });
  }, [navigation]);

  useEffect(() => {
    let active = true;
    void reports
      .previewSanitizedReport(route.params.reportId)
      .then((preview) => {
        const page = preview.uris[route.params.pageIndex];
        if (page === undefined) throw new Error('Sanitized page is unavailable');
        if (active) setUri(page);
      })
      .catch(() => {
        if (active) setFailed(true);
      });
    return () => {
      active = false;
    };
  }, [attempt, reports, route.params.pageIndex, route.params.reportId]);

  if (failed) {
    return (
      <View style={styles.center}>
        <AppText selectable>{t('labs.extractionSanitizedPreviewError')}</AppText>
        <AppButton
          label={t('labs.retry')}
          onPress={() => {
            setFailed(false);
            setAttempt((current) => current + 1);
          }}
          tone="secondary"
        />
      </View>
    );
  }

  if (uri === null) return <AppText style={styles.loading}>{t('labs.loading')}</AppText>;

  const box = route.params.boundingBox;
  return (
    <ScrollView
      contentContainerStyle={styles.content}
      contentInsetAdjustmentBehavior="automatic"
      maximumZoomScale={5}
      minimumZoomScale={1}
    >
      <View
        accessible
        accessibilityLabel={`${t('labs.extractionSourceRegionLabel')} ${route.params.pageIndex + 1}`}
        style={styles.page}
      >
        <Image
          accessibilityLabel={`${t('labs.sanitizedExactCanvas')} ${route.params.pageIndex + 1}`}
          resizeMode="contain"
          source={{ uri }}
          style={styles.image}
        />
        <View
          pointerEvents="none"
          style={[
            styles.region,
            {
              height: `${box.height * 100}%`,
              left: `${box.x * 100}%`,
              top: `${box.y * 100}%`,
              width: `${box.width * 100}%`,
            },
          ]}
        />
      </View>
      <AppText selectable style={styles.caption}>
        {t('labs.extractionSanitizedRegion')
          .replace('{page}', String(route.params.pageIndex + 1))
          .replace('{x}', box.x.toFixed(3))
          .replace('{y}', box.y.toFixed(3))}
      </AppText>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { padding: spacing.lg },
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    padding: spacing.lg,
  },
  content: { gap: spacing.md, padding: spacing.lg },
  page: { minHeight: 560, position: 'relative', width: '100%' },
  image: { height: 560, width: '100%' },
  region: {
    backgroundColor: 'rgba(40, 107, 102, 0.14)',
    borderColor: colors.accent,
    borderCurve: 'continuous',
    borderRadius: 4,
    borderWidth: 3,
    position: 'absolute',
  },
  caption: { color: colors.mutedInk },
});

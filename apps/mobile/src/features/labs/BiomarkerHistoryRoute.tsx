import { useCallback, useLayoutEffect, useState } from 'react';
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type LayoutChangeEvent,
} from 'react-native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useFocusEffect, useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import {
  formatLocaleDate,
  formatLocaleDecimal,
  type MeasuredTrendNonPoint,
  type MeasurementSnapshot,
  type SpecimenType,
} from '@alyte/domain';
import type { LabsStackParamList } from '../../navigation/types';
import { useServices } from '../../services';
import { t } from '../../localization';
import { colors, radii, screenStyles, spacing, typography } from '../../theme';
import {
  AppButton,
  AppSurface,
  AppText,
  ScreenScrollView,
  ScreenStatusView,
  StatusPill,
} from '../../ui/primitives';
import {
  buildBiomarkerHistoryViewModel,
  buildHistoryAccessibilityLabel,
  formatNormalizedTrendValue,
  getHistoryChartConnections,
  getHistoryChartLayout,
  getHistoryTimelineLayout,
  historyPointValuePresentation,
  type BiomarkerHistoryViewModel,
  type HistoryAccessibilityCopy,
  type HistoryChartLayout,
  type HistoryGuidanceItem,
  type HistoryTimelineItem,
  type HistoryTimelineLayout,
} from './biomarker-history-model';

type Navigation = NativeStackNavigationProp<LabsStackParamList>;
type HistoryRoute = RouteProp<LabsStackParamList, 'BiomarkerHistory'>;

const directionKey: Record<BiomarkerHistoryViewModel['trend']['direction'], string> = {
  increased: 'labs.historyDirectionIncreased',
  decreased: 'labs.historyDirectionDecreased',
  stable: 'labs.historyDirectionStable',
  'not-comparable': 'labs.historyDirectionNotComparable',
};

const nonPointKey: Record<MeasuredTrendNonPoint['kind'], string> = {
  'not-measured': 'labs.historyNonPointNotMeasured',
  'date-missing': 'labs.historyNonPointDateMissing',
  bounded: 'labs.historyNonPointBounded',
  incompatible: 'labs.historyNonPointIncompatible',
  unsupported: 'labs.historyNonPointUnsupported',
};

const provenanceKey = {
  extracted: 'labs.provenance.extracted',
  'user-entered': 'labs.provenance.user_entered',
  'user-corrected': 'labs.provenance.user_corrected',
} as const;

function accessibilityCopy(): HistoryAccessibilityCopy {
  return {
    chart: t('labs.historyChartTitle'),
    measuredPoint: t('labs.historyMeasuredPoint'),
    current: t('labs.historyCurrentResult'),
    chartValue: t('labs.historyChartValue'),
    nonPoint: {
      'not-measured': t('labs.historyNonPointNotMeasured'),
      'date-missing': t('labs.historyNonPointDateMissing'),
      bounded: t('labs.historyNonPointBounded'),
      incompatible: t('labs.historyNonPointIncompatible'),
      unsupported: t('labs.historyNonPointUnsupported'),
    },
    date: t('labs.historyCollectionDate'),
    source: t('labs.historyOriginalSource'),
    sourceEntry: t('labs.historyOriginalEntry'),
    unit: t('labs.measurementUnit'),
    laboratoryInterval: t('labs.historyLaboratoryInterval'),
    laboratoryFlag: t('labs.historyLaboratoryFlag'),
    provenance: {
      extracted: t('labs.provenance.extracted'),
      'user-entered': t('labs.provenance.user_entered'),
      'user-corrected': t('labs.provenance.user_corrected'),
    },
    noValue: t('labs.historyNotProvided'),
  };
}

export function BiomarkerHistoryRoute() {
  const navigation = useNavigation<Navigation>();
  const route = useRoute<HistoryRoute>();
  const { labs } = useServices();
  const [model, setModel] = useState<BiomarkerHistoryViewModel | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(false);
    try {
      const records = await labs.listRecords();
      setModel(buildBiomarkerHistoryViewModel(records, route.params.biomarkerId));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [labs, route.params.biomarkerId]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  useLayoutEffect(() => {
    navigation.setOptions({
      title: model?.canonicalLabel ?? t('labs.biomarkerHistoryTitle'),
    });
  }, [model?.canonicalLabel, navigation]);

  if (loading) {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.fixedStatus}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText selectable>{t('labs.historyLoading')}</AppText>
      </ScreenStatusView>
    );
  }
  if (error) {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.fixedStatus}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppSurface tone="soft" style={styles.errorSurface}>
          <AppText variant="heading" selectable>
            {t('labs.historyErrorTitle')}
          </AppText>
          <AppText selectable style={styles.secondary}>
            {t('labs.historyErrorBody')}
          </AppText>
          <AppButton label={t('labs.historyRetry')} onPress={() => void load()} tone="secondary" />
        </AppSurface>
      </ScreenStatusView>
    );
  }
  if (model === null) {
    return (
      <ScreenStatusView
        contentContainerStyle={styles.fixedStatus}
        style={screenStyles.scroll}
        tabBarClearance="native"
      >
        <AppText selectable>{t('labs.historyNotFound')}</AppText>
        <AppButton
          label={t('accessibility.back')}
          onPress={() => navigation.goBack()}
          tone="quiet"
        />
      </ScreenStatusView>
    );
  }

  return <BiomarkerHistoryScreen model={model} />;
}

function BiomarkerHistoryScreen({ model }: { readonly model: BiomarkerHistoryViewModel }) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  // Keep the useful explanation in the first read. Catalogue and source metadata remains
  // available, but should not compete with the measured history by default.
  const [explanationDetailsOpen, setExplanationDetailsOpen] = useState(false);
  const [generalGuidanceOpen, setGeneralGuidanceOpen] = useState(false);
  const { fontScale } = useWindowDimensions();
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const accessibilityLabel = buildHistoryAccessibilityLabel(model, accessibilityCopy());
  const timelineLayout = getHistoryTimelineLayout(fontScale);
  const chartLayout = getHistoryChartLayout(fontScale);
  const latestMeasured = [...model.timeline].reverse().find((item) => item.kind === 'point');
  const latestMeasuredValues =
    latestMeasured?.kind === 'point'
      ? historyPointValuePresentation(latestMeasured.point, latestMeasured.current, locale)
      : null;
  const latestOriginalSource =
    latestMeasured?.kind === 'point' ? originalSourceFact(latestMeasured) : null;
  // A report that did not contain this biomarker still breaks the chart segment in the domain
  // model, but repeating one empty row per report makes the visible history harder to understand.
  // Keep actual values and genuine exceptions in the timeline; the chart remains gap-aware.
  const visibleTimeline = model.timeline.filter(
    (item) => item.kind === 'point' || item.nonPoint.kind !== 'not-measured',
  );
  const toggle = (key: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <ScreenScrollView
      contentContainerStyle={styles.content}
      style={screenStyles.scroll}
      tabBarClearance="native"
    >
      {latestMeasured?.kind === 'point' && (
        <View style={styles.latestMeasuredGroup}>
          <AppSurface style={styles.latestMeasuredSurface}>
            <View style={styles.latestMeasuredHeader}>
              <StatusPill tone="measured">{t('labs.historyMeasuredPoint')}</StatusPill>
              <AppText style={styles.latestMeasuredDate} variant="caption">
                {formatLocaleDate(latestMeasured.point.collectionDate, locale)}
              </AppText>
            </View>
            <AppText selectable style={styles.latestMeasuredValue} variant="display">
              {latestMeasuredValues?.result}
            </AppText>
            {latestMeasuredValues !== null && latestMeasuredValues.chartValue !== null && (
              <AppText selectable style={styles.latestMeasuredConversion} variant="caption">
                {t('labs.historyChartUsesValue').replace(
                  '{value}',
                  latestMeasuredValues.chartValue,
                )}
              </AppText>
            )}
          </AppSurface>
          <AppSurface style={styles.latestFacts}>
            <Fact
              label={t('labs.historyLaboratoryInterval')}
              value={latestMeasured.laboratoryReference.interval ?? t('labs.historyNotProvided')}
            />
            <Fact
              label={t('labs.historyProvenance')}
              value={
                latestMeasured.provenance === null
                  ? t('labs.historyNotProvided')
                  : t(provenanceKey[latestMeasured.provenance])
              }
            />
            {latestOriginalSource !== null && (
              <Fact label={latestOriginalSource.label} value={latestOriginalSource.value} />
            )}
          </AppSurface>
        </View>
      )}
      <View style={styles.statusBlock}>
        <AppText variant="label" selectable style={styles.secondary}>
          {t('labs.historyDirection')}
        </AppText>
        <StatusPill tone={model.trend.direction === 'not-comparable' ? 'neutral' : 'measured'}>
          {t(directionKey[model.trend.direction])}
        </StatusPill>
      </View>

      <View style={styles.section}>
        <AppText variant="heading" selectable>
          {t('labs.historyChartTitle')}
        </AppText>
        <AppText selectable style={styles.secondary}>
          {t('labs.historyChartDescription')}
        </AppText>
        <MeasuredTrendChart
          accessibilityLabel={accessibilityLabel}
          layout={chartLayout}
          locale={locale}
          model={model}
        />
      </View>

      <View style={styles.section}>
        <AppText variant="heading" selectable>
          {t('labs.historyTimelineTitle')}
        </AppText>
        <View style={styles.timeline}>
          {visibleTimeline.map((item, index) => {
            const key = timelineKey(item, index);
            return (
              <HistoryTimelineRow
                item={item}
                key={key}
                locale={locale}
                expanded={expanded.has(key)}
                layout={timelineLayout}
                onToggle={() => toggle(key)}
              />
            );
          })}
        </View>
        {visibleTimeline.length === 0 && (
          <AppSurface tone="soft">
            <AppText selectable>{t('labs.historyEmptyTitle')}</AppText>
            <AppText selectable style={styles.secondary}>
              {t('labs.historyEmptyBody')}
            </AppText>
          </AppSurface>
        )}
      </View>

      {model.explanation !== null ? (
        <View style={styles.section}>
          <View style={styles.educationHeading}>
            <AppText variant="heading" selectable>
              {t('labs.historyExplanation')}
            </AppText>
            {model.explanation !== null && (
              <StatusPill tone="evidenceBacked">{t('labs.historyReviewedContent')}</StatusPill>
            )}
          </View>
          <AppSurface style={styles.factsSurface}>
            <AppText selectable>{model.explanation}</AppText>
            <Pressable
              accessibilityLabel={t(
                explanationDetailsOpen ? 'labs.historyHideDetails' : 'labs.historyShowDetails',
              )}
              accessibilityRole="button"
              accessibilityState={{ expanded: explanationDetailsOpen }}
              onPress={() => setExplanationDetailsOpen((current) => !current)}
              style={({ pressed }) => [styles.disclosureButton, pressed && styles.pressed]}
            >
              <AppText variant="label" style={styles.linkLabel}>
                {t(explanationDetailsOpen ? 'labs.historyHideDetails' : 'labs.historyShowDetails')}
              </AppText>
            </Pressable>
            {explanationDetailsOpen && (
              <View style={styles.details}>
                <AppText variant="label" selectable>
                  {t('labs.historySources')}
                </AppText>
                <Fact
                  label={t('labs.historyCatalogueVersion')}
                  value={model.catalogueVersion ?? t('labs.historyNotProvided')}
                />
                <Fact
                  label={t('labs.historyContentVersion')}
                  value={model.contentVersion ?? t('labs.historyNotProvided')}
                />
                {model.sources.length > 0 ? (
                  model.sources.map((source) => (
                    <View key={source.id} style={styles.factGroup}>
                      <AppText selectable>{source.title}</AppText>
                      <AppText selectable style={styles.secondary}>
                        {source.publisher}
                      </AppText>
                      <AppText selectable style={styles.linkLabel}>
                        {source.url}
                      </AppText>
                    </View>
                  ))
                ) : (
                  <AppText selectable style={styles.secondary}>
                    {t('labs.historyNotProvided')}
                  </AppText>
                )}
              </View>
            )}
          </AppSurface>
        </View>
      ) : null}

      {model.guidance.kind === 'applicable' && (
        <View style={styles.section}>
          <AppText variant="heading" selectable>
            {t('labs.historyGeneralGuidance')}
          </AppText>
          <>
            <AppSurface tone="soft" style={styles.factsSurface}>
              <AppText selectable style={styles.secondary}>
                {t('labs.historyGeneralGuidanceBody')}
              </AppText>
              <Pressable
                accessibilityHint={t('labs.historyGuidanceDisclosureHint')}
                accessibilityLabel={t(
                  generalGuidanceOpen
                    ? 'labs.historyHideGuidanceDetails'
                    : 'labs.historyShowGuidanceDetails',
                )}
                accessibilityRole="button"
                accessibilityState={{ expanded: generalGuidanceOpen }}
                onPress={() => setGeneralGuidanceOpen((current) => !current)}
                style={({ pressed }) => [styles.disclosureButton, pressed && styles.pressed]}
              >
                <AppText variant="label" style={styles.linkLabel}>
                  {t(
                    generalGuidanceOpen
                      ? 'labs.historyHideGuidanceDetails'
                      : 'labs.historyShowGuidanceDetails',
                  )}
                </AppText>
              </Pressable>
            </AppSurface>
            {generalGuidanceOpen && (
              <AppSurface style={styles.factsSurface}>
                {model.guidance.items.map((guidance) => (
                  <GuidanceDetails guidance={guidance} key={guidance.id} locale={locale} />
                ))}
              </AppSurface>
            )}
          </>
        </View>
      )}
    </ScreenScrollView>
  );
}

function timelineKey(item: HistoryTimelineItem, index: number): string {
  return `${item.kind}-${item.kind === 'point' ? item.point.measurementId : item.nonPoint.labRecordId}-${index}`;
}

function snapshotText(snapshot: MeasurementSnapshot, locale: string): string {
  const value =
    snapshot.value.kind === 'numeric'
      ? formatLocaleDecimal(snapshot.value.value, locale)
      : snapshot.value.kind === 'bounded'
        ? `${snapshot.value.comparator}${formatLocaleDecimal(snapshot.value.value, locale)}`
        : snapshot.value.value;
  return `${snapshot.label}: ${value}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
}

function originalSourceText(snapshot: MeasurementSnapshot | null): string {
  if (snapshot === null) return '';
  return `${snapshot.label}: ${snapshot.valueString}${snapshot.unit ? ` ${snapshot.unit}` : ''}`;
}

function originalSourceFact(item: HistoryTimelineItem): { label: string; value: string } | null {
  const value = originalSourceText(item.original);
  if (value.length === 0 || item.provenance === null || item.provenance === 'user-entered') {
    return null;
  }
  return {
    label: t(
      item.provenance === 'extracted' || item.sourceLocation !== null
        ? 'labs.historyOriginalSource'
        : 'labs.historyOriginalEntry',
    ),
    value,
  };
}

function reviewedDate(value: string | null, locale: string): string {
  return value !== null && /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? formatLocaleDate(value, locale)
    : (value ?? t('labs.historyNotProvided'));
}

function specimenLabel(value: SpecimenType): string {
  return t(`labs.specimen.${value}`);
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function GuidanceDetails({
  guidance,
  locale,
}: {
  readonly guidance: HistoryGuidanceItem;
  readonly locale: string;
}) {
  const sexLabel = t(`labs.historyGuidanceSex${capitalize(guidance.applicability.sex)}`);
  const fastingLabel = t(
    `labs.historyGuidanceFasting${capitalize(guidance.applicability.fasting.replace('-', ''))}`,
  );
  return (
    <View style={styles.factGroup}>
      <AppText variant="label" selectable>
        {guidance.label}
      </AppText>
      <AppText selectable>{guidance.description}</AppText>
      <Fact
        label={t('labs.historyValue')}
        value={guidance.thresholds
          .map(
            (threshold) =>
              `${threshold.operator} ${formatLocaleDecimal(threshold.value, locale)} ${threshold.unit}`,
          )
          .join(' · ')}
      />
      <Fact label={t('labs.historyGuidanceAuthority')} value={guidance.authority} />
      <View style={styles.applicabilityFacts}>
        <AppText variant="label" selectable style={styles.secondary}>
          {t('labs.historyGuidanceApplicability')}
        </AppText>
        <AppText selectable>{t('labs.historyGuidancePopulationAdults')}</AppText>
        <Fact
          label={t('labs.historyGuidanceJurisdiction')}
          value={guidance.applicability.jurisdiction}
        />
        <Fact label={t('labs.historyGuidancePurpose')} value={t('labs.historyGuidanceScreening')} />
        <Fact label={t('labs.historyGuidanceSex')} value={sexLabel} />
        <Fact label={t('labs.historyGuidanceFasting')} value={fastingLabel} />
      </View>
      <View style={styles.applicabilityFacts}>
        <AppText variant="label" selectable style={styles.secondary}>
          {t('labs.historyGuidanceLimitations')}
        </AppText>
        {guidance.applicability.limitations.length > 0 ? (
          guidance.applicability.limitations.map((limitation) => (
            <AppText key={limitation} selectable>
              {limitation}
            </AppText>
          ))
        ) : (
          <AppText selectable>{t('labs.historyNotProvided')}</AppText>
        )}
      </View>
      {guidance.disagreement !== null && (
        <Fact label={t('labs.historyGuidanceDisagreement')} value={guidance.disagreement} />
      )}
      <Fact
        label={t('labs.historyCatalogueVersion')}
        value={guidance.catalogueVersion ?? t('labs.historyNotProvided')}
      />
      <Fact label={t('labs.historyContentVersion')} value={guidance.review.contentVersion} />
      <Fact label={t('labs.historyGuidancePublication')} value={guidance.publicationVersion} />
      <Fact
        label={t('labs.historyGuidanceReviewed')}
        value={reviewedDate(guidance.review.reviewedAt ?? guidance.reviewDate, locale)}
      />
      <Fact
        label={t('labs.historyGuidanceReviewer')}
        value={guidance.review.reviewer ?? t('labs.historyNotProvided')}
      />
      <AppText variant="label" selectable>
        {t('labs.historySources')}
      </AppText>
      {guidance.sourceDetails.length > 0 ? (
        guidance.sourceDetails.map((source) => (
          <View key={source.id} style={styles.sourceRow}>
            <AppText selectable>{source.title}</AppText>
            <AppText selectable style={styles.secondary}>
              {source.publisher}
            </AppText>
            <AppText selectable style={styles.linkLabel}>
              {source.url}
            </AppText>
          </View>
        ))
      ) : (
        <AppText selectable style={styles.secondary}>
          {t('labs.historyNotProvided')}
        </AppText>
      )}
    </View>
  );
}

function HistoryTimelineRow({
  item,
  locale,
  expanded,
  layout,
  onToggle,
}: {
  readonly item: HistoryTimelineItem;
  readonly locale: string;
  readonly expanded: boolean;
  readonly layout: HistoryTimelineLayout;
  readonly onToggle: () => void;
}) {
  if (item.kind === 'point') {
    const values = historyPointValuePresentation(item.point, item.current, locale);
    const current = snapshotText(item.current, locale);
    const source = originalSourceFact(item);
    return (
      <View style={styles.timelineRow}>
        <View style={styles.timelineMarker} />
        <View style={styles.timelineCopy}>
          <View style={[styles.rowHeader, layout === 'stacked' && styles.rowHeaderStacked]}>
            <AppText variant="heading" selectable style={styles.rowHeaderTitle}>
              {values.result}
            </AppText>
            <StatusPill tone="measured">{t('labs.historyMeasuredPoint')}</StatusPill>
          </View>
          <AppText selectable style={styles.secondary}>
            {formatLocaleDate(item.point.collectionDate, locale)}
          </AppText>
          {values.chartValue !== null && (
            <AppText selectable style={styles.secondary} variant="caption">
              {t('labs.historyChartUsesValue').replace('{value}', values.chartValue)}
            </AppText>
          )}
          <Pressable
            accessibilityLabel={t(expanded ? 'labs.historyHideDetails' : 'labs.historyShowDetails')}
            accessibilityRole="button"
            accessibilityState={{ expanded }}
            onPress={onToggle}
            style={({ pressed }) => [styles.disclosureButton, pressed && styles.pressed]}
          >
            <AppText variant="label" style={styles.linkLabel}>
              {t(expanded ? 'labs.historyHideDetails' : 'labs.historyShowDetails')}
            </AppText>
          </Pressable>
          {expanded && (
            <View style={styles.details}>
              <Fact label={t('labs.historyCurrentResult')} value={current} />
              {source !== null && <Fact label={source.label} value={source.value} />}
              <Fact
                label={t('labs.historyLaboratoryInterval')}
                value={item.point.laboratoryReference.interval ?? t('labs.historyNotProvided')}
              />
              <Fact
                label={t('labs.historyLaboratoryFlag')}
                value={item.point.laboratoryReference.flag ?? t('labs.historyNotProvided')}
              />
              <Fact
                label={t('labs.historySpecimen')}
                value={specimenLabel(item.point.specimenType)}
              />
              <Fact
                label={t('labs.historyProvenance')}
                value={
                  item.provenance === null
                    ? t('labs.historyNotProvided')
                    : t(provenanceKey[item.provenance])
                }
              />
              <Fact
                label={t('labs.historySourceLocation')}
                value={
                  item.sourceLocation === null
                    ? t('labs.historyNotProvided')
                    : t('labs.historySourcePage').replace(
                        '{page}',
                        String(item.sourceLocation.pageIndex + 1),
                      )
                }
              />
            </View>
          )}
        </View>
      </View>
    );
  }

  const date =
    item.nonPoint.collectionDate.kind === 'known'
      ? formatLocaleDate(item.nonPoint.collectionDate.value, locale)
      : t('labs.historyNonPointDateMissing');
  const current = item.current === null ? null : snapshotText(item.current, locale);
  const source = originalSourceFact(item);
  const interval = item.laboratoryReference.interval ?? t('labs.historyNotProvided');
  const flag = item.laboratoryReference.flag ?? t('labs.historyNotProvided');
  return (
    <View style={styles.timelineRow}>
      <View style={[styles.timelineMarker, styles.nonPointMarker]} />
      <View style={styles.timelineCopy}>
        <View style={[styles.rowHeader, layout === 'stacked' && styles.rowHeaderStacked]}>
          <AppText variant="heading" selectable style={styles.rowHeaderTitle}>
            {t(nonPointKey[item.nonPoint.kind])}
          </AppText>
          <StatusPill tone="neutral">{t('labs.historyContextNotPoint')}</StatusPill>
        </View>
        <AppText selectable style={styles.secondary}>
          {date}
        </AppText>
        <Pressable
          accessibilityLabel={t(expanded ? 'labs.historyHideDetails' : 'labs.historyShowDetails')}
          accessibilityRole="button"
          accessibilityState={{ expanded }}
          onPress={onToggle}
          style={({ pressed }) => [styles.disclosureButton, pressed && styles.pressed]}
        >
          <AppText variant="label" style={styles.linkLabel}>
            {t(expanded ? 'labs.historyHideDetails' : 'labs.historyShowDetails')}
          </AppText>
        </Pressable>
        {expanded && (
          <View style={styles.details}>
            <Fact
              label={t('labs.historyCurrentResult')}
              value={current ?? t('labs.historyNotProvided')}
            />
            {source !== null && <Fact label={source.label} value={source.value} />}
            <Fact label={t('labs.historyLaboratoryInterval')} value={interval} />
            <Fact label={t('labs.historyLaboratoryFlag')} value={flag} />
            <Fact
              label={t('labs.historyProvenance')}
              value={
                item.provenance === null
                  ? t('labs.historyNotProvided')
                  : t(provenanceKey[item.provenance])
              }
            />
            <Fact
              label={t('labs.historySourceLocation')}
              value={
                item.sourceLocation === null
                  ? t('labs.historyNotProvided')
                  : t('labs.historySourcePage').replace(
                      '{page}',
                      String(item.sourceLocation.pageIndex + 1),
                    )
              }
            />
          </View>
        )}
      </View>
    </View>
  );
}

function Fact({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <View style={styles.fact}>
      <AppText variant="label" selectable style={styles.secondary}>
        {label}
      </AppText>
      <AppText selectable>{value}</AppText>
    </View>
  );
}

function MeasuredTrendChart({
  model,
  accessibilityLabel,
  layout,
  locale,
}: {
  readonly model: BiomarkerHistoryViewModel;
  readonly accessibilityLabel: string;
  readonly layout: HistoryChartLayout;
  readonly locale: string;
}) {
  const [width, setWidth] = useState(0);
  const points = model.trend.points;
  const { chartHeight, plotPadding, axisLabelInset } = layout;
  const innerWidth = Math.max(1, width - plotPadding * 2);
  const innerHeight = Math.max(1, chartHeight - plotPadding * 2);
  const values = points.map((point) => point.normalized.value);
  const minimum = values.length > 0 ? Math.min(...values) : 0;
  const maximum = values.length > 0 ? Math.max(...values) : 1;
  const range = maximum - minimum || 1;
  const coordinates = new Map(
    points.map((point, index) => {
      const x =
        plotPadding +
        (points.length <= 1 ? innerWidth / 2 : (index / (points.length - 1)) * innerWidth);
      const y = plotPadding + (1 - (point.normalized.value - minimum) / range) * innerHeight;
      return [point.measurementId, { x, y }] as const;
    }),
  );
  const onLayout = (event: LayoutChangeEvent) => setWidth(event.nativeEvent.layout.width);

  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={accessibilityLabel}
      onLayout={onLayout}
      style={[styles.chart, { height: chartHeight }]}
    >
      <View pointerEvents="none" style={StyleSheet.absoluteFill}>
        {points.length > 0 && (
          <>
            <AppText
              accessibilityElementsHidden
              accessible={false}
              selectable={false}
              style={[
                styles.chartAxisLabel,
                styles.chartAxisTop,
                { left: axisLabelInset, right: axisLabelInset },
              ]}
            >
              {`${formatNormalizedTrendValue(maximum, locale)} ${points[0]?.normalized.unit ?? ''}`}
            </AppText>
            <AppText
              accessibilityElementsHidden
              accessible={false}
              selectable={false}
              style={[
                styles.chartAxisLabel,
                styles.chartAxisBottom,
                { left: axisLabelInset, right: axisLabelInset },
              ]}
            >
              {`${formatNormalizedTrendValue(minimum, locale)} ${points[0]?.normalized.unit ?? ''}`}
            </AppText>
          </>
        )}
        {getHistoryChartConnections(model.trend.segments).flatMap(([startPoint, endPoint]) => {
          const start = coordinates.get(startPoint.measurementId);
          const end = coordinates.get(endPoint.measurementId);
          if (start === undefined || end === undefined) return [];
          const dx = end.x - start.x;
          const dy = end.y - start.y;
          const length = Math.sqrt(dx * dx + dy * dy);
          const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
          return [
            <View
              key={`line-${startPoint.measurementId}-${endPoint.measurementId}`}
              style={[
                styles.chartLine,
                {
                  left: (start.x + end.x - length) / 2,
                  top: (start.y + end.y) / 2 - 1,
                  transform: [{ rotate: `${angle}deg` }],
                  width: length,
                },
              ]}
            />,
          ];
        })}
        {points.map((point) => {
          const coordinate = coordinates.get(point.measurementId);
          if (coordinate === undefined) return null;
          return (
            <View
              accessible={false}
              key={`point-${point.measurementId}`}
              style={[styles.chartPoint, { left: coordinate.x - 6, top: coordinate.y - 6 }]}
            />
          );
        })}
        {points.length === 0 && (
          <View style={styles.chartEmpty}>
            <AppText selectable>{t('labs.historyEmptyTitle')}</AppText>
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: {
    gap: spacing.lg,
    paddingBottom: 140,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
  },
  fixedStatus: {
    alignItems: 'center',
    gap: spacing.md,
    justifyContent: 'center',
    padding: spacing.lg,
  },
  statusBlock: { gap: spacing.sm, paddingTop: spacing.sm },
  latestMeasuredGroup: { gap: spacing.sm },
  latestMeasuredSurface: { gap: spacing.md, padding: spacing.lg },
  latestMeasuredHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  latestMeasuredDate: { color: colors.mutedInk },
  latestMeasuredValue: { color: colors.ink, fontVariant: ['tabular-nums'] },
  latestMeasuredConversion: { color: colors.mutedInk },
  latestFacts: {
    gap: spacing.md,
  },
  secondary: { color: colors.mutedInk },
  section: { gap: spacing.sm },
  educationHeading: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
  },
  errorSurface: { gap: spacing.sm },
  chart: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    overflow: 'hidden',
    position: 'relative',
    width: '100%',
  },
  chartLine: {
    backgroundColor: colors.accent,
    height: 2,
    position: 'absolute',
  },
  chartPoint: {
    backgroundColor: colors.accent,
    borderColor: colors.surface,
    borderRadius: radii.pill,
    borderWidth: 2,
    height: 12,
    position: 'absolute',
    width: 12,
  },
  chartAxisLabel: {
    ...typography.caption,
    color: colors.mutedInk,
    maxWidth: '100%',
    position: 'absolute',
    textAlign: 'right',
  },
  chartAxisTop: { top: spacing.sm },
  chartAxisBottom: { bottom: spacing.sm },
  chartEmpty: { alignItems: 'center', flex: 1, justifyContent: 'center' },
  timeline: { gap: spacing.sm },
  timelineRow: { flexDirection: 'row', gap: spacing.sm },
  timelineMarker: {
    backgroundColor: colors.accent,
    borderRadius: radii.pill,
    height: 12,
    marginTop: 6,
    width: 12,
  },
  nonPointMarker: { backgroundColor: colors.mutedInk, opacity: 0.7 },
  timelineCopy: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    borderWidth: StyleSheet.hairlineWidth,
    flex: 1,
    gap: spacing.xs,
    padding: spacing.md,
  },
  rowHeader: {
    alignItems: 'flex-start',
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'space-between',
  },
  rowHeaderStacked: {
    alignItems: 'stretch',
    flexDirection: 'column',
    justifyContent: 'flex-start',
  },
  rowHeaderTitle: { flexShrink: 1, minWidth: 0 },
  disclosureButton: {
    alignItems: 'flex-start',
    gap: spacing.xs,
    minHeight: 44,
    justifyContent: 'center',
  },
  linkLabel: { color: colors.accent },
  pressed: { opacity: 0.72 },
  details: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  factsSurface: { gap: spacing.md },
  applicabilityFacts: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  sourceRow: { gap: spacing.xs },
  factGroup: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  fact: { gap: spacing.xs },
});

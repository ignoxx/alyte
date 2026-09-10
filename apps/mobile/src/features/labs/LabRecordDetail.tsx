import { useContext, useState } from 'react';
import { BottomTabBarHeightContext } from '@react-navigation/bottom-tabs';
import { Pressable, SectionList, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  formatLocaleDate,
  type LabRecordDetail as Detail,
  type Measurement,
  type MeasurementValue,
  type SpecimenType,
} from '@alyte/domain';
import { t } from '../../localization';
import { colors, radii, spacing } from '../../theme';
import { AppButton, AppIcon, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { getScreenPlatformPolicy, getScreenScrollBottomInset } from '../../ui/screen-scroll-model';
import {
  correctionChangedFields,
  formatLabRecordMeasurementAccessibilityLabel,
  getLabRecordDetailRowLayout,
  labRecordSupportReasonLocalizationKeys,
  measurementValue,
  recordSections,
} from './record-detail-model';

type Props = {
  readonly detail: Detail;
  readonly loadError?: boolean;
  readonly onRetryLoad?: () => void;
  readonly onCorrect: (id: string) => void;
  readonly onDelete: (id?: string) => void;
  readonly onEditRecord: () => void;
  readonly onViewHistory: (biomarkerId: string) => void;
  readonly onViewSource: (item: Measurement) => void;
  readonly onRetrySource: () => void;
};

const supportReason = (item: Detail['measurements'][number]) =>
  item.support.kind === 'comparable-supported'
    ? t('labs.detailComparable')
    : t(labRecordSupportReasonLocalizationKeys[item.support.reason]);
const sourceLabel = (detail: Detail) =>
  t(`labs.sourceState.${detail.source.kind.replaceAll('-', '_')}`);
const screenPlatformPolicy = getScreenPlatformPolicy(process.env.EXPO_OS);

function specimenLabel(value: SpecimenType): string {
  return t(`labs.specimen.${value}`);
}

function valueTypeLabel(value: MeasurementValue['kind']): string {
  return t(
    value === 'numeric'
      ? 'labs.measurementNumeric'
      : value === 'bounded'
        ? 'labs.measurementBounded'
        : value === 'categorical'
          ? 'labs.measurementCategorical'
          : 'labs.measurementFreeText',
  );
}

function changedFieldLabel(value: string): string {
  const key =
    value === 'label'
      ? 'labs.detailFieldLabel'
      : value === 'value'
        ? 'labs.detailFieldValue'
        : value === 'unit'
          ? 'labs.detailFieldUnit'
          : value === 'referenceInterval'
            ? 'labs.detailFieldReference'
            : value === 'flag'
              ? 'labs.detailFieldFlag'
              : value === 'specimen'
                ? 'labs.detailFieldSpecimen'
                : value === 'reviewState'
                  ? 'labs.detailFieldReview'
                  : 'labs.detailFieldBiomarker';
  return t(key);
}

export function LabRecordDetail({
  detail,
  loadError = false,
  onRetryLoad,
  onCorrect,
  onDelete,
  onEditRecord,
  onViewHistory,
  onViewSource,
  onRetrySource,
}: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const { fontScale } = useWindowDimensions();
  const tabBarHeight = useContext(BottomTabBarHeightContext);
  const safeAreaInsets = useSafeAreaInsets();
  const rowLayout = getLabRecordDetailRowLayout(fontScale);
  const bottomInset = getScreenScrollBottomInset(
    tabBarHeight,
    safeAreaInsets.bottom,
    screenPlatformPolicy === 'ios-native-tabs' ? spacing.xxl : 0,
    screenPlatformPolicy === 'ios-native-tabs' ? 'automatic' : 'legacy',
  );
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const date =
    detail.collectionDate.kind === 'known'
      ? formatLocaleDate(detail.collectionDate.value, locale)
      : t('labs.recordDateMissing');
  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      contentInset={{ bottom: bottomInset }}
      scrollIndicatorInsets={{ bottom: bottomInset }}
      sections={recordSections(detail)}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <View style={styles.header}>
          {loadError && onRetryLoad !== undefined && (
            <AppSurface tone="soft" style={styles.inlineError}>
              <AppText variant="label">{t('labs.recordRefreshError')}</AppText>
              <AppButton label={t('labs.retry')} onPress={onRetryLoad} tone="secondary" />
            </AppSurface>
          )}
          <AppText selectable style={styles.secondary}>
            {date}
          </AppText>
          {detail.laboratoryName && <AppText selectable>{detail.laboratoryName}</AppText>}
          <AppSurface style={styles.summary}>
            <View
              style={[
                styles.summaryMetrics,
                rowLayout === 'stacked' && styles.summaryMetricsStacked,
              ]}
            >
              <SummaryMetric
                label={t('labs.detailResultsLabel')}
                value={detail.summary.measurementCount}
              />
              <SummaryMetric
                label={t('labs.detailFlaggedLabel')}
                value={detail.summary.flaggedCount}
              />
              <SummaryMetric
                label={t('labs.detailComparableLabel')}
                value={detail.summary.comparableCount}
              />
            </View>
            <AppText selectable style={styles.secondary}>
              {sourceLabel(detail)}
            </AppText>
          </AppSurface>
          <View style={styles.actions}>
            <AppButton label={t('labs.recordEditAction')} onPress={onEditRecord} tone="secondary" />
            <AppButton
              label={t('labs.detailDeletionAction')}
              onPress={() => onDelete()}
              tone="secondary"
            />
          </View>
          {(detail.source.kind === 'deletion-pending' ||
            detail.source.kind === 'deletion-failed') && (
            <AppButton
              label={t('labs.detailRetrySourceDeletion')}
              onPress={onRetrySource}
              tone="secondary"
            />
          )}
          {detail.measurements.length === 0 && (
            <AppText style={styles.secondary}>{t('labs.recordNoMeasurements')}</AppText>
          )}
        </View>
      }
      renderSectionHeader={({ section }) =>
        section.panel ? (
          <AppText variant="label" style={styles.section}>
            {section.panel}
          </AppText>
        ) : null
      }
      renderItem={({ item }) => {
        const open = expanded.has(item.id);
        const value = measurementValue(item, locale);
        const displayLabel = item.canonicalLabel ?? item.current.label;
        return (
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={formatLabRecordMeasurementAccessibilityLabel(
                displayLabel,
                supportReason(item),
                value,
                item.current.unit,
              )}
              onPress={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  open ? next.delete(item.id) : next.add(item.id);
                  return next;
                })
              }
              style={({ pressed }) => [
                styles.rowButton,
                rowLayout === 'stacked' && styles.rowButtonStacked,
                pressed && styles.pressed,
              ]}
            >
              <View
                style={[styles.rowContent, rowLayout === 'stacked' && styles.rowContentStacked]}
              >
                <View style={[styles.rowCopy, rowLayout === 'stacked' && styles.rowCopyStacked]}>
                  <AppText selectable variant="heading">
                    {displayLabel}
                  </AppText>
                </View>
                <View style={[styles.value, rowLayout === 'stacked' && styles.valueStacked]}>
                  <AppText
                    selectable
                    variant="heading"
                    style={[styles.numerals, rowLayout === 'stacked' && styles.numeralsStacked]}
                  >
                    {value}
                  </AppText>
                  {item.current.unit && (
                    <AppText selectable style={styles.secondary}>
                      {item.current.unit}
                    </AppText>
                  )}
                </View>
              </View>
              <AppIcon
                color={colors.mutedInk}
                name="chevronRight"
                size={16}
                style={[
                  rowLayout === 'stacked' && styles.disclosureStacked,
                  { transform: [{ rotate: open ? '90deg' : '0deg' }] },
                ]}
              />
            </Pressable>
            {open && (
              <MeasurementDetails
                detail={detail}
                measurement={item}
                onCorrect={onCorrect}
                onDelete={onDelete}
                onViewHistory={onViewHistory}
                onViewSource={onViewSource}
              />
            )}
          </View>
        );
      }}
    />
  );
}

function MeasurementDetails({
  detail,
  measurement,
  onCorrect,
  onDelete,
  onViewHistory,
  onViewSource,
}: {
  detail: Detail;
  measurement: Detail['measurements'][number];
  onCorrect: (id: string) => void;
  onDelete: (id: string) => void;
  onViewHistory: (biomarkerId: string) => void;
  onViewSource: (item: Measurement) => void;
}) {
  const sourceAvailable = detail.source.kind === 'retained' && measurement.source !== null;
  const [showMoreDetails, setShowMoreDetails] = useState(false);
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const sourceLocation = measurement.source
    ? t('labs.detailPageRegion').replace('{page}', String(measurement.source.pageIndex + 1))
    : t('labs.detailNoSourceLocation');
  return (
    <View style={styles.details}>
      <StatusPill
        tone={
          measurement.provenance === 'extracted'
            ? 'extracted'
            : measurement.provenance === 'user-corrected'
              ? 'userCorrected'
              : 'userEntered'
        }
      >
        {t(`labs.provenance.${measurement.provenance.replaceAll('-', '_')}`)}
      </StatusPill>
      {measurement.current.referenceInterval !== null && (
        <Fact
          label={t('labs.detailReferenceRange')}
          value={measurement.current.referenceInterval}
        />
      )}
      {measurement.current.flag !== null && (
        <Fact label={t('labs.measurementFlag')} value={measurement.current.flag} />
      )}
      {measurement.support.kind !== 'comparable-supported' && (
        <Fact label={t('labs.detailSupport')} value={supportReason(measurement)} />
      )}
      {measurement.source !== null && (
        <Fact label={t('labs.detailSourceLocation')} value={sourceLocation} />
      )}
      <Pressable
        accessibilityLabel={
          showMoreDetails ? t('labs.measurementLessDetails') : t('labs.measurementMoreDetails')
        }
        accessibilityRole="button"
        accessibilityState={{ expanded: showMoreDetails }}
        onPress={() => setShowMoreDetails((current) => !current)}
        style={({ pressed }) => [styles.disclosure, pressed && styles.disclosurePressed]}
      >
        <AppText style={styles.disclosureLabel}>
          {showMoreDetails ? t('labs.measurementLessDetails') : t('labs.measurementMoreDetails')}
        </AppText>
        <AppIcon
          color={colors.accent}
          name="chevronRight"
          size={16}
          style={showMoreDetails ? styles.disclosureExpanded : undefined}
        />
      </Pressable>
      {showMoreDetails && (
        <View style={styles.secondaryDetails}>
          <Fact label={t('labs.detailOriginalLabel')} value={measurement.original.label} />
          <Fact
            label={t('labs.detailOriginalValue')}
            value={`${measurement.original.valueString}${measurement.original.unit ? ` ${measurement.original.unit}` : ''}`}
          />
          <Fact
            label={t('labs.measurementType')}
            value={valueTypeLabel(measurement.current.value.kind)}
          />
          <Fact
            label={t('labs.measurementSpecimen')}
            value={specimenLabel(measurement.specimenType)}
          />
          <Fact
            label={t('labs.recordDateLabel')}
            value={
              detail.collectionDate.kind === 'known'
                ? formatLocaleDate(detail.collectionDate.value, locale)
                : t('labs.recordDateMissing')
            }
          />
          <Fact
            label={t('labs.detailPanel')}
            value={measurement.panelLabel ?? t('labs.detailNotProvided')}
          />
          {[...measurement.corrections].reverse().map((correction) => (
            <View key={correction.id} style={styles.fact}>
              <AppText variant="label">{t('labs.detailCorrection')}</AppText>
              <Fact
                label={t('labs.detailCorrectionDate')}
                value={new Intl.DateTimeFormat(undefined, {
                  dateStyle: 'medium',
                  timeStyle: 'short',
                }).format(new Date(correction.correctedAt))}
              />
              <Fact
                label={t('labs.detailCorrectionReason')}
                value={correction.reason ?? t('labs.detailNotProvided')}
              />
              <Fact
                label={t('labs.detailChangedFields')}
                value={
                  correctionChangedFields(correction).map(changedFieldLabel).join(', ') ||
                  t('labs.detailNoFieldChanges')
                }
              />
              <Fact
                label={t('labs.detailBefore')}
                value={correctionSnapshotText(correction.previous)}
              />
              <Fact label={t('labs.detailAfter')} value={correctionSnapshotText(correction.next)} />
            </View>
          ))}
        </View>
      )}
      <View style={styles.actions}>
        {sourceAvailable && (
          <AppButton
            label={t('labs.extractionViewInReport')}
            onPress={() => onViewSource(measurement)}
            tone="secondary"
          />
        )}
        {measurement.reviewState === 'confirmed' && measurement.biomarkerId !== null && (
          <AppButton
            label={t('labs.historyView')}
            onPress={() => {
              if (measurement.biomarkerId !== null) onViewHistory(measurement.biomarkerId);
            }}
            tone="secondary"
          />
        )}
        <AppButton
          label={t('labs.measurementCorrect')}
          onPress={() => onCorrect(measurement.id)}
          tone="secondary"
        />
        <AppButton
          label={t('labs.detailDeleteMeasurement')}
          onPress={() => onDelete(measurement.id)}
          tone="quiet"
        />
      </View>
    </View>
  );
}

function correctionSnapshotText(value: Measurement['corrections'][number]['previous']): string {
  const snapshot = value.snapshot;
  return [
    `${t('labs.detailFieldLabel')}: ${snapshot.label}`,
    `${t('labs.detailFieldValue')}: ${snapshot.valueString}${snapshot.unit ? ` ${snapshot.unit}` : ''}`,
    snapshot.referenceInterval
      ? `${t('labs.detailFieldReference')}: ${snapshot.referenceInterval}`
      : null,
    snapshot.flag ? `${t('labs.detailFieldFlag')}: ${snapshot.flag}` : null,
    `${t('labs.detailFieldSpecimen')}: ${specimenLabel(value.specimenType)}`,
  ]
    .filter(Boolean)
    .join(' · ');
}

function SummaryMetric({ label, value }: { readonly label: string; readonly value: number }) {
  return (
    <View style={styles.summaryMetric}>
      <AppText selectable style={styles.summaryNumber} variant="heading">
        {value}
      </AppText>
      <AppText style={styles.secondary} variant="caption">
        {label}
      </AppText>
    </View>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <AppText style={styles.secondary}>{label}</AppText>
      <AppText selectable>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  header: { gap: spacing.md, paddingVertical: spacing.lg },
  summary: { gap: spacing.md },
  summaryMetrics: { flexDirection: 'row', gap: spacing.md },
  summaryMetricsStacked: { flexDirection: 'column' },
  summaryMetric: { flex: 1, gap: spacing.xs, minWidth: 0 },
  summaryNumber: { fontVariant: ['tabular-nums'] },
  inlineError: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  secondary: { color: colors.mutedInk },
  section: { color: colors.mutedInk, paddingBottom: spacing.sm, paddingTop: spacing.lg },
  row: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  rowButton: {
    flexDirection: 'row',
    minHeight: 64,
    alignItems: 'center',
    gap: spacing.sm,
    paddingVertical: spacing.sm,
  },
  rowButtonStacked: { alignItems: 'flex-start', paddingVertical: spacing.md },
  pressed: { backgroundColor: colors.accentSoft },
  rowContent: {
    alignItems: 'center',
    flex: 1,
    flexDirection: 'row',
    gap: spacing.md,
    minWidth: 0,
  },
  rowContentStacked: { alignItems: 'stretch', flexDirection: 'column', gap: spacing.xs },
  rowCopy: { flex: 1, gap: spacing.xs, minWidth: 0 },
  rowCopyStacked: { flex: 0 },
  value: { alignItems: 'flex-end', maxWidth: '40%' },
  valueStacked: { alignItems: 'stretch', gap: spacing.xs, maxWidth: '100%' },
  numerals: { fontVariant: ['tabular-nums'], textAlign: 'right' },
  numeralsStacked: { textAlign: 'left' },
  disclosureStacked: { marginTop: spacing.xs },
  details: {
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
    borderRadius: radii.md,
    gap: spacing.sm,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  secondaryDetails: {
    borderTopColor: colors.border,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    paddingTop: spacing.sm,
  },
  disclosure: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: spacing.xs,
    minHeight: 44,
    paddingVertical: spacing.xs,
  },
  disclosureLabel: { color: colors.accent, flex: 1 },
  disclosureExpanded: { transform: [{ rotate: '90deg' }] },
  disclosurePressed: { opacity: 0.7 },
  fact: { gap: spacing.xs },
});

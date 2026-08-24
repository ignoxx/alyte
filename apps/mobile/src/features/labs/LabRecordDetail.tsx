import { useState } from 'react';
import { Pressable, SectionList, StyleSheet, View } from 'react-native';
import { formatLocaleDate, type LabRecordDetail as Detail, type Measurement } from '@alyte/domain';
import { t } from '../../localization';
import { colors, spacing } from '../../theme';
import { AppButton, AppSurface, AppText, StatusPill } from '../../ui/primitives';
import { measurementValue, recordSections } from './record-detail-model';

type Props = {
  readonly detail: Detail;
  readonly onCorrect: (id: string) => void;
  readonly onDelete: (id?: string) => void;
  readonly onEditRecord: () => void;
  readonly onViewSource: (item: Measurement) => void;
};

const supportReason = (item: Detail['measurements'][number]) =>
  item.support.kind === 'comparable-supported'
    ? t('labs.detailComparable')
    : t(`labs.supportReason.${item.support.reason}`);
const sourceLabel = (detail: Detail) =>
  t(`labs.sourceState.${detail.source.kind.replaceAll('-', '_')}`);

export function LabRecordDetail({
  detail,
  onCorrect,
  onDelete,
  onEditRecord,
  onViewSource,
}: Props) {
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const locale = Intl.DateTimeFormat().resolvedOptions().locale;
  const date =
    detail.collectionDate.kind === 'known'
      ? formatLocaleDate(detail.collectionDate.value, locale)
      : t('labs.recordDateMissing');
  return (
    <SectionList
      contentInsetAdjustmentBehavior="automatic"
      contentContainerStyle={styles.content}
      sections={recordSections(detail)}
      keyExtractor={(item) => item.id}
      stickySectionHeadersEnabled={false}
      ListHeaderComponent={
        <View style={styles.header}>
          <AppText selectable style={styles.secondary}>
            {date}
          </AppText>
          {detail.laboratoryName && <AppText selectable>{detail.laboratoryName}</AppText>}
          <AppSurface style={styles.summary}>
            <AppText variant="heading">{t('labs.detailSummaryTitle')}</AppText>
            <AppText selectable>
              {t('labs.detailSummaryMeasurements').replace(
                '{count}',
                String(detail.summary.measurementCount),
              )}
            </AppText>
            <AppText selectable>
              {t('labs.detailSummaryFlags').replace('{count}', String(detail.summary.flaggedCount))}
            </AppText>
            <AppText selectable>
              {t('labs.detailSummarySupport')
                .replace('{supported}', String(detail.summary.comparableCount))
                .replace('{preserved}', String(detail.summary.preservedOnlyCount))}
            </AppText>
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
        return (
          <View style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open }}
              accessibilityLabel={`${item.current.label}, ${value}${item.current.unit ? ` ${item.current.unit}` : ''}`}
              onPress={() =>
                setExpanded((current) => {
                  const next = new Set(current);
                  open ? next.delete(item.id) : next.add(item.id);
                  return next;
                })
              }
              style={({ pressed }) => [styles.rowButton, pressed && styles.pressed]}
            >
              <View style={styles.rowCopy}>
                <AppText selectable variant="heading">
                  {item.current.label}
                </AppText>
                <AppText selectable style={styles.secondary}>
                  {supportReason(item)}
                </AppText>
              </View>
              <View style={styles.value}>
                <AppText selectable variant="heading" style={styles.numerals}>
                  {value}
                </AppText>
                {item.current.unit && (
                  <AppText selectable style={styles.secondary}>
                    {item.current.unit}
                  </AppText>
                )}
              </View>
            </Pressable>
            {open && (
              <MeasurementDetails
                detail={detail}
                measurement={item}
                onCorrect={onCorrect}
                onDelete={onDelete}
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
  onViewSource,
}: {
  detail: Detail;
  measurement: Detail['measurements'][number];
  onCorrect: (id: string) => void;
  onDelete: (id: string) => void;
  onViewSource: (item: Measurement) => void;
}) {
  const sourceAvailable = detail.source.kind === 'retained' && measurement.source !== null;
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
      <Fact
        label={t('labs.measurementOriginal')}
        value={`${measurement.original.valueString}${measurement.original.unit ? ` ${measurement.original.unit}` : ''}`}
      />
      <Fact label={t('labs.measurementType')} value={measurement.current.value.kind} />
      <Fact
        label={t('labs.measurementReference')}
        value={measurement.current.referenceInterval ?? t('labs.detailNotProvided')}
      />
      <Fact
        label={t('labs.measurementFlag')}
        value={measurement.current.flag ?? t('labs.detailNotProvided')}
      />
      <Fact label={t('labs.measurementSpecimen')} value={measurement.specimenType} />
      <Fact label={t('labs.detailSupport')} value={supportReason(measurement)} />
      <Fact
        label={t('labs.detailSourceLocation')}
        value={
          measurement.source
            ? t('labs.detailPageRegion').replace('{page}', String(measurement.source.pageIndex + 1))
            : t('labs.detailNoSourceLocation')
        }
      />
      {measurement.corrections.map((correction) => (
        <Fact
          key={correction.id}
          label={t('labs.detailCorrection')}
          value={`${correction.previous.snapshot.valueString} → ${correction.next.snapshot.valueString}`}
        />
      ))}
      <View style={styles.actions}>
        <AppButton
          disabled={!sourceAvailable}
          label={
            sourceAvailable ? t('labs.extractionViewInReport') : t('labs.detailSourceUnavailable')
          }
          onPress={() => onViewSource(measurement)}
          tone="secondary"
        />
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
function Fact({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.fact}>
      <AppText style={styles.secondary}>{label}</AppText>
      <AppText selectable>{value}</AppText>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: spacing.lg, paddingBottom: 120 },
  header: { gap: spacing.md, paddingVertical: spacing.lg },
  summary: { gap: spacing.sm },
  actions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  secondary: { color: colors.mutedInk },
  section: { color: colors.mutedInk, paddingBottom: spacing.sm, paddingTop: spacing.lg },
  row: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  rowButton: {
    flexDirection: 'row',
    minHeight: 64,
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
  },
  pressed: { backgroundColor: colors.accentSoft },
  rowCopy: { flex: 1, gap: spacing.xs },
  value: { alignItems: 'flex-end', maxWidth: '40%' },
  numerals: { fontVariant: ['tabular-nums'], textAlign: 'right' },
  details: {
    backgroundColor: colors.surface,
    borderCurve: 'continuous',
    borderRadius: 16,
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  fact: { gap: spacing.xs },
});

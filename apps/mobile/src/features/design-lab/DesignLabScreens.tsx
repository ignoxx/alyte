import SegmentedControl from '@expo/ui/community/segmented-control';
import { useContext, useEffect, useRef, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  TextInput,
  useWindowDimensions,
  View,
  type ScrollView as ScrollViewType,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { t } from '../../localization';
import { colors, spacing, typography } from '../../theme';
import { AppIcon, AppSurface, AppText, ScreenScrollView } from '../../ui/primitives';
import { DesignLabContext } from './context';
import {
  designLabDirections,
  formatSyntheticDate,
  formatSyntheticMeasurement,
  formatSyntheticNumber,
  syntheticMeasuredChanges,
  syntheticReports,
} from './model';
import { labAccents } from './theme';

function message(
  key: string,
  replacements: Readonly<Record<string, string | number>> = {},
): string {
  return Object.entries(replacements).reduce(
    (value, [name, replacement]) => value.replace(`{${name}}`, String(replacement)),
    t(key),
  );
}

const directionLabels = () => [
  t('designLab.directionQuiet'),
  t('designLab.directionTimeline'),
  t('designLab.directionLibrary'),
];

function LabSwitcher() {
  const lab = useContext(DesignLabContext);
  const directionIndex = designLabDirections.indexOf(lab.direction);
  const stateIndex = lab.state === 'empty' ? 0 : 1;
  return (
    <AppSurface accessibilityLabel={t('designLab.controls')} style={styles.switcher}>
      <SegmentedControl
        onChange={({ nativeEvent }) => {
          const direction = designLabDirections[nativeEvent.selectedSegmentIndex];
          if (direction !== undefined) lab.setDirection(direction);
        }}
        selectedIndex={directionIndex}
        style={styles.nativeControl}
        testID="design-lab-direction"
        values={directionLabels()}
      />
      <AppText style={styles.harnessLabel} variant="caption">
        {t('designLab.showcaseData')}
      </AppText>
      <SegmentedControl
        onChange={({ nativeEvent }) => {
          lab.setState(nativeEvent.selectedSegmentIndex === 0 ? 'empty' : 'two-reports');
        }}
        selectedIndex={stateIndex}
        style={styles.nativeControl}
        testID="design-lab-state"
        values={[t('designLab.stateEmpty'), t('designLab.stateTwoReports')]}
      />
    </AppSurface>
  );
}

function ImportButton({ onPress, label }: { onPress: () => void; label?: string }) {
  const { direction } = useContext(DesignLabContext);
  const resolvedLabel = label ?? t('designLab.importReport');
  return (
    <Pressable
      accessibilityLabel={resolvedLabel}
      accessibilityRole="button"
      onPress={onPress}
      style={({ pressed }) => [
        styles.importButton,
        { backgroundColor: labAccents[direction], opacity: pressed ? 0.72 : 1 },
      ]}
      testID="design-lab-import"
    >
      <AppIcon color={colors.onAccent} name="plus" size={17} />
      <AppText style={styles.importText}>{resolvedLabel}</AppText>
    </Pressable>
  );
}

function ReportRow({
  report = syntheticReports[0]!,
}: {
  report?: (typeof syntheticReports)[number];
}) {
  const { fontScale } = useWindowDimensions();
  const collected = formatSyntheticDate(report.collectedOn);
  const measurementCount = formatSyntheticNumber(report.measurements);
  return (
    <View
      accessibilityLabel={message('designLab.sourceReportAccessibility', {
        laboratory: report.laboratory,
        date: collected,
        count: measurementCount,
      })}
      style={[styles.reportRow, fontScale >= 1.6 && styles.largeTypeRow]}
    >
      <AppIcon name="doc" />
      <View style={styles.grow}>
        <AppText variant="heading">{report.laboratory}</AppText>
        <AppText style={styles.secondary}>
          {collected} · {message('designLab.measurementsCount', { count: measurementCount })}
        </AppText>
      </View>
      {fontScale < 1.6 && <AppIcon name="chevronRight" size={13} />}
    </View>
  );
}

function EmptyHome({ onImport }: { onImport: () => void }) {
  const { direction } = useContext(DesignLabContext);
  const titleKey = `designLab.${direction}EmptyTitle`;
  const bodyKey = `designLab.${direction}EmptyBody`;
  const icon = direction === 'library' ? 'library' : direction === 'timeline' ? 'clock' : 'doc';
  return (
    <View style={styles.empty}>
      <View style={styles.heroSymbol}>
        <AppIcon name={icon} size={30} />
      </View>
      <AppText style={styles.emptyTitle} variant="title">
        {t(titleKey)}
      </AppText>
      <AppText style={styles.emptyBody}>{t(bodyKey)}</AppText>
      <ImportButton onPress={onImport} />
    </View>
  );
}

function ChangeRows({ compact = false }: { compact?: boolean }) {
  const { fontScale } = useWindowDimensions();
  return syntheticMeasuredChanges.map((change) => {
    const unitLabel = t('designLab.unitMillimolesPerLiter');
    const latest = formatSyntheticMeasurement(change.latest, unitLabel);
    const previous = formatSyntheticMeasurement(change.previous, unitLabel);
    const direction = t(
      `designLab.direction${change.direction === 'increased' ? 'Increased' : 'Decreased'}`,
    );
    return (
      <View
        key={change.biomarkerKey}
        style={[
          compact ? styles.compactRow : styles.changeRow,
          compact && fontScale >= 1.6 && styles.largeTypeRow,
        ]}
      >
        <View style={styles.grow}>
          <AppText variant="heading">{t(change.biomarkerKey)}</AppText>
          {compact && (
            <AppText style={styles.secondary}>
              {message('designLab.compatibleMeasurements', {
                count: formatSyntheticNumber(syntheticReports.length),
              })}
            </AppText>
          )}
        </View>
        <View style={[styles.valueColumn, fontScale >= 1.6 && styles.largeTypeValue]}>
          <AppText selectable style={styles.value}>
            {latest}
          </AppText>
          <AppText style={styles.secondary}>
            {compact
              ? direction
              : message('designLab.fromValueDirection', { value: previous, direction })}
          </AppText>
        </View>
      </View>
    );
  });
}

function QuietHome({ onImport }: { onImport: () => void }) {
  const latest = syntheticReports[0]!;
  return (
    <View style={styles.sections}>
      <AppText style={styles.eyebrow} variant="caption">
        {t('designLab.latestReport')}
      </AppText>
      <AppText style={styles.heroDate} variant="display">
        {formatSyntheticDate(latest.collectedOn, undefined, 'long')}
      </AppText>
      <AppText style={styles.secondary}>
        {latest.laboratory} ·{' '}
        {message('designLab.measurementsCount', {
          count: formatSyntheticNumber(latest.measurements),
        })}
      </AppText>
      <View style={styles.rule} />
      <AppText variant="title">{t('designLab.measuredChanges')}</AppText>
      <ChangeRows />
      <AppText variant="title">{t('designLab.recentReports')}</AppText>
      {syntheticReports.map((report) => (
        <ReportRow key={report.id} report={report} />
      ))}
      <ImportButton label={t('designLab.importAnother')} onPress={onImport} />
    </View>
  );
}

function TimelineHome({ onImport }: { onImport: () => void }) {
  const accent = labAccents.timeline;
  return (
    <View style={styles.sections}>
      <AppText style={styles.lede} variant="title">
        {message('designLab.timelineSummary', {
          count: formatSyntheticNumber(syntheticReports.length),
        })}
      </AppText>
      {syntheticReports.map((report, index) => (
        <View key={report.id} style={styles.timelineRow}>
          <View style={styles.timelineRail}>
            <View style={[styles.timelineDot, { backgroundColor: accent }]} />
            {index === 0 && <View style={styles.timelineLine} />}
          </View>
          <View style={styles.timelineContent}>
            <AppText style={styles.eyebrow} variant="caption">
              {index === 0 ? `${t('designLab.latest')} · ` : ''}
              {formatSyntheticDate(report.collectedOn)}
            </AppText>
            <AppText variant="title">{report.laboratory}</AppText>
            <AppText style={styles.secondary}>
              {message('designLab.measuredResultsCount', {
                count: formatSyntheticNumber(report.measurements),
              })}
            </AppText>
            {index === 0 && <ChangeRows />}
          </View>
        </View>
      ))}
      <ImportButton label={t('designLab.addToTimeline')} onPress={onImport} />
    </View>
  );
}

function LibraryHome({ onImport }: { onImport: () => void }) {
  const latest = syntheticReports[0]!;
  return (
    <View style={styles.sections}>
      <AppSurface style={styles.librarySummary}>
        <View style={styles.summaryItem}>
          <AppText style={styles.libraryNumber} variant="display">
            {formatSyntheticNumber(syntheticMeasuredChanges.length)}
          </AppText>
          <AppText style={styles.secondary}>{t('designLab.comparableBiomarkers')}</AppText>
        </View>
        <View style={styles.summaryItem}>
          <AppText style={styles.libraryNumber} variant="display">
            {formatSyntheticNumber(syntheticReports.length)}
          </AppText>
          <AppText style={styles.secondary}>{t('designLab.labReports')}</AppText>
        </View>
      </AppSurface>
      <AppText style={styles.eyebrow} variant="caption">
        {t('designLab.latestReport')}
      </AppText>
      <ReportRow report={latest} />
      <AppText style={styles.eyebrow} variant="caption">
        {t('designLab.biomarkerIndex')}
      </AppText>
      <ChangeRows compact />
      <AppText style={styles.eyebrow} variant="caption">
        {t('designLab.sourceReports')}
      </AppText>
      {syntheticReports.map((report) => (
        <ReportRow key={report.id} report={report} />
      ))}
      <ImportButton onPress={onImport} />
    </View>
  );
}

function useAutomatedScroll(ref: React.RefObject<ScrollViewType | null>) {
  const { automationScrollKey } = useContext(DesignLabContext);
  useEffect(() => {
    if (automationScrollKey === 0) return;
    const timer = setTimeout(() => ref.current?.scrollTo({ y: 520, animated: true }), 200);
    return () => clearTimeout(timer);
  }, [automationScrollKey, ref]);
}

function LabScreenScroll({ children }: { children: ReactNode }) {
  const ref = useRef<ScrollViewType>(null);
  useAutomatedScroll(ref);
  return (
    <ScreenScrollView ref={ref} contentContainerStyle={styles.content} style={styles.scroll}>
      {children}
    </ScreenScrollView>
  );
}

export function DesignLabHomeScreen({ onImport }: { onImport: () => void }) {
  const lab = useContext(DesignLabContext);
  return (
    <LabScreenScroll>
      <LabSwitcher />
      {lab.state === 'empty' ? (
        <EmptyHome onImport={onImport} />
      ) : lab.direction === 'quiet' ? (
        <QuietHome onImport={onImport} />
      ) : lab.direction === 'timeline' ? (
        <TimelineHome onImport={onImport} />
      ) : (
        <LibraryHome onImport={onImport} />
      )}
    </LabScreenScroll>
  );
}

export function DesignLabLabsScreen({ onImport }: { onImport: () => void }) {
  const lab = useContext(DesignLabContext);
  const { fontScale } = useWindowDimensions();
  return (
    <LabScreenScroll>
      <LabSwitcher />
      <View style={styles.sections}>
        <ImportButton onPress={onImport} />
        {lab.state === 'empty' ? (
          <View style={styles.labsEmpty}>
            <AppIcon name="addDocument" size={32} />
            <AppText variant="title">{t('designLab.noReports')}</AppText>
            <AppText style={styles.emptyBody}>{t('designLab.noReportsBody')}</AppText>
          </View>
        ) : (
          <>
            <AppText style={styles.eyebrow} variant="caption">
              {message('designLab.labReportsCount', {
                count: formatSyntheticNumber(syntheticReports.length),
              })}
            </AppText>
            {syntheticReports.map((report) => (
              <ReportRow key={report.id} report={report} />
            ))}
            <AppText style={styles.eyebrow} variant="caption">
              {t('designLab.collections')}
            </AppText>
            {syntheticReports.map((report) => (
              <View
                key={`record-${report.id}`}
                style={[styles.compactRow, fontScale >= 1.6 && styles.largeTypeRow]}
              >
                <View style={styles.grow}>
                  <AppText variant="heading">{formatSyntheticDate(report.collectedOn)}</AppText>
                  <AppText style={styles.secondary}>
                    {message('designLab.bloodMeasurements', {
                      count: formatSyntheticNumber(report.measurements),
                    })}
                  </AppText>
                </View>
              </View>
            ))}
          </>
        )}
      </View>
    </LabScreenScroll>
  );
}

export function DesignLabSettingsScreen() {
  return (
    <LabScreenScroll>
      <LabSwitcher />
      <View>
        <AppText style={styles.eyebrow} variant="caption">
          {t('designLab.settingsSection')}
        </AppText>
        <View style={styles.reportRow}>
          <AppIcon name="phone" />
          <View style={styles.grow}>
            <AppText variant="heading">{t('designLab.localShowcase')}</AppText>
            <AppText style={styles.secondary}>{t('designLab.localShowcaseBody')}</AppText>
          </View>
        </View>
        <View style={styles.reportRow}>
          <AppIcon name="shield" />
          <View style={styles.grow}>
            <AppText variant="heading">{t('designLab.accountFree')}</AppText>
            <AppText style={styles.secondary}>{t('designLab.accountFreeBody')}</AppText>
          </View>
        </View>
      </View>
    </LabScreenScroll>
  );
}

export function DesignLabImportScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.modal, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
      <View style={styles.modalHeader}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerTarget}>
          <AppText style={styles.headerAction}>{t('designLab.cancel')}</AppText>
        </Pressable>
        <AppText style={styles.modalTitle} variant="heading">
          {t('designLab.importTitle')}
        </AppText>
        <View style={styles.headerTarget} />
      </View>
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={styles.modalContent}
        keyboardDismissMode="interactive"
      >
        <AppText style={styles.lede} variant="title">
          {t('designLab.importIntro')}
        </AppText>
        <AppSurface style={styles.sourceChoice}>
          <AppIcon name="folder" />
          <View style={styles.grow}>
            <AppText variant="heading">{t('designLab.choosePdf')}</AppText>
            <AppText style={styles.secondary}>{t('designLab.choosePdfBody')}</AppText>
          </View>
        </AppSurface>
        <AppSurface style={styles.sourceChoice}>
          <AppIcon name="photos" />
          <View style={styles.grow}>
            <AppText variant="heading">{t('designLab.chooseImages')}</AppText>
            <AppText style={styles.secondary}>{t('designLab.chooseImagesBody')}</AppText>
          </View>
        </AppSurface>
        <AppText style={styles.eyebrow} variant="caption">
          {t('designLab.harnessNote')}
        </AppText>
        <TextInput
          accessibilityLabel={t('designLab.syntheticLabel')}
          autoFocus={process.env.EXPO_PUBLIC_ALYTE_DESIGN_LAB_AUTOMATE === '1'}
          placeholder={t('designLab.syntheticLabel')}
          placeholderTextColor={colors.mutedInk}
          style={styles.input}
          testID="design-lab-input"
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  scroll: { flex: 1, backgroundColor: colors.canvas },
  content: { flexGrow: 1, padding: spacing.lg, paddingBottom: 120, gap: spacing.xl },
  switcher: { gap: spacing.sm, padding: spacing.sm },
  nativeControl: { minHeight: 44, width: '100%' },
  harnessLabel: {
    color: colors.mutedInk,
    paddingHorizontal: spacing.xs,
    textTransform: 'uppercase',
  },
  sections: { gap: spacing.lg },
  empty: {
    flex: 1,
    minHeight: 360,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
  },
  heroSymbol: {
    width: 64,
    minHeight: 64,
    borderRadius: 14,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.disabledFill,
  },
  emptyTitle: { textAlign: 'center' },
  emptyBody: { color: colors.mutedInk, textAlign: 'center' },
  importButton: {
    minHeight: 50,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  importText: { color: colors.onAccent, fontWeight: '700', textAlign: 'center' },
  eyebrow: {
    color: colors.mutedInk,
    fontWeight: '700',
    letterSpacing: 0.7,
    textTransform: 'uppercase',
  },
  heroDate: { color: colors.ink },
  secondary: { color: colors.mutedInk },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: colors.border },
  changeRow: { paddingVertical: spacing.sm, gap: spacing.xs },
  reportRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
    paddingVertical: spacing.sm,
  },
  largeTypeRow: { alignItems: 'flex-start', flexDirection: 'column' },
  grow: { flex: 1, minWidth: 0, gap: spacing.xs },
  value: { fontWeight: '600', fontVariant: ['tabular-nums'] },
  valueColumn: { alignItems: 'flex-end', gap: spacing.xs },
  largeTypeValue: { alignItems: 'flex-start' },
  lede: { color: colors.ink },
  timelineRow: { flexDirection: 'row', gap: spacing.md },
  timelineRail: { width: 18, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: spacing.xs },
  timelineLine: { width: 2, flex: 1, marginTop: spacing.xs, backgroundColor: colors.border },
  timelineContent: { flex: 1, paddingBottom: spacing.xl, gap: spacing.xs },
  librarySummary: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: spacing.xl,
    justifyContent: 'space-around',
  },
  summaryItem: { flex: 1, minWidth: 120 },
  libraryNumber: { fontVariant: ['tabular-nums'] },
  compactRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  labsEmpty: {
    minHeight: 300,
    alignItems: 'center',
    justifyContent: 'center',
    gap: spacing.sm,
    paddingHorizontal: spacing.xl,
  },
  modal: { flex: 1, backgroundColor: colors.canvas },
  modalHeader: {
    minHeight: 52,
    paddingHorizontal: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: colors.border,
  },
  headerTarget: {
    minWidth: 70,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.sm,
  },
  headerAction: { color: colors.accent },
  modalTitle: { flexShrink: 1, textAlign: 'center' },
  modalContent: { padding: spacing.lg, gap: spacing.xl },
  sourceChoice: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  input: {
    minHeight: 50,
    color: colors.ink,
    backgroundColor: colors.surface,
    borderRadius: 12,
    borderCurve: 'continuous',
    paddingHorizontal: spacing.md,
    ...typography.body,
  },
});

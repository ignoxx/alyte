import { Image } from 'expo-image';
import { useContext } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { DesignLabContext } from './context';
import {
  designLabDirectionNames,
  designLabDirections,
  syntheticMeasuredChanges,
  syntheticReports,
} from './model';
import { labAccents, labColors, labRadius, labSpacing } from './theme';

const symbol = (name: string, size = 18) => (
  <Image
    source={`sf:${name}`}
    style={{ width: size, height: size }}
    tintColor={labColors.secondary as string}
  />
);

function LabSwitcher() {
  const lab = useContext(DesignLabContext);
  return (
    <View accessibilityLabel="Design lab controls" style={styles.switcher}>
      <View style={styles.segmentRow}>
        {designLabDirections.map((direction) => (
          <Pressable
            key={direction}
            accessibilityRole="button"
            accessibilityState={{ selected: lab.direction === direction }}
            onPress={() => lab.setDirection(direction)}
            style={({ pressed }) => [
              styles.segment,
              lab.direction === direction && styles.selectedSegment,
              pressed && styles.pressed,
            ]}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              style={[
                styles.segmentText,
                lab.direction === direction && styles.selectedSegmentText,
              ]}
            >
              {designLabDirectionNames[direction]}
            </Text>
          </Pressable>
        ))}
      </View>
      <View style={styles.stateRow}>
        <Text maxFontSizeMultiplier={1.2} style={styles.harnessLabel}>
          SHOWCASE DATA
        </Text>
        {(['empty', 'two-reports'] as const).map((state) => (
          <Pressable
            key={state}
            accessibilityRole="button"
            accessibilityState={{ selected: lab.state === state }}
            onPress={() => lab.setState(state)}
            style={styles.stateTarget}
          >
            <Text
              maxFontSizeMultiplier={1.3}
              style={{
                color: lab.state === state ? labAccents[lab.direction] : labColors.secondary,
                fontSize: 13,
                fontWeight: lab.state === state ? '700' : '500',
                textAlign: 'center',
              }}
            >
              {state === 'empty' ? 'Empty' : 'Two reports'}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}

function ImportButton({
  onPress,
  label = 'Import a Lab Report',
}: {
  onPress: () => void;
  label?: string;
}) {
  const { direction } = useContext(DesignLabContext);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [
        styles.importButton,
        { backgroundColor: labAccents[direction], opacity: pressed ? 0.72 : 1 },
      ]}
    >
      {symbol('plus', 17)}
      <Text style={styles.importText}>{label}</Text>
    </Pressable>
  );
}

function ReportRow({
  report = syntheticReports[0]!,
}: {
  report?: (typeof syntheticReports)[number];
}) {
  return (
    <View
      accessibilityLabel={`${report.laboratory}, collected ${report.collected}, ${report.measurements} Measurements`}
      style={styles.reportRow}
    >
      {symbol('doc.text')}
      <View style={styles.grow}>
        <Text style={styles.rowTitle}>{report.laboratory}</Text>
        <Text style={styles.secondary}>
          {report.collected} · {report.measurements} Measurements
        </Text>
      </View>
      {symbol('chevron.right', 13)}
    </View>
  );
}

function EmptyHome({ onImport }: { onImport: () => void }) {
  const { direction } = useContext(DesignLabContext);
  const copy =
    direction === 'quiet'
      ? [
          'Your laboratory history, in one place.',
          'Import a report to begin a private history on this iPhone.',
        ]
      : direction === 'timeline'
        ? [
            'Your timeline starts with a report.',
            'Each collection date will take its place in your measured history.',
          ]
        : [
            'Build your biomarker library.',
            'Add a report to organize Measurements by biomarker and source.',
          ];
  return (
    <View style={styles.empty}>
      <View style={[styles.heroSymbol, { backgroundColor: labColors.fill }]}>
        {symbol(
          direction === 'library'
            ? 'books.vertical'
            : direction === 'timeline'
              ? 'clock'
              : 'doc.text',
          30,
        )}
      </View>
      <Text style={styles.emptyTitle}>{copy[0]}</Text>
      <Text style={styles.emptyBody}>{copy[1]}</Text>
      <ImportButton onPress={onImport} />
    </View>
  );
}

function QuietHome({ onImport }: { onImport: () => void }) {
  return (
    <View style={styles.sections}>
      <Text style={styles.eyebrow}>LATEST REPORT</Text>
      <Text style={styles.heroDate}>18 August</Text>
      <Text style={styles.secondary}>Northstar Laboratory · 12 Measurements</Text>
      <View style={styles.rule} />
      <Text style={styles.sectionTitle}>Measured changes</Text>
      {syntheticMeasuredChanges.map((change) => (
        <View key={change.biomarker} style={styles.changeRow}>
          <Text style={styles.rowTitle}>{change.biomarker}</Text>
          <Text selectable style={styles.value}>
            {change.latest}
          </Text>
          <Text style={styles.secondary}>
            From {change.previous} · {change.direction}
          </Text>
        </View>
      ))}
      <Text style={styles.sectionTitle}>Recent reports</Text>
      {syntheticReports.map((report) => (
        <ReportRow key={report.id} report={report} />
      ))}
      <ImportButton label="Import another report" onPress={onImport} />
    </View>
  );
}

function TimelineHome({ onImport }: { onImport: () => void }) {
  const accent = labAccents.timeline;
  return (
    <View style={styles.sections}>
      <Text style={styles.lede}>Two collection dates form your measured history.</Text>
      {syntheticReports.map((report, index) => (
        <View key={report.id} style={styles.timelineRow}>
          <View style={styles.timelineRail}>
            <View style={[styles.timelineDot, { backgroundColor: accent }]} />
            {index === 0 && (
              <View style={[styles.timelineLine, { backgroundColor: labColors.separator }]} />
            )}
          </View>
          <View style={styles.timelineContent}>
            <Text style={styles.eyebrow}>
              {index === 0 ? 'LATEST · 18 AUG 2026' : '12 FEB 2026'}
            </Text>
            <Text style={styles.sectionTitle}>{report.laboratory}</Text>
            <Text style={styles.secondary}>{report.measurements} measured results</Text>
            {index === 0 &&
              syntheticMeasuredChanges.map((change) => (
                <View key={change.biomarker} style={styles.inlineChange}>
                  <Text style={styles.rowTitle}>{change.biomarker}</Text>
                  <Text selectable style={styles.value}>
                    {change.previous} → {change.latest}
                  </Text>
                </View>
              ))}
          </View>
        </View>
      ))}
      <ImportButton label="Add to timeline" onPress={onImport} />
    </View>
  );
}

function LibraryHome({ onImport }: { onImport: () => void }) {
  return (
    <View style={styles.sections}>
      <View style={styles.librarySummary}>
        <View>
          <Text style={styles.libraryNumber}>3</Text>
          <Text style={styles.secondary}>comparable biomarkers</Text>
        </View>
        <View>
          <Text style={styles.libraryNumber}>2</Text>
          <Text style={styles.secondary}>Lab Reports</Text>
        </View>
      </View>
      <Text style={styles.eyebrow}>BIOMARKER INDEX</Text>
      {syntheticMeasuredChanges.map((change) => (
        <View key={change.biomarker} style={styles.compactRow}>
          <View style={styles.grow}>
            <Text style={styles.rowTitle}>{change.biomarker}</Text>
            <Text style={styles.secondary}>2 compatible Measurements</Text>
          </View>
          <View style={styles.valueColumn}>
            <Text selectable style={styles.value}>
              {change.latest}
            </Text>
            <Text style={styles.secondary}>{change.direction}</Text>
          </View>
        </View>
      ))}
      <Text style={styles.eyebrow}>SOURCE REPORTS</Text>
      {syntheticReports.map((report) => (
        <ReportRow key={report.id} report={report} />
      ))}
      <ImportButton label="Import report" onPress={onImport} />
    </View>
  );
}

export function DesignLabHomeScreen({ onImport }: { onImport: () => void }) {
  const lab = useContext(DesignLabContext);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
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
    </ScrollView>
  );
}

export function DesignLabLabsScreen({ onImport }: { onImport: () => void }) {
  const lab = useContext(DesignLabContext);
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <LabSwitcher />
      <View style={styles.sections}>
        <ImportButton onPress={onImport} />
        {lab.state === 'empty' ? (
          <View style={styles.labsEmpty}>
            {symbol('doc.badge.plus', 32)}
            <Text style={styles.sectionTitle}>No Lab Reports</Text>
            <Text style={styles.emptyBody}>
              Imported source documents will appear here, separate from their Measurements.
            </Text>
          </View>
        ) : (
          <>
            <Text style={styles.eyebrow}>LAB REPORTS · 2</Text>
            {syntheticReports.map((report) => (
              <ReportRow key={report.id} report={report} />
            ))}
            <Text style={styles.eyebrow}>COLLECTIONS</Text>
            {syntheticReports.map((report) => (
              <View key={`record-${report.id}`} style={styles.compactRow}>
                <View>
                  <Text style={styles.rowTitle}>{report.collected}</Text>
                  <Text style={styles.secondary}>{report.measurements} Measurements · blood</Text>
                </View>
              </View>
            ))}
          </>
        )}
      </View>
    </ScrollView>
  );
}

export function DesignLabSettingsScreen() {
  return (
    <ScrollView contentInsetAdjustmentBehavior="automatic" contentContainerStyle={styles.content}>
      <LabSwitcher />
      <View style={styles.settingsGroup}>
        <Text style={styles.eyebrow}>DESIGN LAB</Text>
        <View style={styles.reportRow}>
          {symbol('iphone')}
          <View style={styles.grow}>
            <Text style={styles.rowTitle}>Local showcase only</Text>
            <Text style={styles.secondary}>Synthetic data is not saved.</Text>
          </View>
        </View>
        <View style={styles.reportRow}>
          {symbol('hand.raised')}
          <View style={styles.grow}>
            <Text style={styles.rowTitle}>Account-free</Text>
            <Text style={styles.secondary}>No network or sign-in is used.</Text>
          </View>
        </View>
      </View>
    </ScrollView>
  );
}

export function DesignLabImportScreen({ onClose }: { onClose: () => void }) {
  const insets = useSafeAreaInsets();
  return (
    <View
      style={[
        styles.modal,
        { paddingTop: insets.top + labSpacing.sm, paddingBottom: insets.bottom + labSpacing.lg },
      ]}
    >
      <View style={styles.modalHeader}>
        <Pressable accessibilityRole="button" onPress={onClose} style={styles.headerTarget}>
          <Text style={styles.headerAction}>Cancel</Text>
        </Pressable>
        <Text style={styles.modalTitle}>Import Lab Report</Text>
        <View style={styles.headerTarget} />
      </View>
      <ScrollView keyboardDismissMode="interactive" contentContainerStyle={styles.modalContent}>
        <Text style={styles.lede}>
          Choose a synthetic source path to judge the native task presentation. Nothing is imported.
        </Text>
        <Pressable accessibilityRole="button" style={styles.sourceChoice}>
          {symbol('folder')}
          <View>
            <Text style={styles.rowTitle}>Choose a PDF from Files</Text>
            <Text style={styles.secondary}>Native document picker in production</Text>
          </View>
        </Pressable>
        <Pressable accessibilityRole="button" style={styles.sourceChoice}>
          {symbol('photo.on.rectangle')}
          <View>
            <Text style={styles.rowTitle}>Choose images from Photos</Text>
            <Text style={styles.secondary}>Native photo picker in production</Text>
          </View>
        </Pressable>
        <Text style={styles.eyebrow}>HARNESS NOTE</Text>
        <TextInput
          accessibilityLabel="Synthetic report label"
          placeholder="Synthetic report label"
          placeholderTextColor={labColors.tertiary}
          style={styles.input}
        />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { flexGrow: 1, padding: labSpacing.lg, paddingBottom: 120, gap: labSpacing.xl },
  switcher: {
    backgroundColor: labColors.surface,
    borderRadius: labRadius.md,
    borderCurve: 'continuous',
    padding: labSpacing.xs,
    gap: labSpacing.xs,
  },
  segmentRow: { flexDirection: 'row', gap: labSpacing.xs },
  segment: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: labRadius.sm,
    borderCurve: 'continuous',
  },
  selectedSegment: { backgroundColor: labColors.fill },
  pressed: { opacity: 0.55 },
  segmentText: { color: labColors.secondary, fontSize: 13, fontWeight: '600' },
  selectedSegmentText: { color: labColors.label, fontWeight: '700' },
  stateRow: {
    minHeight: 44,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: labSpacing.sm,
    gap: labSpacing.xs,
  },
  stateTarget: { flex: 1, minHeight: 44, justifyContent: 'center' },
  harnessLabel: {
    width: 104,
    color: labColors.tertiary,
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  sections: { gap: labSpacing.lg },
  empty: {
    flex: 1,
    minHeight: 430,
    alignItems: 'center',
    justifyContent: 'center',
    gap: labSpacing.md,
    paddingHorizontal: labSpacing.lg,
  },
  heroSymbol: {
    width: 64,
    height: 64,
    borderRadius: 20,
    borderCurve: 'continuous',
    alignItems: 'center',
    justifyContent: 'center',
  },
  emptyTitle: {
    color: labColors.label,
    fontSize: 28,
    lineHeight: 34,
    fontWeight: '700',
    textAlign: 'center',
  },
  emptyBody: { color: labColors.secondary, fontSize: 17, lineHeight: 23, textAlign: 'center' },
  importButton: {
    minHeight: 50,
    borderRadius: labRadius.md,
    borderCurve: 'continuous',
    paddingHorizontal: labSpacing.lg,
    flexDirection: 'row',
    gap: labSpacing.sm,
    justifyContent: 'center',
    alignItems: 'center',
  },
  importText: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  eyebrow: { color: labColors.secondary, fontSize: 12, fontWeight: '700', letterSpacing: 0.7 },
  heroDate: { color: labColors.label, fontSize: 40, fontWeight: '700' },
  secondary: { color: labColors.secondary, fontSize: 15, lineHeight: 20 },
  rule: { height: StyleSheet.hairlineWidth, backgroundColor: labColors.separator },
  sectionTitle: { color: labColors.label, fontSize: 21, lineHeight: 26, fontWeight: '700' },
  rowTitle: { color: labColors.label, fontSize: 17, lineHeight: 22, fontWeight: '600' },
  value: { color: labColors.label, fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
  changeRow: { paddingVertical: labSpacing.sm, gap: labSpacing.xs },
  reportRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    gap: labSpacing.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: labColors.separator,
  },
  grow: { flex: 1, gap: 2 },
  lede: { color: labColors.label, fontSize: 22, lineHeight: 29, fontWeight: '600' },
  timelineRow: { flexDirection: 'row', gap: labSpacing.md },
  timelineRail: { width: 18, alignItems: 'center' },
  timelineDot: { width: 12, height: 12, borderRadius: 6, marginTop: 3 },
  timelineLine: { width: 2, flex: 1, marginTop: labSpacing.xs },
  timelineContent: { flex: 1, paddingBottom: labSpacing.xl, gap: labSpacing.xs },
  inlineChange: {
    paddingVertical: labSpacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: labColors.separator,
    gap: 2,
  },
  librarySummary: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    backgroundColor: labColors.surface,
    padding: labSpacing.xl,
    borderRadius: labRadius.lg,
    borderCurve: 'continuous',
  },
  libraryNumber: {
    color: labColors.label,
    fontSize: 32,
    fontWeight: '700',
    fontVariant: ['tabular-nums'],
  },
  compactRow: {
    minHeight: 64,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: labSpacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: labColors.separator,
  },
  valueColumn: { alignItems: 'flex-end', gap: 2 },
  labsEmpty: {
    minHeight: 330,
    alignItems: 'center',
    justifyContent: 'center',
    gap: labSpacing.sm,
    paddingHorizontal: labSpacing.xl,
  },
  settingsGroup: { gap: 0 },
  modal: { flex: 1, backgroundColor: labColors.background },
  modalHeader: {
    minHeight: 52,
    paddingHorizontal: labSpacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: labColors.separator,
  },
  headerTarget: {
    minWidth: 70,
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: labSpacing.sm,
  },
  headerAction: { color: '#007AFF', fontSize: 17 },
  modalTitle: { color: labColors.label, fontSize: 17, fontWeight: '600' },
  modalContent: { padding: labSpacing.lg, gap: labSpacing.xl },
  sourceChoice: {
    minHeight: 72,
    padding: labSpacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: labSpacing.md,
    backgroundColor: labColors.surface,
    borderRadius: labRadius.md,
    borderCurve: 'continuous',
  },
  input: {
    minHeight: 50,
    color: labColors.label,
    backgroundColor: labColors.surface,
    borderRadius: labRadius.sm,
    borderCurve: 'continuous',
    paddingHorizontal: labSpacing.md,
    fontSize: 17,
  },
});

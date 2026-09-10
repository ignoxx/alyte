import { Host, Picker } from '@expo/ui';

export type LabDeletionScopePickerOption = {
  readonly value: string;
  readonly label: string;
};

export type LabDeletionScopePickerProps = {
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly options: readonly LabDeletionScopePickerOption[];
  readonly selectedValue: string;
  readonly onValueChange: (value: string) => void;
};

/** Android/web fallback; iOS uses the labelled SwiftUI menu picker. */
export function LabDeletionScopePicker({
  accessibilityLabel,
  disabled = false,
  options,
  selectedValue,
  onValueChange,
}: LabDeletionScopePickerProps) {
  return (
    <Host
      accessible
      accessibilityLabel={accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      accessibilityValue={{ text: options.find((option) => option.value === selectedValue)?.label }}
      ignoreSafeArea="all"
      matchContents
    >
      <Picker
        appearance="menu"
        enabled={!disabled}
        selectedValue={selectedValue}
        onValueChange={(value) => {
          if (typeof value === 'string') onValueChange(value);
        }}
      >
        {options.map((option) => (
          <Picker.Item key={option.value} label={option.label} value={option.value} />
        ))}
      </Picker>
    </Host>
  );
}

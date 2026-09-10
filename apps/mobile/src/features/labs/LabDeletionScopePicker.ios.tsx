import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import { disabled, labelsHidden, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
import type { LabDeletionScopePickerProps } from './LabDeletionScopePicker';

/** The labelled SwiftUI picker keeps deletion scope in one native menu row. */
export function LabDeletionScopePicker({
  accessibilityLabel,
  disabled: isDisabled = false,
  options,
  selectedValue,
  onValueChange,
}: LabDeletionScopePickerProps) {
  return (
    <Host ignoreSafeArea="all" matchContents>
      <Picker
        label={accessibilityLabel}
        modifiers={[pickerStyle('menu'), labelsHidden(), ...(isDisabled ? [disabled(true)] : [])]}
        selection={selectedValue}
        onSelectionChange={(value) => {
          if (typeof value === 'string') onValueChange(value);
        }}
      >
        {options.map((option) => (
          <Text key={option.value} modifiers={[tag(option.value)]}>
            {option.label}
          </Text>
        ))}
      </Picker>
    </Host>
  );
}

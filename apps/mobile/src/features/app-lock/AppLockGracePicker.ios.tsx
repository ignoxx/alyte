import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import {
  disabled,
  dynamicTypeSize,
  frame,
  labelsHidden,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import type { AppLockGracePickerProps } from './AppLockGracePicker';

/**
 * The universal SDK57 Picker omits the SwiftUI label. PickerView has no unlabeled native branch,
 * so use the labelled SwiftUI primitive directly and hide its duplicate visual label. The label
 * remains available to VoiceOver together with the selected menu value.
 */
export function AppLockGracePicker({
  selectedValue,
  enabled,
  accessibilityLabel,
  options,
  testID,
  onValueChange,
}: AppLockGracePickerProps) {
  return (
    <Host ignoreSafeArea="all" matchContents>
      <Picker
        label={accessibilityLabel}
        modifiers={[
          pickerStyle('menu'),
          labelsHidden(),
          // The menu label has no wrapping opportunity. Keep it Dynamic Type-aware through
          // accessibility 3, then cap only this intrinsic control before it can escape the row.
          dynamicTypeSize({ max: 'accessibility3' }),
          frame({ minWidth: 132, alignment: 'trailing' }),
          ...(enabled ? [] : [disabled(true)]),
        ]}
        selection={selectedValue}
        testID={testID}
        onSelectionChange={onValueChange}
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

import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import { disabled, labelsHidden, pickerStyle, tag } from '@expo/ui/swift-ui/modifiers';
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
    <Host matchContents ignoreSafeArea="all">
      <Picker
        label={accessibilityLabel}
        modifiers={[pickerStyle('menu'), labelsHidden(), ...(enabled ? [] : [disabled(true)])]}
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

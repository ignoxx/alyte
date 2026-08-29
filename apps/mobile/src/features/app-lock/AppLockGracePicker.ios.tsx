import { Host } from '@expo/ui';
import { Picker, Text } from '@expo/ui/swift-ui';
import {
  disabled,
  dynamicTypeSize,
  labelsHidden,
  padding,
  pickerStyle,
  tag,
} from '@expo/ui/swift-ui/modifiers';
import { spacing } from '../../theme';
import type { AppLockGracePickerProps } from './AppLockGracePicker';

const GRACE_PICKER_TRAILING_INSET = spacing.sm;

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
          // Host matchContents follows the Picker's SwiftUI intrinsic width. Reserve a small
          // trailing slot inside that measured width so the menu indicator stays inside the row's
          // rounded surface instead of ending on the Host boundary when its glyph is drawn.
          padding({ trailing: GRACE_PICKER_TRAILING_INSET }),
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

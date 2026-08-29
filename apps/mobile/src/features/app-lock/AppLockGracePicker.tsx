import { Host, Picker } from '@expo/ui';
import type { AppLockGraceOption } from './app-lock-ui-model';
import type { AppLockGrace } from './policy';

export type AppLockGracePickerProps = {
  readonly selectedValue: AppLockGrace;
  readonly enabled: boolean;
  readonly accessibilityLabel: string;
  readonly options: readonly AppLockGraceOption[];
  readonly testID: string;
  readonly onValueChange: (value: AppLockGrace) => void;
};

/** Android/web fallback; iOS uses the labelled SwiftUI picker in AppLockGracePicker.ios.tsx. */
export function AppLockGracePicker({
  selectedValue,
  enabled,
  options,
  testID,
  onValueChange,
}: AppLockGracePickerProps) {
  return (
    <Host matchContents ignoreSafeArea="all">
      <Picker
        appearance="menu"
        enabled={enabled}
        selectedValue={selectedValue}
        testID={testID}
        onValueChange={(value) => onValueChange(value as AppLockGrace)}
      >
        {options.map((option) => (
          <Picker.Item key={option.value} label={option.label} value={option.value} />
        ))}
      </Picker>
    </Host>
  );
}

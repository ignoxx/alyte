import { t } from '../../localization';
import { APP_LOCK_GRACES, type AppLockGrace, type AppLockPreferences } from './policy';

const graceLabel: Record<AppLockGrace, string> = {
  immediate: 'settings.appLock.graceImmediate',
  oneMinute: 'settings.appLock.graceOneMinute',
  fiveMinutes: 'settings.appLock.graceFiveMinutes',
};

export type AppLockGraceOption = {
  readonly value: AppLockGrace;
  readonly label: string;
};

export type AppLockRowLayout = 'inline' | 'stacked';

const APP_LOCK_ACCESSIBILITY_FONT_SCALE = 1.3;

/**
 * Keep the two-control group compact at ordinary text sizes, then stack each native control below
 * its copy once iOS enters the accessibility Dynamic Type ramp. This avoids letting an intrinsic
 * switch or picker width squeeze the row copy or lose its visible association with the control.
 */
export function getAppLockRowLayout(fontScale: number): AppLockRowLayout {
  return Number.isFinite(fontScale) && fontScale >= APP_LOCK_ACCESSIBILITY_FONT_SCALE
    ? 'stacked'
    : 'inline';
}

export type AppLockControlsPresentation = {
  readonly enable: {
    readonly testID: 'app-lock-enabled';
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
    readonly checked: boolean;
    readonly disabled: boolean;
  };
  readonly grace: {
    readonly testID: 'app-lock-grace';
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
    readonly value: AppLockGrace;
    readonly valueLabel: string;
    readonly disabled: boolean;
  };
};

/**
 * Keeps the visible rows and their accessibility state in sync with the controller inputs.
 * Settings operations share one busy state so a queued write cannot be started from the other
 * control while the first operation is still settling.
 */
export function appLockControlsPresentation(
  preferences: AppLockPreferences,
  busy: boolean,
): AppLockControlsPresentation {
  const valueLabel = t(graceLabel[preferences.grace]);

  return {
    enable: {
      testID: 'app-lock-enabled',
      accessibilityLabel: t('settings.appLock.enable'),
      accessibilityHint: t('settings.appLock.enableSupporting'),
      checked: preferences.enabled,
      disabled: busy,
    },
    grace: {
      testID: 'app-lock-grace',
      accessibilityLabel: `${t('settings.appLock.grace')}, ${valueLabel}`,
      accessibilityHint: t('settings.appLock.graceSupporting'),
      value: preferences.grace,
      valueLabel,
      disabled: !preferences.enabled || busy,
    },
  };
}

export function appLockGraceOptions(): readonly AppLockGraceOption[] {
  return APP_LOCK_GRACES.map((value) => ({
    value,
    label: t(graceLabel[value]),
  }));
}

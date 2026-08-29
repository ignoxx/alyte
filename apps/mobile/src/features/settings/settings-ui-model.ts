import { t } from '../../localization';
import type { SettingsStackParamList } from '../../navigation/types';
import type { AppIconName } from '../../ui/primitives';

export type LocalSettingsRoute = Exclude<
  keyof SettingsStackParamList,
  'SettingsRoot' | 'CloudAccount' | 'Diagnostics' | 'DeleteLocalData'
>;

export type LocalSettingsRow = {
  readonly icon: Extract<AppIconName, 'lockShield' | 'shield' | 'folder' | 'doc'>;
  readonly title: string;
  readonly subtitle: string;
  readonly route: LocalSettingsRoute;
};

/**
 * The pre-cloud Settings surface is deliberately a small, complete local control list. Cloud
 * account and subscription rows belong to the later cloud slice and must not be added here until
 * that slice owns an explicit, user-ready navigation gate.
 */
export function buildLocalSettingsRows(appLockStatus: string): readonly LocalSettingsRow[] {
  return [
    {
      icon: 'lockShield',
      title: t('settings.appLockTitle'),
      subtitle: `${t('settings.appLockSubtitle')} · ${appLockStatus}`,
      route: 'AppLock',
    },
    {
      icon: 'shield',
      title: t('settings.privacy'),
      subtitle: t('settings.privacySubtitle'),
      route: 'PrivacyStorage',
    },
    {
      icon: 'folder',
      title: t('settings.modelStorage'),
      subtitle: t('settings.modelStorageSubtitle'),
      route: 'ModelStorage',
    },
    {
      icon: 'doc',
      title: t('settings.support'),
      subtitle: t('settings.supportSubtitle'),
      route: 'SupportFaq',
    },
  ];
}

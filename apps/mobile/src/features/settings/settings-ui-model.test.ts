import { test } from 'node:test';
import assert from 'node:assert/strict';
import { t } from '../../localization';
import { buildLocalSettingsRows } from './settings-ui-model';

test('local Settings presents only complete controls and keeps local routes reachable', () => {
  const rows = buildLocalSettingsRows(t('settings.appLockDisabled'));

  assert.deepEqual(
    rows.map((row) => ({ icon: row.icon, title: row.title, route: row.route })),
    [
      {
        icon: 'lockShield',
        title: t('settings.appLockTitle'),
        route: 'AppLock',
      },
      {
        icon: 'shield',
        title: t('settings.privacy'),
        route: 'PrivacyStorage',
      },
      {
        icon: 'folder',
        title: t('settings.modelStorage'),
        route: 'ModelStorage',
      },
      {
        icon: 'doc',
        title: t('settings.support'),
        route: 'SupportFaq',
      },
    ],
  );
  assert.ok(rows.every((row) => row.subtitle.length > 0));
  assert.equal(
    rows.some((row) => row.title === t('settings.cloudAccountTitle')),
    false,
  );
});

test('local App Lock status stays in the accessible row subtitle', () => {
  const rows = buildLocalSettingsRows(t('settings.appLockEnabled'));

  assert.equal(
    rows.find((row) => row.route === 'AppLock')?.subtitle,
    `${t('settings.appLockSubtitle')} · ${t('settings.appLockEnabled')}`,
  );
});

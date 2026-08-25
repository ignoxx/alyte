import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, '..');
const mobileDirectory = join(repositoryRoot, 'apps', 'mobile');
const expoCli = join(repositoryRoot, 'node_modules', 'expo', 'bin', 'cli');

function bundle(label, showcaseMode) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'alyte-mobile-bundle-'));
  const outputDirectory = join(temporaryRoot, 'ios');
  const environment = { ...process.env };

  delete environment.APP_VARIANT;
  delete environment.EXPO_PUBLIC_APP_VARIANT;
  environment.APP_VARIANT = 'development';
  environment.EXPO_PUBLIC_APP_VARIANT = 'development';

  if (showcaseMode) {
    environment.EXPO_PUBLIC_SHOWCASE_MODE = 'true';
  } else {
    delete environment.EXPO_PUBLIC_SHOWCASE_MODE;
  }

  try {
    const result = spawnSync(
      process.execPath,
      [expoCli, 'export', '--platform', 'ios', '--output-dir', outputDirectory, '--clear'],
      {
        cwd: mobileDirectory,
        env: environment,
        encoding: 'utf8',
      },
    );

    if (result.error) throw result.error;
    assert.equal(
      result.status,
      0,
      `${label} Expo bundle failed${result.stderr ? `:\n${result.stderr}` : ''}`,
    );
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
}

bundle('ordinary development', false);
bundle('development showcase', true);

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');
const mobilePackage = JSON.parse(read('apps/mobile/package.json'));
const mobileStrings = JSON.parse(read('apps/mobile/src/localization/en.json'));
const mobileDependencies = {
  ...mobilePackage.dependencies,
  ...mobilePackage.devDependencies,
};

assert.equal(
  mobileDependencies['@alyte/local-models'],
  'file:modules/alyte-local-models',
  'the required on-device model module must be a pinned local package',
);
assert.equal(
  mobilePackage.expo?.autolinking?.exclude?.includes('@alyte/local-models') ?? false,
  false,
  'the required on-device model module must not be excluded from native autolinking',
);
assert.equal(typeof mobileStrings.onboarding?.modelDownload, 'string');
assert.equal(typeof mobileStrings.onboarding?.modelPrepareBody, 'string');

const autolinkingCli = path.join(
  root,
  'node_modules/expo-modules-autolinking/bin/expo-modules-autolinking.js',
);
const autolinkedModules = execFileSync(
  process.execPath,
  [autolinkingCli, 'resolve', '--platform', 'apple', '--json'],
  { cwd: path.join(root, 'apps/mobile'), encoding: 'utf8' },
);
assert.match(autolinkedModules, /"packageName":"@alyte\/local-models"/);

const services = read('apps/mobile/src/services/index.ts');
assert.match(services, /createLocalPaddleOCR\(\{ models: localModels \}\)/);
assert.match(services, /models: localModels/);
assert.match(read('apps/mobile/App.tsx'), /model=\{services\.models\}/);

const onboarding = read('apps/mobile/src/features/onboarding/OnboardingScreen.tsx');
assert.match(onboarding, /model\.startDownload\(\)/);
assert.doesNotMatch(
  onboarding,
  /model\.load\(/,
  'onboarding may install and verify the required pack, but must not load it into memory',
);

const paddleOCR = read('apps/mobile/src/features/local-models/paddleocr.ts');
assert.match(paddleOCR, /options\.models\.load\(\)/);
assert.match(paddleOCR, /inferImageRaw\(createPaddleOCRPrompt\(\)/);
assert.match(paddleOCR, /options\.models\.unload\(\)/);
assert.match(paddleOCR, /return 'OCR:'/);

const podspec = read('apps/mobile/modules/alyte-local-models/ios/AlyteLocalModels.podspec');
assert.match(podspec, /ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK/);
assert.match(podspec, /ENV\['APP_VARIANT'\] != 'production'/);
assert.match(podspec, /requires the exact pinned llama\.cpp runtime/);
assert.match(
  podspec,
  /ENV\['ALYTE_LOCAL_MODEL_CPU_ONLY'\] == '1'/,
  'CPU-only inference must remain an explicit diagnostic override',
);
assert.doesNotMatch(
  podspec,
  /unless \['preview', 'production'\]\.include\?\(ENV\['APP_VARIANT'\]\)/,
  'development device builds must use the bounded Metal-first runtime',
);

assert.doesNotMatch(
  read('apps/mobile/app.config.js'),
  /increased-memory-limit|extended-virtual-addressing/,
);
assert.match(read('package-lock.json'), /"node_modules\/@alyte\/local-models"/);

process.stdout.write('Production mandatory-install and lazy-load model boundary is valid.\n');

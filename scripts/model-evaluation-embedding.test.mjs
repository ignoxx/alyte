import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const project = fs.readFileSync(
  'apps/model-evaluation/AlyteModelEvaluation.xcodeproj/project.pbxproj',
  'utf8',
);
const runner = fs.readFileSync('scripts/run-model-evaluation-device.sh', 'utf8');

test('evaluator embeds the selected device framework slice, not the xcframework wrapper', () => {
  assert.match(
    project,
    /explicitFileType = wrapper\.framework; name = llama\.framework; path = "\$\(ALYTE_MODEL_EVAL_LLAMA_XCFRAMEWORK\)\/ios-arm64\/llama\.framework";/,
  );
  assert.match(project, /ATTRIBUTES = \(CodeSignOnCopy, RemoveHeadersOnCopy,\);/);
  assert.doesNotMatch(project, /explicitFileType = wrapper\.xcframework/);
});

test('device runner rejects a linked-but-unembedded or unsigned runtime before install', () => {
  assert.match(runner, /embedded_framework="\$\{app_path\}\/Frameworks\/llama\.framework"/);
  assert.match(runner, /embedded_binary="\$\{embedded_framework\}\/llama"/);
  assert.match(
    runner,
    /Embedded llama\.framework does not match the pinned runtime identity manifest/,
  );
  assert.match(runner, /codesign --verify --strict --verbose=2 "\$\{embedded_framework\}"/);
  assert.match(runner, /codesign --verify --deep --strict --verbose=2 "\$\{app_path\}"/);
});

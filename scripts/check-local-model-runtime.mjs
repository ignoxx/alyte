import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import process from 'node:process';

const expectedRevision = 'bb4caa7540188872173c44d161602d9271386413';
const expected = {
  runtimeRepository: 'ggml-org/llama.cpp',
  runtimeRelease: 'v0.2.0',
  runtimeRevision: expectedRevision,
  sourceRevision: expectedRevision,
  platform: 'ios-device',
  module: 'llama',
};

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  process.stderr.write(`local-model-runtime: ${message}\n`);
  process.exitCode = 1;
}

const variant = argument('--variant') ?? process.env.APP_VARIANT ?? 'development';
const runtimePathValue =
  argument('--runtime-path') ?? process.env.ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK;
const allowSimulatorFake =
  process.argv.includes('--allow-simulator-fake') ||
  (process.env.ALYTE_LOCAL_MODEL_ALLOW_SIMULATOR_FAKE === '1' &&
    process.env.ALYTE_LOCAL_MODEL_SIMULATOR === '1');
const repositoryRoot = resolve(new URL('..', import.meta.url).pathname);

if (!runtimePathValue) {
  if (allowSimulatorFake && variant !== 'production') {
    process.stdout.write(
      'local-model-runtime: explicit simulator fake is allowed for this non-production build.\n',
    );
  } else {
    fail(
      `missing pinned XCFramework for ${variant}; provide ALYTE_LOCAL_MODEL_RUNTIME_XCFRAMEWORK or use the explicit simulator fake only for non-production simulator builds`,
    );
  }
} else {
  const runtimePath = resolve(runtimePathValue);
  if (!isAbsolute(runtimePathValue)) {
    fail('runtime path must be absolute and external to the Alyte repository');
  }
  const relativePath = relative(repositoryRoot, runtimePath);
  if (relativePath === '' || (!relativePath.startsWith('..') && !relativePath.startsWith('../'))) {
    fail('runtime path must be outside the Alyte repository');
  }

  const identityPath = `${runtimePath}.alyte-eval.json`;
  const deviceFramework = join(runtimePath, 'ios-arm64', 'llama.framework');
  const deviceBinary = join(deviceFramework, 'llama');
  const header = join(deviceFramework, 'Headers', 'llama.h');
  if (!existsSync(identityPath)) fail(`missing identity manifest: ${identityPath}`);
  if (!existsSync(deviceFramework)) fail(`missing device framework: ${deviceFramework}`);
  if (!existsSync(deviceBinary)) fail(`missing device runtime binary: ${deviceBinary}`);
  if (!existsSync(header)) fail(`missing device runtime header: ${header}`);

  if (existsSync(identityPath)) {
    let identity;
    try {
      identity = JSON.parse(readFileSync(identityPath, 'utf8'));
    } catch {
      fail('identity manifest is not valid JSON');
      identity = null;
    }
    if (identity) {
      for (const [key, value] of Object.entries(expected)) {
        if (identity[key] !== value) fail(`identity.${key} must equal ${value}`);
      }
      if (resolve(identity.frameworkPath ?? '') !== runtimePath) {
        fail('identity.frameworkPath does not match the selected XCFramework');
      }
      const digest = createHash('sha256').update(readFileSync(deviceBinary)).digest('hex');
      if (identity.deviceBinarySha256 !== digest)
        fail('device runtime binary checksum does not match identity manifest');
    }
  }

  function scan(path) {
    for (const entry of readdirSync(path)) {
      const child = join(path, entry);
      if (statSync(child).isDirectory()) scan(child);
      else if (/\.(gguf|bin|safetensors|pt|pth|onnx)$/i.test(entry))
        fail(`runtime artifact contains forbidden model weight ${child}`);
    }
  }
  if (existsSync(runtimePath)) scan(runtimePath);
  if (!process.exitCode) process.stdout.write(`local-model-runtime: verified ${runtimePath}\n`);
}

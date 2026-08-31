import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

export const EVALUATION_MODEL_ALIAS = 'alyte-gemma-4-e2b-evaluation-v2';
export const EXPECTED_MODEL = Object.freeze({
  filename: 'gemma-4-E2B-it-Q4_0.gguf',
  bytes: 2_841_481_184,
  sha256: '8e30dff3ac4c8434c49a7036fa15564bdbb6044e42bf04550bf1a096ad7e6a52',
});

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function outsideRepository(path: string): boolean {
  const relativePath = relative(repositoryRoot, resolve(path));
  return relativePath === '..' || relativePath.startsWith('../');
}

function externalResolvedPath(path: string, code: string): string {
  const absolute = resolve(path);
  if (!isAbsolute(path) || !outsideRepository(absolute)) throw boundedFailure(code);
  try {
    const link = lstatSync(absolute);
    if (link.isSymbolicLink()) throw boundedFailure(code);
    const actual = realpathSync.native(absolute);
    if (!outsideRepository(actual)) throw boundedFailure(code);
    return actual;
  } catch (error) {
    if (error instanceof Error && error.message === `model-preparation-failed:${code}`) throw error;
    throw boundedFailure('missing');
  }
}

function assertExternalDirectory(path: string): string {
  const absolute = resolve(path);
  if (!isAbsolute(path) || !outsideRepository(absolute)) throw boundedFailure('cache-path');
  if (existsSync(absolute)) return externalResolvedPath(absolute, 'cache-path');
  let ancestor = absolute;
  while (!existsSync(ancestor)) ancestor = resolve(ancestor, '..');
  try {
    const actual = realpathSync.native(ancestor);
    if (!outsideRepository(actual)) throw boundedFailure('cache-path');
  } catch (error) {
    if (error instanceof Error && error.message === 'model-preparation-failed:cache-path')
      throw error;
    throw boundedFailure('cache-path');
  }
  return absolute;
}

function boundedFailure(code: string): Error {
  return new Error(`model-preparation-failed:${code}`);
}

export type ArtifactExpectation = Readonly<{
  readonly filename: string;
  readonly bytes: number;
  readonly sha256: string;
}>;

export type ArtifactVerificationReader = Readonly<{
  stat: (path: string) => { isFile: () => boolean; size: number };
  sha256: (path: string) => Promise<string>;
}>;

const defaultArtifactVerificationReader: ArtifactVerificationReader = {
  stat: (path) => statSync(path),
  sha256: async (path) => {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(path, { highWaterMark: 64 * 1024 }))
      digest.update(chunk);
    return digest.digest('hex');
  },
};

export async function verifyExternalArtifactAgainst(
  modelPath: string,
  expected: ArtifactExpectation,
  reader: ArtifactVerificationReader = defaultArtifactVerificationReader,
): Promise<void> {
  const absolutePath = externalResolvedPath(modelPath, 'path');
  if (absolutePath.split('/').pop() !== expected.filename) throw boundedFailure('filename');
  let stats;
  try {
    stats = reader.stat(absolutePath);
  } catch {
    throw boundedFailure('missing');
  }
  if (!stats.isFile() || stats.size !== expected.bytes) throw boundedFailure('size');
  let hash: string;
  try {
    hash = await reader.sha256(absolutePath);
  } catch {
    throw boundedFailure('read');
  }
  if (hash !== expected.sha256) throw boundedFailure('sha256');
}

export async function verifyExternalArtifact(modelPath: string): Promise<void> {
  await verifyExternalArtifactAgainst(modelPath, EXPECTED_MODEL);
}

export type OllamaCommand = (args: readonly string[]) => void;

export function prepareExternalModel(
  modelPath: string,
  cacheDirectory: string,
  runOllama: OllamaCommand = (args) => {
    execFileSync('ollama', [...args], { stdio: 'ignore' });
  },
): Promise<void> {
  return (async () => {
    await verifyExternalArtifact(modelPath);
    const model = resolve(modelPath);
    const cache = assertExternalDirectory(cacheDirectory);
    try {
      mkdirSync(cache, { recursive: true });
      if (!outsideRepository(realpathSync.native(cache))) throw boundedFailure('cache-path');
    } catch (error) {
      if (error instanceof Error && error.message === 'model-preparation-failed:cache-path')
        throw error;
      throw boundedFailure('cache');
    }
    const modelfile = join(cache, 'Modelfile');
    try {
      if (existsSync(modelfile) && lstatSync(modelfile).isSymbolicLink())
        throw boundedFailure('cache');
      writeFileSync(
        modelfile,
        [
          `FROM ${model}`,
          'PARAMETER num_ctx 2048',
          'PARAMETER temperature 0',
          'PARAMETER top_p 1',
          '',
        ].join('\n'),
        { encoding: 'utf8', mode: 0o600 },
      );
    } catch (error) {
      if (error instanceof Error && error.message === 'model-preparation-failed:cache') throw error;
      throw boundedFailure('cache');
    }
    try {
      runOllama(['create', EVALUATION_MODEL_ALIAS, '--file', modelfile]);
    } catch {
      throw boundedFailure('ollama-create');
    }
  })();
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void (async () => {
    const modelPath = argument('--model');
    const cache = argument('--cache');
    if (modelPath === undefined || cache === undefined) throw boundedFailure('arguments');
    await prepareExternalModel(modelPath, cache);
    process.stdout.write(`prepared ${EVALUATION_MODEL_ALIAS}\n`);
  })().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error && /^model-preparation-failed:[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'model-preparation-failed:unknown\n',
    );
    process.exitCode = 1;
  });
}

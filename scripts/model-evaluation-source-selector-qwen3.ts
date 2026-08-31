import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  isSourceSelectorAggregatePath,
  loopbackCandidatePreflight,
  loopbackSourceSelectorTransport,
  runSourceSelectorQwen3,
  writeSourceSelectorAggregate,
} from './model-evaluation-source-selector';

const DEFAULT_MODEL_ALIAS = 'alyte-qwen3-1.7b-source-selector-v1';

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

function boundedFailure(code: string): Error {
  return new Error(`model-evaluation-failed:${code}`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  void (async () => {
    const output = argument('--output');
    const endpoint = argument('--endpoint') ?? 'http://127.0.0.1:11434/api/generate';
    const modelAlias = argument('--model') ?? DEFAULT_MODEL_ALIAS;
    const artifactPath = argument('--artifact');
    if (output === undefined || !isSourceSelectorAggregatePath(output))
      throw boundedFailure('output-path');
    if (artifactPath === undefined) throw boundedFailure('artifact-path');
    const report = await runSourceSelectorQwen3({
      modelAlias,
      artifactPath,
      transport: loopbackSourceSelectorTransport(endpoint),
      preflight: loopbackCandidatePreflight('qwen3', modelAlias, endpoint),
    });
    writeSourceSelectorAggregate(output, report);
    process.stdout.write('completed Qwen3 source-selector fixtures; aggregate written\n');
  })().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error && /^model-evaluation-failed:[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'model-evaluation-failed:unknown\n',
    );
    process.exitCode = 1;
  });
}

import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  isSourceSelectorAggregatePath,
  loopbackCandidatePreflight,
  loopbackSourceSelectorTransport,
  runSourceSelectorAB,
  writeSourceSelectorAggregate,
} from './model-evaluation-source-selector';

const DEFAULT_QWEN_ALIAS = 'alyte-qwen3.5-source-selector-v1';
const DEFAULT_GEMMA_ALIAS = 'alyte-gemma4-source-selector-v1';

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
    const qwenAlias = argument('--qwen-model') ?? DEFAULT_QWEN_ALIAS;
    const gemmaAlias = argument('--gemma-model') ?? DEFAULT_GEMMA_ALIAS;
    if (output === undefined || !isSourceSelectorAggregatePath(output))
      throw boundedFailure('output-path');
    const transport = loopbackSourceSelectorTransport(endpoint);
    const report = await runSourceSelectorAB({
      qwen: {
        modelAlias: qwenAlias,
        transport,
        preflight: loopbackCandidatePreflight('qwen', qwenAlias, endpoint),
      },
      gemma4: {
        modelAlias: gemmaAlias,
        transport,
        preflight: loopbackCandidatePreflight('gemma4', gemmaAlias, endpoint),
      },
    });
    writeSourceSelectorAggregate(output, report);
    process.stdout.write('completed Qwen and Gemma source-selector fixtures; aggregate written\n');
  })().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error && /^model-evaluation-failed:[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'model-evaluation-failed:unknown\n',
    );
    process.exitCode = 1;
  });
}

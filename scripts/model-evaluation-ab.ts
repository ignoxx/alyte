import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  isExternalAggregatePath,
  loopbackModelPreflight,
  loopbackTransport,
  runProductionAB,
} from './model-evaluation-runner';
import { productionV2Fixtures } from './model-evaluation-v2-fixtures';

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
    if (output === undefined || !isExternalAggregatePath(output))
      throw boundedFailure('output-path');
    const report = await runProductionAB({
      transport: loopbackTransport(endpoint),
      preflight: loopbackModelPreflight(endpoint),
    });
    if (!isExternalAggregatePath(output)) throw boundedFailure('output-path');
    writeFileSync(resolve(output), `${JSON.stringify(report)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    process.stdout.write(`completed ${productionV2Fixtures.length} fixtures for two candidates\n`);
  })().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error && /^model-evaluation-failed:[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'model-evaluation-failed:unknown\n',
    );
    process.exitCode = 1;
  });
}

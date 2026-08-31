import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  isSourceSelectorAggregatePath,
  loopbackCandidatePreflight,
  loopbackSourceSelectorTransport,
  runSourceSelectorLfm2Comparison,
  writeSourceSelectorAggregate,
} from './model-evaluation-source-selector';

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
    const qwen3Artifact = argument('--artifact-qwen3');
    const smallArtifact = argument('--artifact-350m');
    const largeArtifact = argument('--artifact-1.2b');
    const qwen3Alias = argument('--model-qwen3');
    const smallAlias = argument('--model-350m');
    const largeAlias = argument('--model-1.2b');
    if (output === undefined || !isSourceSelectorAggregatePath(output))
      throw boundedFailure('output-path');
    if (qwen3Artifact === undefined || smallArtifact === undefined || largeArtifact === undefined)
      throw boundedFailure('artifact-path');
    if (qwen3Alias === undefined || smallAlias === undefined || largeAlias === undefined)
      throw boundedFailure('model-alias');
    const transport = loopbackSourceSelectorTransport(endpoint);
    const report = await runSourceSelectorLfm2Comparison({
      qwen3: {
        modelAlias: qwen3Alias,
        artifactPath: qwen3Artifact,
        transport,
        preflight: loopbackCandidatePreflight('qwen3', qwen3Alias, endpoint),
      },
      lfm2_350m: {
        modelAlias: smallAlias,
        artifactPath: smallArtifact,
        transport,
        preflight: loopbackCandidatePreflight('lfm2-350m-extract', smallAlias, endpoint),
      },
      lfm2_1_2b: {
        modelAlias: largeAlias,
        artifactPath: largeArtifact,
        transport,
        preflight: loopbackCandidatePreflight('lfm2-1.2b-extract', largeAlias, endpoint),
      },
    });
    writeSourceSelectorAggregate(output, report);
    process.stdout.write(
      'completed fixed-order LFM2 source-selector comparison; aggregate written\n',
    );
  })().catch((error: unknown) => {
    process.stderr.write(
      error instanceof Error && /^model-evaluation-failed:[a-z-]+$/u.test(error.message)
        ? `${error.message}\n`
        : 'model-evaluation-failed:unknown\n',
    );
    process.exitCode = 1;
  });
}

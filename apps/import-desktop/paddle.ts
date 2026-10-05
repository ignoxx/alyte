import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { productionLocalModelManifest as manifest } from '../mobile/src/features/local-models/production-manifest.generated';
import {
  parsePaddleOCRText,
  createPaddleOCRPrompt,
  buildPaddleOCRRetryPlan,
  PADDLEOCR_ADAPTER_VERSION,
  PADDLEOCR_SCHEMA_VERSION,
  PADDLEOCR_PROMPT_VERSION,
  type PaddleOCRExtractor,
} from '../mobile/src/features/local-models/paddleocr';
export const modelRoot = join(homedir(), '.cache/alyte-import-models');
export const modelPaths = {
  model: process.env.ALYTE_PADDLE_MODEL ?? join(modelRoot, manifest.pack.artifact.filename),
  projector:
    process.env.ALYTE_PADDLE_PROJECTOR ?? join(modelRoot, manifest.pack.projector.filename),
  runtime: process.env.ALYTE_PADDLE_RUNTIME ?? '/opt/homebrew/bin/llama-mtmd-cli',
};
export function modelsAvailable() {
  return Object.values(modelPaths).every(existsSync);
}
export async function digest(path: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
// The existing Mac harness names this factory after its original model. This adapter
// implements the current mobile Paddle contract without changing the evaluation default.
export async function createQwenMacDocumentVLM() {
  let verified = false;
  const checkAvailability = async () => {
    if (verified) return;
    if (!modelsAvailable()) throw new Error('paddle-models-unavailable');
    if (
      (await digest(modelPaths.model)) !== manifest.pack.artifact.sha256 ||
      (await digest(modelPaths.projector)) !== manifest.pack.projector.sha256
    )
      throw new Error('paddle-model-integrity');
    verified = true;
  };
  const extractor: PaddleOCRExtractor = {
    adapterVersion: PADDLEOCR_ADAPTER_VERSION,
    schemaVersion: PADDLEOCR_SCHEMA_VERSION,
    provenance: {
      modelVersion: manifest.pack.artifact.revision,
      runtimeVersion: 'mac-llama-mtmd-cli',
      promptVersion: PADDLEOCR_PROMPT_VERSION,
    },
    retryPlan: buildPaddleOCRRetryPlan,
    supports: () => true,
    checkAvailability,
    prepare: async () => {
      await checkAvailability();
      return { release: async () => {} };
    },
    extract: async (input) => {
      if (input.cancellation?.isCancelled()) throw new Error('cancelled');
      const imagePath = input.imageURI.startsWith('file:')
        ? fileURLToPath(input.imageURI)
        : input.imageURI;
      const raw = await new Promise<string>((resolve, reject) => {
        const child = execFile(
          modelPaths.runtime,
          [
            '-m',
            modelPaths.model,
            '--mmproj',
            modelPaths.projector,
            '--image',
            imagePath,
            '-p',
            createPaddleOCRPrompt(),
            '--temp',
            '0',
            '--top-p',
            '1',
            '--top-k',
            '1',
            '--seed',
            '0',
            '-n',
            String(input.maxOutputTokens ?? 4096),
            '--ctx-size',
            '8192',
            '--threads',
            '4',
            '--threads-batch',
            '4',
            '--no-warmup',
            '--no-perf',
            '--repeat-penalty',
            '1.15',
            '--jinja',
          ],
          { timeout: input.timeoutMs ?? 30000, maxBuffer: 2 * 1024 * 1024 },
          (error, stdout) => {
            unsubscribe?.();
            if (error) reject(new Error('paddle-inference-failed'));
            else resolve(stdout);
          },
        );
        const unsubscribe = input.cancellation?.subscribe(() => child.kill('SIGKILL'));
      });
      return parsePaddleOCRText(raw);
    },
  };
  return { extractor, provenance: extractor.provenance };
}

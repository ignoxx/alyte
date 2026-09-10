/**
 * Evaluation-only extractor seam for requests larger than the shipped 2,048-token bound.
 *
 * The prompt and decoder are imported from the production module. This small lifecycle wrapper
 * keeps the larger budget out of the mobile/native production contract while retaining the exact
 * JSON grammar boundary used by the app.
 */
import { canStartAutomatedExtraction } from '../../apps/mobile/src/features/local-models/model';
import type { LocalModelService } from '../../apps/mobile/src/features/local-models/native';
import {
  createDocumentVLMPrompt,
  decodeDocumentVLMRows,
  DocumentVLMUnavailableError,
  DOCUMENT_VLM_PROMPT_VERSION,
  DOCUMENT_VLM_SCHEMA_VERSION,
  type DocumentVLMExtractor,
} from '../../apps/mobile/src/features/local-models/document-vlm';

const OUTPUT_CAPACITY = 131_072;
const DRAIN_TIMEOUT_MS = 1_000;

function waitForSettlement(work: Promise<unknown>, milliseconds: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = work.then(
    () => true,
    () => true,
  );
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  return Promise.race([settled, timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function createEvaluationDocumentVLM(options: {
  readonly models: LocalModelService;
  readonly timeoutMs: number;
  readonly maxOutputTokens: number;
}): DocumentVLMExtractor {
  let activeLeases = 0;
  let activeCancel: (() => void) | null = null;
  let activeWork: Promise<unknown> | null = null;

  async function requireReady(): Promise<void> {
    const state = await options.models.getState();
    if (!canStartAutomatedExtraction(state)) {
      throw new DocumentVLMUnavailableError('The verified document model pack is not installed');
    }
  }

  return {
    adapterVersion: 'alyte.qwen3-vl.document-extractor.v1',
    schemaVersion: DOCUMENT_VLM_SCHEMA_VERSION,
    provenance: {
      modelVersion: options.models.manifest.pack.artifact.revision,
      runtimeVersion: options.models.manifest.runtime.revision,
      promptVersion: DOCUMENT_VLM_PROMPT_VERSION,
    },
    checkAvailability: requireReady,
    supports: () => true,
    prepare: async () => {
      await requireReady();
      const state = await options.models.getState();
      if (!state.loaded) await options.models.load();
      activeLeases += 1;
      let released = false;
      return {
        release: async () => {
          if (released) return;
          released = true;
          activeLeases = Math.max(0, activeLeases - 1);
          if (activeLeases === 0 && activeCancel === null) await options.models.unload();
        },
      };
    },
    extract: async (input) => {
      if (input.cancellation?.isCancelled()) throw new Error('document-vlm-cancelled');
      if (activeLeases === 0) {
        throw new DocumentVLMUnavailableError('The document model is not loaded');
      }
      if (activeWork !== null) throw new Error('document-vlm-runtime-quarantined');
      const requestTimeoutMs = Math.min(options.timeoutMs, input.timeoutMs ?? options.timeoutMs);
      const maxOutputTokens = input.maxOutputTokens ?? options.maxOutputTokens;
      if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
        throw new Error('document-vlm-invalid-timeout');
      }
      if (
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > options.maxOutputTokens
      ) {
        throw new Error('document-vlm-invalid-output-limit');
      }

      const work = Promise.resolve().then(() =>
        options.models.inferImage(createDocumentVLMPrompt(), input.imageURI, {
          maxOutputTokens,
          outputCapacity: OUTPUT_CAPACITY,
        }),
      );
      activeWork = work;
      activeCancel = () => options.models.cancelInference();
      void work.then(
        () => finish(),
        () => finish(),
      );
      let timer: ReturnType<typeof setTimeout> | undefined;
      let timedOut = false;
      let cancelled = false;
      let unsubscribe = () => undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          try {
            activeCancel?.();
          } catch {
            // The bounded timeout remains authoritative if native cancellation fails.
          }
          reject(new Error('document-vlm-timeout'));
        }, requestTimeoutMs);
      });
      const cancellation =
        input.cancellation === undefined
          ? null
          : new Promise<never>((_, reject) => {
              unsubscribe = input.cancellation!.subscribe(() => {
                if (timedOut || cancelled) return;
                cancelled = true;
                try {
                  activeCancel?.();
                } catch {
                  // The caller still observes cancellation even if native stop fails.
                }
                reject(new Error('document-vlm-cancelled'));
              });
            });
      try {
        const raw = await (cancellation === null
          ? Promise.race([work, timeout])
          : Promise.race([work, timeout, cancellation]));
        return decodeDocumentVLMRows(raw);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        unsubscribe();
        if (timedOut || cancelled) await waitForSettlement(work, DRAIN_TIMEOUT_MS);
      }
    },
  };

  function finish(): void {
    activeWork = null;
    activeCancel = null;
    if (activeLeases === 0) void options.models.unload().catch(() => undefined);
  }
}

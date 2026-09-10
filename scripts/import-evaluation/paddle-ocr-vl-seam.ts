import type { HybridRetryPlan } from './hybrid-band-retry';
import type { PipelineResult } from './contract';

/**
 * Versioned evaluation-only boundary for a local PaddleOCR-VL GGUF adapter.
 *
 * The runner invokes a module or executable through this argument contract. The adapter may use
 * `llama-mtmd` and PaddleOCR-VL however it chooses, but it must write an existing
 * `alyte.import-eval.v1` PipelineResult to `--output`. A page with an empty `bands` list is the
 * full-page attempt; a retry plan supplies overlapping normalized bands. Raw model responses and
 * rendered crops belong below `--private-root`; stdout/stderr are discarded by the runner.
 */
export const PADDLE_OCR_VL_SEAM_VERSION =
  'alyte.import-eval.paddle-ocr-vl-llama-mtmd-seam.v1' as const;

export type PaddleAdapterRequest = {
  readonly seamVersion: typeof PADDLE_OCR_VL_SEAM_VERSION;
  readonly reportPath: string;
  readonly reportId: string;
  readonly privateRoot: string;
  readonly outputPath: string;
  readonly planPath: string;
  readonly retry: boolean;
  readonly modelPath: string | null;
  readonly projectorPath: string | null;
  readonly runtimePath: string | null;
  readonly plan: HybridRetryPlan;
};

export type PaddleAdapterResult = PipelineResult & {
  readonly pipeline: PipelineResult['pipeline'] & {
    readonly configuration: PipelineResult['pipeline']['configuration'] & {
      /** Zero-based pages whose model response repeated rows or otherwise requested retry. */
      readonly repetitionDetectedPageIndexes?: readonly number[];
      readonly pageTimings?: readonly {
        readonly pageIndex: number;
        readonly elapsedMs: number;
        readonly status: string;
        readonly attempts?: number;
      }[];
    };
  };
};

/** CLI argument names intentionally stay stable while the adapter implementation evolves. */
export const PADDLE_ADAPTER_ARGUMENTS = Object.freeze([
  '--report',
  '--report-id',
  '--private-root',
  '--output',
  '--plan',
  '--seam-version',
  '--retry',
  '--model',
  '--projector',
  '--runtime',
] as const);

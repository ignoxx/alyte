export type ExtractionProgressGateInput = {
  readonly focused: boolean;
  readonly durableLoaded: boolean;
  readonly modelStateLoaded: boolean;
  readonly modelReady: boolean;
  readonly hasFailure: boolean;
  readonly cancellationRequested: boolean;
  readonly started: boolean;
  readonly completed: boolean;
  readonly modelSetupOpened: boolean;
};

export type ExtractionProgressGateDecision = 'wait' | 'open-model-setup' | 'start-extraction';

/**
 * Keeps progress startup deterministic while the model setup route can temporarily own the
 * screen. Readiness is a prerequisite, not a failure that the extraction operation discovers.
 */
export function extractionProgressGate(
  input: ExtractionProgressGateInput,
): ExtractionProgressGateDecision {
  if (
    !input.focused ||
    !input.durableLoaded ||
    !input.modelStateLoaded ||
    input.hasFailure ||
    input.cancellationRequested ||
    input.started ||
    input.completed
  ) {
    return 'wait';
  }
  if (!input.modelReady) return input.modelSetupOpened ? 'wait' : 'open-model-setup';
  return 'start-extraction';
}

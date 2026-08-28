import type { LabReportExtractionError, LabReportExtractionProgress } from './report-service';

export type ExtractionProgressTerminalDestination =
  | { readonly kind: 'draft'; readonly reportId: string; readonly draftId: string }
  | { readonly kind: 'report'; readonly reportId: string };

export function extractionTerminalNavigationReady(
  destination: ExtractionProgressTerminalDestination | null,
  input: {
    readonly focused: boolean;
    readonly activeOperation: boolean;
    readonly hasFailure: boolean;
  },
): boolean {
  return destination !== null && input.focused && !input.activeOperation && !input.hasFailure;
}

export type ExtractionProgressControllerInput = {
  readonly focused: boolean;
  readonly durableLoaded: boolean;
  readonly modelStateLoaded: boolean;
  readonly modelReady: boolean;
  readonly hasFailure: boolean;
  readonly cancellationRequested: boolean;
  /** The durable operation loaded for this report, if one exists. */
  readonly restoredProgress: LabReportExtractionProgress | null;
  /** Undefined while a restored complete operation's draft lookup is still pending. */
  readonly restoredDraftId: string | null | undefined;
};

type ExtractionProgressControllerDependencies = {
  readonly reportId: string;
  readonly startExtraction: (reportId: string) => Promise<{ readonly id: string }>;
  readonly classifyFailure: (error: unknown) => LabReportExtractionError['reason'];
  readonly openModelSetup: () => void;
  readonly setTerminalDestination: (destination: ExtractionProgressTerminalDestination) => void;
  readonly setActiveOperation: (active: boolean) => void;
  readonly setFailure: (failure: LabReportExtractionError['reason'] | null) => void;
  readonly setModelUnavailable: () => void;
};

/**
 * Owns the one-shot effects behind Extraction Progress. React renders may repeat freely; setup,
 * extraction, and completion navigation remain tied to one report and one operation generation.
 */
export class ExtractionProgressController {
  private mounted = true;
  private focused = false;
  private started = false;
  private completed = false;
  private setupRouteActive = false;
  private automaticSetupAttempted = false;
  private operationGeneration = 0;

  constructor(private readonly dependencies: ExtractionProgressControllerDependencies) {}

  evaluate(input: ExtractionProgressControllerInput): void {
    this.updateFocus(input.focused);
    if (
      !this.mounted ||
      !input.focused ||
      !input.durableLoaded ||
      !input.modelStateLoaded ||
      input.hasFailure ||
      input.cancellationRequested ||
      this.completed
    ) {
      return;
    }
    // A complete durable operation is already finished. It can be restored after relaunch while
    // the report-progress route is still on the stack, so never start extraction a second time.
    // Wait for the screen to resolve its open draft before choosing the draft or report fallback.
    if (!this.started && input.restoredProgress?.status === 'complete') {
      if (input.restoredDraftId === undefined) return;
      this.completed = true;
      this.dependencies.setActiveOperation(false);
      this.dependencies.setFailure(null);
      this.dependencies.setTerminalDestination(
        input.restoredDraftId === null
          ? { kind: 'report', reportId: this.dependencies.reportId }
          : {
              kind: 'draft',
              reportId: this.dependencies.reportId,
              draftId: input.restoredDraftId,
            },
      );
      return;
    }
    if (!input.modelReady) {
      if (!this.automaticSetupAttempted && !this.setupRouteActive) {
        this.automaticSetupAttempted = true;
        this.openModelSetup();
      }
      return;
    }
    if (this.started) return;

    // A successfully restored model ends the contextual gate. A later genuine unavailability can
    // therefore open a fresh setup route for this same report.
    this.automaticSetupAttempted = false;
    this.setupRouteActive = false;
    this.started = true;
    const generation = ++this.operationGeneration;
    this.dependencies.setActiveOperation(true);
    this.dependencies.setFailure(null);
    void Promise.resolve()
      .then(() => this.dependencies.startExtraction(this.dependencies.reportId))
      .then((draft) => this.complete(generation, draft.id))
      .catch((error: unknown) => this.fail(generation, error));
  }

  requestModelSetup(focused: boolean): void {
    this.updateFocus(focused);
    if (!this.mounted || !this.focused || this.setupRouteActive) return;
    this.openModelSetup();
  }

  /** Handles the durable progress event before the pending promise settles. */
  modelBecameUnavailable(): void {
    if (!this.mounted || !this.started || this.completed) return;
    this.started = false;
    this.operationGeneration += 1;
    this.automaticSetupAttempted = false;
    this.setupRouteActive = false;
    this.dependencies.setActiveOperation(false);
    this.dependencies.setFailure(null);
    this.dependencies.setModelUnavailable();
  }

  retry(): void {
    if (!this.mounted) return;
    this.operationGeneration += 1;
    this.started = false;
    this.completed = false;
  }

  dispose(): void {
    this.mounted = false;
    this.operationGeneration += 1;
  }

  private updateFocus(focused: boolean): void {
    if (focused && !this.focused && this.setupRouteActive) this.setupRouteActive = false;
    this.focused = focused;
  }

  private openModelSetup(): void {
    this.setupRouteActive = true;
    this.dependencies.setActiveOperation(false);
    this.dependencies.setFailure(null);
    this.dependencies.openModelSetup();
  }

  private complete(generation: number, draftId: string): void {
    if (!this.isCurrent(generation)) return;
    this.started = false;
    this.completed = true;
    this.dependencies.setActiveOperation(false);
    this.dependencies.setTerminalDestination({
      kind: 'draft',
      reportId: this.dependencies.reportId,
      draftId,
    });
  }

  private fail(generation: number, error: unknown): void {
    if (!this.isCurrent(generation)) return;
    this.started = false;
    this.dependencies.setActiveOperation(false);
    const reason = this.dependencies.classifyFailure(error);
    if (reason === 'model-unavailable') {
      this.automaticSetupAttempted = false;
      this.setupRouteActive = false;
      this.dependencies.setFailure(null);
      this.dependencies.setModelUnavailable();
      return;
    }
    this.dependencies.setFailure(reason);
  }

  private isCurrent(generation: number): boolean {
    return this.mounted && generation === this.operationGeneration;
  }
}

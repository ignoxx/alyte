export const INTAKE_CLOUD_CONSENT_POLICY_VERSION = 'intake-image-disclosure-v1';

export type IntakeCloudMode = 'local-only' | 'consented-cloud';

export type IntakeCloudJobState =
  | 'queued'
  | 'uploading'
  | 'submitted'
  | 'processing'
  | 'ready'
  | 'applied'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type IntakeCloudJob = {
  readonly id: string;
  readonly eventId: string;
  readonly operation: 'intake-image';
  readonly mediaPath: string;
  readonly state: IntakeCloudJobState;
  readonly consentPolicyVersion: string;
  readonly failureCategory: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly submittedAt: string | null;
  readonly cancelledAt: string | null;
};

export type IntakeCapturePreferences = {
  readonly cloudMode: IntakeCloudMode;
  readonly disclosureAcknowledged: boolean;
};

export type IntakeCloudStatus = IntakeCloudJobState | 'local';

export type IntakeCaptureRecovery = {
  readonly captureId: string;
  readonly mediaPath: string;
  readonly mediaHash: string | null;
  readonly mediaSize: number | null;
  readonly mediaProtection: {
    readonly status: 'verified';
    readonly protectedPaths: readonly string[];
    readonly backupExcluded: true;
  } | null;
  readonly event: unknown;
  readonly cloudMode: IntakeCloudMode;
  readonly consentPolicyVersion: string;
  readonly state: 'capturing' | 'staged' | 'committed' | 'failed';
  readonly failureCategory: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
};

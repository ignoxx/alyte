import type { CanonicalId } from './index';
import type { SanitizationRecipe } from './sanitization';

export type LabReportSourceType = 'pdf' | 'image';

/** Durable state for the source document, independent of any structured Lab Record. */
export type LabReportImportState = 'importing' | 'imported' | 'interrupted' | 'failed' | 'deleted';
export type LabReportDeletionState = 'none' | 'requested' | 'failed' | 'complete';

export type LabReportPage = {
  readonly id: string;
  readonly reportId: string;
  readonly pageIndex: number;
  readonly width: number | null;
  readonly height: number | null;
  readonly rotation: number;
  readonly crop: string | null;
  readonly derivedPath: string | null;
};

export type LabReport = {
  readonly id: string;
  readonly sourceType: LabReportSourceType;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize: number | null;
  /** SHA-256 of the protected Original Report. This is never replaced after import. */
  readonly sourceHash: string | null;
  /** A protected app-container path, or null after source deletion/import failure. */
  readonly originalPath: string | null;
  readonly importState: LabReportImportState;
  readonly deletionState: LabReportDeletionState;
  readonly deletionRequestedAt: string | null;
  readonly deletionError: string | null;
  readonly failureReason: string | null;
  readonly encrypted: boolean;
  readonly pageCount: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly importedAt: string | null;
  readonly pages: readonly LabReportPage[];
  readonly labRecordIds: readonly string[];
};

export type CreateLabReportInput = {
  readonly id?: string;
  readonly sourceType: LabReportSourceType;
  readonly originalFilename: string;
  readonly mimeType: string;
  readonly byteSize?: number | null;
  readonly sourceHash?: string | null;
  readonly originalPath?: string | null;
  readonly importState?: LabReportImportState;
  readonly deletionState?: LabReportDeletionState;
  readonly deletionRequestedAt?: string | null;
  readonly deletionError?: string | null;
  readonly failureReason?: string | null;
  readonly encrypted?: boolean;
  readonly pageCount?: number | null;
  readonly importedAt?: string | null;
  readonly pages?: readonly CreateLabReportPageInput[];
};

export type CreateLabReportPageInput = {
  readonly id?: string;
  readonly pageIndex: number;
  readonly width?: number | null;
  readonly height?: number | null;
  readonly rotation?: number;
  readonly crop?: string | null;
  readonly derivedPath?: string | null;
};

export type UpdateLabReportInput = {
  readonly sourceHash?: string | null;
  readonly originalPath?: string | null;
  readonly importState?: LabReportImportState;
  readonly deletionState?: LabReportDeletionState;
  readonly deletionRequestedAt?: string | null;
  readonly deletionError?: string | null;
  readonly failureReason?: string | null;
  readonly encrypted?: boolean;
  readonly pageCount?: number | null;
  readonly importedAt?: string | null;
  readonly pages?: readonly CreateLabReportPageInput[];
};

export type LabReportSourceIntegrity = 'verified' | 'missing' | 'mismatch' | 'not-verifiable';

export type LabReportReference = {
  readonly reportId: string;
  readonly labRecordId: string;
  readonly sourceDeleted: boolean;
  readonly sourceIntegrity: LabReportSourceIntegrity;
  readonly sourceHash: string | null;
};

export type SanitizedReportVerificationState = 'pending' | 'verified' | 'failed' | 'deleted';

/** Metadata for a newly rendered derivative; the Original Report is never replaced by this row. */
export type SanitizedReport = {
  readonly id: string;
  readonly reportId: string;
  readonly recipe: SanitizationRecipe;
  readonly recipeHash: string;
  readonly artifactPath: string | null;
  readonly artifactHash: string | null;
  readonly byteSize: number | null;
  readonly verificationState: SanitizedReportVerificationState;
  readonly verification: SanitizedReportVerification | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly deletedAt: string | null;
};

export type SanitizedReportVerification = {
  readonly selectableText: boolean;
  readonly annotations: boolean;
  readonly attachments: boolean;
  readonly metadata: boolean;
  readonly removableRedactions: boolean;
  /** The artifact was reopened and structurally checked after writing. */
  readonly reloadChecked: boolean;
};

export type CreateSanitizedReportInput = {
  readonly id?: string;
  readonly reportId: string;
  readonly recipe: SanitizationRecipe;
  readonly recipeHash: string;
  readonly artifactPath?: string | null;
  readonly artifactHash?: string | null;
  readonly byteSize?: number | null;
  readonly verificationState?: SanitizedReportVerificationState;
  readonly verification?: SanitizedReportVerification | null;
  readonly failureReason?: string | null;
  readonly deletedAt?: string | null;
};

export type UpdateSanitizedReportInput = Partial<
  Omit<CreateSanitizedReportInput, 'reportId' | 'id'>
>;

export function assertLabReportSourceType(value: LabReportSourceType): void {
  if (value !== 'pdf' && value !== 'image') {
    throw new Error(`Unsupported Lab Report source type: ${value}`);
  }
}

export function assertLabReportImportState(value: LabReportImportState): void {
  if (!['importing', 'imported', 'interrupted', 'failed', 'deleted'].includes(value)) {
    throw new Error(`Invalid Lab Report import state: ${value}`);
  }
}

export function assertLabReportDeletionState(value: LabReportDeletionState): void {
  if (!['none', 'requested', 'failed', 'complete'].includes(value)) {
    throw new Error(`Invalid Lab Report deletion state: ${value}`);
  }
}

export function assertLabReportPage(input: CreateLabReportPageInput): void {
  if (!Number.isInteger(input.pageIndex) || input.pageIndex < 0) {
    throw new Error('Lab Report page index must be a non-negative integer');
  }
  for (const [name, value] of [
    ['width', input.width],
    ['height', input.height],
  ] as const) {
    if (value !== undefined && value !== null && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`Lab Report page ${name} must be positive when provided`);
    }
  }
  if (input.rotation !== undefined && !Number.isFinite(input.rotation)) {
    throw new Error('Lab Report page rotation must be finite');
  }
}

export type LabReportCanonicalLink = {
  readonly reportId: string;
  readonly recordId: string;
  readonly recordCanonicalId?: CanonicalId | null;
};

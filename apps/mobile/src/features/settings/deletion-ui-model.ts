import type { LocalDataCounts } from '../local-controls/model';

/**
 * Keep each local-deletion category tied to its own user-facing label. These are localization
 * keys rather than display strings so the preview stays ready for additional locales.
 */
export const deletionCountLabelKeys = {
  reports: 'settings.deleteCategoryReports',
  reportPages: 'settings.deleteCategoryReportPages',
  sanitizedReports: 'settings.deleteCategorySanitizedReports',
  records: 'settings.deleteCategoryRecords',
  measurements: 'settings.deleteCategoryMeasurements',
  corrections: 'settings.deleteCategoryCorrections',
  extractionDrafts: 'settings.deleteCategoryExtractionDrafts',
  extractionRows: 'settings.deleteCategoryExtractionRows',
  intakeEvents: 'settings.deleteCategoryIntakeEvents',
  intakeComponents: 'settings.deleteCategoryIntakeComponents',
  intakeImages: 'settings.deleteCategoryIntakeImages',
  cloudJobs: 'settings.deleteCategoryCloudJobs',
  captureRecoveries: 'settings.deleteCategoryCaptureRecoveries',
  combinedDeletions: 'settings.deleteCategoryCombinedDeletions',
  exportJobs: 'settings.deleteCategoryExportJobs',
  sanitizationDrafts: 'settings.deleteCategorySanitizationDrafts',
} as const satisfies Record<keyof LocalDataCounts, string>;

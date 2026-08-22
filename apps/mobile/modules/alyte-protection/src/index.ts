export type ProtectionReport = {
  readonly protectedPaths: readonly string[];
  readonly missingSidecarPaths: readonly string[];
};

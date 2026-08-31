export const DIAGNOSTICS_SCHEMA_VERSION = 'alyte.diagnostics.v2' as const;

export const DIAGNOSTIC_FAILURE_CATEGORIES = [
  'database-failed',
  'file-failed',
  'network-unavailable',
  'permission-denied',
  'export-failed',
  'deletion-failed',
  'unknown',
] as const;
export type DiagnosticFailureCategory = (typeof DIAGNOSTIC_FAILURE_CATEGORIES)[number];

export type DiagnosticsPayload = {
  readonly schema: typeof DIAGNOSTICS_SCHEMA_VERSION;
  readonly app: {
    readonly version: string;
    readonly variant: 'development' | 'preview' | 'production';
  };
  readonly platform: {
    readonly name: 'ios';
    readonly osMajor: number | null;
  };
  readonly capabilities: {
    readonly localStorage: 'available' | 'unavailable' | 'unknown';
    readonly protectedFiles: 'available' | 'unavailable' | 'unknown';
  };
  readonly failures: readonly DiagnosticFailureCategory[];
};

const forbiddenDiagnosticKeys = new Set(
  [
    'health',
    'healthData',
    'payload',
    'records',
    'measurements',
    'biomarkers',
    'labels',
    'values',
    'units',
    'notes',
    'ocr',
    'prompt',
    'medication',
    'supplement',
    'intake',
    'filename',
    'path',
    'uri',
    'error',
    'message',
    'id',
  ].map((key) => key.toLowerCase()),
);

function assertSafeObject(value: unknown, location: string): void {
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeObject(item, `${location}[${index}]`));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    if (forbiddenDiagnosticKeys.has(key.toLowerCase())) {
      throw new Error(`Diagnostics field is not allowlisted: ${location}.${key}`);
    }
    assertSafeObject(nested, `${location}.${key}`);
  }
}

function assertKnownObjectKeys(value: unknown, allowed: readonly string[], location: string): void {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return;
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key))
      throw new Error(`Diagnostics field is not allowlisted: ${location}.${key}`);
  }
}

function requiredObject(value: unknown, location: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Diagnostics ${location} is incomplete`);
  }
  return value as Record<string, unknown>;
}

export function assertDiagnosticsPayload(value: unknown): asserts value is DiagnosticsPayload {
  assertSafeObject(value, 'diagnostics');
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Diagnostics payload must be an object');
  }
  const payload = value as Partial<DiagnosticsPayload>;
  assertKnownObjectKeys(
    payload,
    ['schema', 'app', 'platform', 'capabilities', 'failures'],
    'diagnostics',
  );
  const app = requiredObject(payload.app, 'app');
  const platform = requiredObject(payload.platform, 'platform');
  const capabilities = requiredObject(payload.capabilities, 'capabilities');
  assertKnownObjectKeys(app, ['version', 'variant'], 'diagnostics.app');
  assertKnownObjectKeys(platform, ['name', 'osMajor'], 'diagnostics.platform');
  assertKnownObjectKeys(
    capabilities,
    ['localStorage', 'protectedFiles'],
    'diagnostics.capabilities',
  );
  if (payload.schema !== DIAGNOSTICS_SCHEMA_VERSION) {
    throw new Error('Diagnostics schema version is not supported');
  }
  if (
    payload.platform?.name !== 'ios' ||
    typeof app.version !== 'string' ||
    (app.variant !== 'development' && app.variant !== 'preview' && app.variant !== 'production')
  ) {
    throw new Error('Diagnostics payload is incomplete');
  }
  if (typeof platform.osMajor !== 'number' && platform.osMajor !== null) {
    throw new Error('Diagnostics platform version is invalid');
  }
  if (platform.osMajor !== null && (!Number.isInteger(platform.osMajor) || platform.osMajor < 1)) {
    throw new Error('Diagnostics platform version is invalid');
  }
  const capabilityValues = {
    localStorage: ['available', 'unavailable', 'unknown'],
    protectedFiles: ['available', 'unavailable', 'unknown'],
  } as const;
  for (const [key, allowed] of Object.entries(capabilityValues)) {
    if (!allowed.includes(capabilities[key] as never)) {
      throw new Error(`Diagnostics capability ${key} is invalid`);
    }
  }
  if (!Array.isArray(payload.failures)) throw new Error('Diagnostics failures are invalid');
  for (const failure of payload.failures) {
    if (!DIAGNOSTIC_FAILURE_CATEGORIES.includes(failure as DiagnosticFailureCategory)) {
      throw new Error('Diagnostics contains an unsupported failure category');
    }
  }
}

export function createDiagnosticsPayload(input: {
  readonly appVersion: string;
  readonly variant: DiagnosticsPayload['app']['variant'];
  readonly osMajor?: number | null;
  readonly localStorage?: DiagnosticsPayload['capabilities']['localStorage'];
  readonly protectedFiles?: DiagnosticsPayload['capabilities']['protectedFiles'];
  readonly failures?: readonly DiagnosticFailureCategory[];
}): DiagnosticsPayload {
  const payload: DiagnosticsPayload = {
    schema: DIAGNOSTICS_SCHEMA_VERSION,
    app: { version: input.appVersion, variant: input.variant },
    platform: { name: 'ios', osMajor: input.osMajor ?? null },
    capabilities: {
      localStorage: input.localStorage ?? 'unknown',
      protectedFiles: input.protectedFiles ?? 'unknown',
    },
    failures: [...new Set(input.failures ?? [])].sort(),
  };
  assertDiagnosticsPayload(payload);
  return payload;
}

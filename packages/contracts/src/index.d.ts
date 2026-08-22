export declare const CONTRACT_VERSION = '2026-08-01';

export interface HealthResponse {
  readonly status: 'ok';
  readonly contractVersion: typeof CONTRACT_VERSION;
  readonly environment: 'local' | 'production';
}

export interface ShowcaseRequest {
  readonly operation: 'showcase';
  readonly fixtureId: string;
}

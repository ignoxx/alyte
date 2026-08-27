import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type {
  AccountDeletionResponse,
  AccountExportResponse,
  SessionResponse,
  SignOutResponse,
} from '@alyte/contracts';
import { CloudApiError, type CloudApi } from './cloud-api';
import {
  createCloudAccountService,
  type AppleSignInProvider,
  type CloudAccountExportFiles,
} from './service';
import type {
  CloudPendingOperation,
  CloudPendingOperationRepository,
  CloudSessionRepository,
  StoredCloudSession,
} from './session';
import type { ProtectedExportWorkspace } from '../labs/file-service';

const NOW = Date.parse('2026-08-27T12:00:00.000Z');

function response(
  accessToken = 'access-token',
  refreshToken = 'refresh-token',
  accessExpiresAt = '2026-08-27T12:15:00.000Z',
): SessionResponse {
  return {
    accountId: 'account-1',
    accessToken,
    refreshToken,
    tokenType: 'Bearer',
    accessTokenExpiresAt: accessExpiresAt,
    refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
  };
}

function accountExport(): AccountExportResponse {
  return {
    accountId: 'account-1',
    createdAt: '2026-08-27T12:00:00.000Z',
    appleSubject: 'opaque-apple-subject',
    consents: [],
    sessions: [],
    operations: [],
    auditEvents: [],
  };
}

function repository(initial: StoredCloudSession | null = null) {
  let stored = initial;
  const writes: StoredCloudSession[] = [];
  let clears = 0;
  const value: CloudSessionRepository = {
    async read() {
      return stored;
    },
    async write(next) {
      stored = next;
      writes.push(next);
    },
    async clear() {
      stored = null;
      clears += 1;
    },
  };
  return {
    value,
    get stored() {
      return stored;
    },
    writes,
    get clears() {
      return clears;
    },
  };
}

function pendingRepository(initial: CloudPendingOperation | null = null) {
  let stored = initial;
  const writes: CloudPendingOperation[] = [];
  let clears = 0;
  const value: CloudPendingOperationRepository = {
    async read() {
      return stored;
    },
    async write(next) {
      stored = next;
      writes.push(next);
    },
    async clear() {
      stored = null;
      clears += 1;
    },
  };
  return {
    value,
    get stored() {
      return stored;
    },
    writes,
    get clears() {
      return clears;
    },
  };
}

function exportFiles() {
  const workspace: ProtectedExportWorkspace = {
    stagingPath: '/protected/exports/cloud-account.partial',
    portableStagingReference: 'protected://exports/cloud-account.partial',
    archivePartialPath: '/protected/exports/cloud-account.zip.partial',
    archivePath: '/protected/exports/cloud-account.zip',
    portableArchiveReference: 'protected://exports/cloud-account.zip',
  };
  const writes: string[] = [];
  let cleanups = 0;
  const value: CloudAccountExportFiles = {
    async createExportWorkspace() {
      return workspace;
    },
    async writeExportFile(_workspace, _relativePath, contents) {
      writes.push(contents);
      return {
        path: 'file:///protected/exports/cloud-account.partial/account-metadata.json',
        relativePath: 'account-metadata.json',
        sourceHash: 'hash',
        byteSize: contents.length,
      };
    },
    async removeExportArtifacts() {
      cleanups += 1;
    },
  };
  return {
    value,
    writes,
    get cleanups() {
      return cleanups;
    },
  };
}

function api(overrides: Partial<CloudApi> = {}): CloudApi & {
  refreshCalls: string[];
  signOutCalls: string[];
  deleteCalls: string[];
} {
  const refreshCalls: string[] = [];
  const signOutCalls: string[] = [];
  const deleteCalls: string[] = [];
  return {
    refreshCalls,
    signOutCalls,
    deleteCalls,
    async exchangeApple() {
      return response();
    },
    async refresh(refreshToken) {
      refreshCalls.push(refreshToken);
      return response('rotated-access', 'rotated-refresh');
    },
    async signOut(accessToken) {
      signOutCalls.push(accessToken);
      return { signedOut: true } satisfies SignOutResponse;
    },
    async exportAccount() {
      return accountExport();
    },
    async deleteAccount(accessToken, key) {
      deleteCalls.push(`${accessToken}:${key ?? ''}`);
      return { deleted: true } satisfies AccountDeletionResponse;
    },
    ...overrides,
  };
}

const apple: AppleSignInProvider = {
  async isAvailable() {
    return true;
  },
  async signIn() {
    return { identityToken: 'synthetic-apple-token' };
  },
};

describe('cloud account service', () => {
  it('stores only app session material after Apple exchange and never the Apple identity token', async () => {
    const sessions = repository();
    let exchangedToken: string | null = null;
    const cloud = api({
      async exchangeApple(identityToken) {
        exchangedToken = identityToken;
        return response();
      },
    });
    const service = createCloudAccountService({
      repository: sessions.value,
      api: cloud,
      apple,
      now: () => NOW,
    });

    await service.signInWithApple();

    assert.equal(exchangedToken, 'synthetic-apple-token');
    assert.deepEqual(sessions.stored, {
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    assert.equal(JSON.stringify(sessions.stored).includes('synthetic-apple-token'), false);
    assert.equal(service.getSnapshot().signedIn, true);
  });

  it('rotates an expired access session once and retries the account export with the new access token', async () => {
    const sessions = repository({
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T11:59:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    const cloud = api();
    const service = createCloudAccountService({
      repository: sessions.value,
      api: cloud,
      now: () => NOW,
    });

    await service.bootstrap();
    await Promise.all([service.exportAccount(), service.exportAccount()]);

    assert.deepEqual(cloud.refreshCalls, ['refresh-token']);
    assert.equal(sessions.writes.length, 1);
    assert.equal(sessions.stored?.accessToken, 'rotated-access');
  });

  it('prepares the complete account export as a protected temporary artifact and cleans it once', async () => {
    const sessions = repository({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    const files = exportFiles();
    const service = createCloudAccountService({
      repository: sessions.value,
      api: api(),
      exportFiles: files.value,
      now: () => NOW,
    });

    await service.bootstrap();
    const prepared = await service.prepareAccountExport();
    assert.equal(prepared.path.startsWith('file:///protected/'), true);
    assert.equal(files.writes[0]?.includes('opaque-apple-subject'), true);
    await Promise.all([prepared.cleanup(), prepared.cleanup()]);
    assert.equal(files.cleanups, 1);
  });

  it('keeps the local mode boundary usable when a restored session cannot refresh offline', async () => {
    const sessions = repository({
      accessToken: 'expired-access',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T11:59:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    const cloud = api({
      async refresh() {
        throw new CloudApiError(0, 'offline');
      },
    });
    const service = createCloudAccountService({
      repository: sessions.value,
      api: cloud,
      now: () => NOW,
    });

    await service.bootstrap();

    assert.equal(service.getSnapshot().status, 'offline');
    assert.equal(service.getSnapshot().signedIn, true);
    assert.notEqual(sessions.stored, null);
  });

  it('refreshes once after session_invalid and retries deletion with the same idempotency key', async () => {
    const sessions = repository({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    const deleteAttempts: string[] = [];
    const cloud = api({
      async deleteAccount(accessToken, key) {
        deleteAttempts.push(`${accessToken}:${key ?? ''}`);
        if (deleteAttempts.length === 1) throw new CloudApiError(401, 'session_invalid');
        return { deleted: true };
      },
    });
    const service = createCloudAccountService({
      repository: sessions.value,
      pendingOperations: pendingRepository().value,
      api: cloud,
      now: () => NOW,
    });

    await service.bootstrap();
    await service.deleteAccount('stable-delete-key');

    assert.deepEqual(cloud.refreshCalls, ['refresh-token']);
    assert.deepEqual(deleteAttempts, [
      'access-token:stable-delete-key',
      'rotated-access:stable-delete-key',
    ]);
    assert.equal(service.getSnapshot().signedIn, false);
  });

  it('maps Apple cancellation without leaving a working state', async () => {
    const sessions = repository();
    const cancelledApple: AppleSignInProvider = {
      async isAvailable() {
        return true;
      },
      async signIn() {
        throw new Error('ERR_REQUEST_CANCELED');
      },
    };
    const service = createCloudAccountService({
      repository: sessions.value,
      api: api(),
      apple: cancelledApple,
      now: () => NOW,
    });

    await assert.rejects(service.signInWithApple(), (error: unknown) => {
      assert.ok(error instanceof CloudApiError);
      assert.equal(error.code, 'identity_cancelled');
      return true;
    });
    assert.equal(service.getSnapshot().status, 'signed-out');
    assert.equal(service.getSnapshot().signedIn, false);
  });

  it('clears device session on sign-out even when remote revocation is offline', async () => {
    const sessions = repository({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    const cloud = api({
      async signOut() {
        throw new CloudApiError(0, 'offline');
      },
    });
    const service = createCloudAccountService({
      repository: sessions.value,
      api: cloud,
      now: () => NOW,
    });

    await service.bootstrap();
    await assert.rejects(service.signOut(), /offline/);
    assert.equal(sessions.clears, 1);
    assert.equal(service.getSnapshot().signedIn, false);
  });

  it('preserves the session after an unconfirmed deletion and clears it after deleted:true', async () => {
    const sessions = repository({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    let deleteAttempts = 0;
    const cloud = api({
      async deleteAccount() {
        deleteAttempts += 1;
        if (deleteAttempts === 1) throw new CloudApiError(0, 'offline');
        return { deleted: true };
      },
    });
    const service = createCloudAccountService({
      repository: sessions.value,
      pendingOperations: pendingRepository().value,
      api: cloud,
      now: () => NOW,
    });

    await service.bootstrap();
    await assert.rejects(service.deleteAccount('stable-delete-key'), /offline/);
    assert.equal(service.getSnapshot().signedIn, true);
    assert.equal(sessions.clears, 0);

    await service.deleteAccount('stable-delete-key');
    assert.equal(service.getSnapshot().signedIn, false);
    assert.equal(sessions.clears, 1);
  });

  it('restores a pending deletion key across service recreation and clears it only after confirmation', async () => {
    const sessions = repository({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
      refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
    });
    const pending = pendingRepository();
    const firstApi = api({
      async deleteAccount() {
        throw new CloudApiError(0, 'offline');
      },
    });
    const first = createCloudAccountService({
      repository: sessions.value,
      pendingOperations: pending.value,
      api: firstApi,
      now: () => NOW,
    });
    await first.bootstrap();
    await assert.rejects(first.deleteAccount('stable-delete-key'), /offline/);
    assert.equal(pending.stored?.idempotencyKey, 'stable-delete-key');

    const secondApi = api();
    const second = createCloudAccountService({
      repository: sessions.value,
      pendingOperations: pending.value,
      api: secondApi,
      now: () => NOW,
    });
    await second.bootstrap();
    await second.deleteAccount();
    assert.equal(secondApi.deleteCalls[0]?.endsWith(':stable-delete-key'), true);
    assert.equal(pending.stored, null);
    assert.equal(pending.clears, 1);
  });
});

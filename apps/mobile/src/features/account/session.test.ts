import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCloudPendingOperationRepository,
  createCloudSessionRepository,
  decodeStoredCloudSession,
} from './session';

const session = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  accessTokenExpiresAt: '2026-08-27T12:15:00.000Z',
  refreshTokenExpiresAt: '2026-09-26T12:00:00.000Z',
};

describe('SecureStore cloud session repository', () => {
  it('persists and clears a token-only envelope through the narrow adapter', async () => {
    const values = new Map<string, string>();
    const repository = createCloudSessionRepository({
      async getItemAsync(key) {
        return values.get(key) ?? null;
      },
      async setItemAsync(key, value) {
        values.set(key, value);
      },
      async deleteItemAsync(key) {
        values.delete(key);
      },
    });

    await repository.write(session);
    assert.deepEqual(await repository.read(), session);
    assert.deepEqual(JSON.parse(values.values().next().value as string), session);
    await repository.clear();
    assert.equal(await repository.read(), null);
  });

  it('fails closed and removes a malformed SecureStore envelope', async () => {
    const values = new Map<string, string>();
    let deletes = 0;
    const repository = createCloudSessionRepository({
      async getItemAsync(key) {
        return values.get(key) ?? null;
      },
      async setItemAsync(key, value) {
        values.set(key, value);
      },
      async deleteItemAsync(key) {
        deletes += 1;
        values.delete(key);
      },
    });
    values.set('alyte.cloud.session.v1', '{"accessToken":"only"}');

    assert.equal(await repository.read(), null);
    assert.equal(deletes, 1);
    assert.throws(
      () => decodeStoredCloudSession('{"refreshToken":"only"}'),
      /Invalid cloud session/,
    );
  });

  it('keeps only the minimal pending deletion marker in SecureStore', async () => {
    const values = new Map<string, string>();
    const repository = createCloudPendingOperationRepository({
      async getItemAsync(key) {
        return values.get(key) ?? null;
      },
      async setItemAsync(key, value) {
        values.set(key, value);
      },
      async deleteItemAsync(key) {
        values.delete(key);
      },
    });

    await repository.write({
      kind: 'account-delete',
      idempotencyKey: 'stable-delete-key',
      createdAt: '2026-08-27T12:00:00.000Z',
    });
    assert.deepEqual(JSON.parse(values.get('alyte.cloud.pending-operation.v1') as string), {
      kind: 'account-delete',
      idempotencyKey: 'stable-delete-key',
      createdAt: '2026-08-27T12:00:00.000Z',
    });
    assert.deepEqual(await repository.read(), {
      kind: 'account-delete',
      idempotencyKey: 'stable-delete-key',
      createdAt: '2026-08-27T12:00:00.000Z',
    });
    await repository.clear();
    assert.equal(await repository.read(), null);
  });
});

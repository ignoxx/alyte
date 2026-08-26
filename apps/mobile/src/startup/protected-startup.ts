import type { SnapshotShieldBridge } from '../features/app-lock/shield';

export type ProtectedStartupAttempt<T> =
  | { readonly kind: 'ready'; readonly value: T }
  | { readonly kind: 'recovery'; readonly error: Error };

export function attemptProtectedStartup<T>(construct: () => T): ProtectedStartupAttempt<T> {
  try {
    return { kind: 'ready', value: construct() };
  } catch (error) {
    return {
      kind: 'recovery',
      error: error instanceof Error ? error : new Error('Alyte startup failed'),
    };
  }
}

/** Coordinates the only safe reveal path for the opaque, non-health recovery surface. */
export function createStartupRecoveryHandoff(shield: SnapshotShieldBridge) {
  let mounted = false;

  return {
    markMounted(): void {
      mounted = true;
      shield.markReactGateMounted();
    },
    async clearWhenActive(status: string | null): Promise<boolean> {
      if (!mounted || status !== 'active') return false;
      try {
        await shield.clear();
        return true;
      } catch {
        return false;
      }
    },
  };
}

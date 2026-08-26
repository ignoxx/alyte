/**
 * The local lab and intake repositories intentionally share one SQLite file.
 * Serialize the first opens so their migrations cannot race on a fresh install.
 * Each caller still owns the returned connection; this only orders factory work.
 */
export function createSerializedFactory(): <T>(factory: () => Promise<T>) => Promise<T> {
  let tail: Promise<void> = Promise.resolve();

  return <T>(factory: () => Promise<T>): Promise<T> => {
    const next = tail.then(factory);
    // Keep the queue usable after a failed open. The caller decides whether its
    // cached promise is retryable; later independent opens must not be blocked.
    tail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
}

export type SharedDatabaseRepositoryFactories<TLabRepository, TIntakeRepository> = {
  readonly repositoryFactory: () => Promise<TLabRepository>;
  readonly intakeRepositoryFactory: () => Promise<TIntakeRepository>;
};

/**
 * Cache each shared-database connection while ordering their first opens. A
 * rejected open is cleared so a user-visible retry can make a fresh attempt.
 */
export function createSharedDatabaseRepositoryFactories<TLabRepository, TIntakeRepository>(
  openLab: () => Promise<TLabRepository>,
  openIntake: () => Promise<TIntakeRepository>,
): SharedDatabaseRepositoryFactories<TLabRepository, TIntakeRepository> {
  const serializeDatabaseOpen = createSerializedFactory();
  let repositoryPromise: Promise<TLabRepository> | null = null;
  const repositoryFactory = () => {
    repositoryPromise ??= serializeDatabaseOpen(openLab);
    const pending = repositoryPromise;
    void pending.catch(() => {
      if (repositoryPromise === pending) repositoryPromise = null;
    });
    return repositoryPromise;
  };
  let intakeRepositoryPromise: Promise<TIntakeRepository> | null = null;
  const intakeRepositoryFactory = () => {
    intakeRepositoryPromise ??= serializeDatabaseOpen(openIntake);
    const pending = intakeRepositoryPromise;
    void pending.catch(() => {
      if (intakeRepositoryPromise === pending) intakeRepositoryPromise = null;
    });
    return intakeRepositoryPromise;
  };

  return { repositoryFactory, intakeRepositoryFactory };
}

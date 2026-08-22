export interface JobRunner {
  start(): void;
  stop(): void;
}

/**
 * The foundation keeps the worker lifecycle explicit while later tickets add durable jobs.
 * No health payloads are accepted or retained by this placeholder runner.
 */
export function createJobRunner(): JobRunner {
  return {
    start() {
      // The durable queue is introduced by the cloud lane.
    },
    stop() {
      // The durable queue is introduced by the cloud lane.
    },
  };
}

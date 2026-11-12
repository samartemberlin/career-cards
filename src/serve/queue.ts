export type Queue = { push(job: () => Promise<void>): boolean; idle(): Promise<void> };

/** One job at a time, in order. A full queue refuses the job; the caller logs the drop. */
export function createQueue(o: { max: number; log: (s: string) => void }): Queue {
  const waiting: (() => Promise<void>)[] = [];
  let running: Promise<void> | null = null;

  const drain = async (): Promise<void> => {
    for (let job = waiting.shift(); job; job = waiting.shift()) {
      try {
        await job();
      } catch (e) {
        o.log(`queued job failed: ${(e instanceof Error ? e.message : String(e)).split('\n')[0]}`);
      }
    }
    running = null;
  };

  return {
    push(job) {
      if (waiting.length >= o.max) return false;
      waiting.push(job);
      running ??= drain();
      return true;
    },
    async idle() {
      while (running) await running;
    },
  };
}

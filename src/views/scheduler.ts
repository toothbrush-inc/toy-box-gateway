// Background refresh: one unref'd interval timer per scheduled view. Errors
// land in snapshots (the run fn never rejects into the timer).

export class ViewScheduler {
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly run: (id: string) => Promise<void>,
    private readonly log: (line: string) => void,
  ) {}

  start(id: string, intervalMs: number): void {
    this.stop(id);
    const timer = setInterval(() => {
      void this.run(id).catch((error: unknown) => {
        this.log(
          `[gateway] view '${id}' scheduled run failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
    }, intervalMs);
    timer.unref();
    this.timers.set(id, timer);
  }

  stop(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) {
      clearInterval(timer);
      this.timers.delete(id);
    }
  }

  stopAll(): void {
    for (const id of [...this.timers.keys()]) {
      this.stop(id);
    }
  }
}

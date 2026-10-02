/** Discrete-event clock: overlapping HTTP waits overlap in simulated time. */
export class VirtualClock {
  now = Date.now();
  private timers: Array<{ at: number; resolve: () => void }> = [];
  private scheduled = false;
  sleep = (ms: number): Promise<void> => new Promise((resolve) => {
    this.timers.push({ at: this.now + ms, resolve });
    this.schedule();
  });
  private schedule(): void {
    if (this.scheduled || !this.timers.length) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.now = Math.min(...this.timers.map((timer) => timer.at));
      const due = this.timers.filter((timer) => timer.at === this.now);
      this.timers = this.timers.filter((timer) => timer.at !== this.now);
      for (const timer of due) timer.resolve();
      this.schedule();
    });
  }
}
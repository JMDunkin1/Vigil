export class InFlightCoalescer<TKey, TResult> {
  private readonly active = new Map<TKey, Promise<TResult>>();

  run(key: TKey, operation: () => Promise<TResult>): Promise<TResult> {
    const existing = this.active.get(key);
    if (existing) return existing;

    const started = Promise.resolve().then(operation);
    this.active.set(key, started);
    void started.then(
      () => this.clear(key, started),
      () => this.clear(key, started)
    );
    return started;
  }

  private clear(key: TKey, operation: Promise<TResult>): void {
    if (this.active.get(key) === operation) this.active.delete(key);
  }
}

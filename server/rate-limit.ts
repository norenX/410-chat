export class SlidingWindowLimiter {
  private readonly entries = new Map<string, number[]>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number
  ) {}

  take(key: string, now = Date.now()): boolean {
    const cutoff = now - this.windowMs;
    const recent = (this.entries.get(key) || []).filter((time) => time > cutoff);
    if (recent.length >= this.limit) {
      this.entries.set(key, recent);
      return false;
    }
    recent.push(now);
    this.entries.set(key, recent);
    return true;
  }

  prune(now = Date.now()): void {
    const cutoff = now - this.windowMs;
    for (const [key, values] of this.entries) {
      const recent = values.filter((time) => time > cutoff);
      if (recent.length) this.entries.set(key, recent);
      else this.entries.delete(key);
    }
  }

  clear(): void {
    this.entries.clear();
  }
}

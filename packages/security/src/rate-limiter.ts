interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class RateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private total = 0;
  constructor(
    private readonly defaultRate: number,
    private readonly maxTotal?: number,
  ) {}

  consume(host: string, rate = this.defaultRate, now = Date.now()): void {
    if (this.maxTotal !== undefined && this.total >= this.maxTotal)
      throw new Error("Global request limit exceeded");
    const capacity = Math.max(1, rate);
    const bucket = this.buckets.get(host) ?? { tokens: capacity, updatedAt: now };
    bucket.tokens = Math.min(capacity, bucket.tokens + ((now - bucket.updatedAt) / 1000) * rate);
    bucket.updatedAt = now;
    if (bucket.tokens < 1) throw new Error(`Rate limit exceeded for ${host}`);
    bucket.tokens -= 1;
    this.buckets.set(host, bucket);
    this.total++;
  }
}

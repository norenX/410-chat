import { describe, expect, it } from "vitest";
import { SlidingWindowLimiter } from "../../server/rate-limit.js";
import { configFromEnv } from "../../server/config.js";

describe("SlidingWindowLimiter", () => {
  it("rejects excess actions and permits them after the window", () => {
    const limiter = new SlidingWindowLimiter(2, 1000);
    expect(limiter.take("same-ip", 1000)).toBe(true);
    expect(limiter.take("same-ip", 1100)).toBe(true);
    expect(limiter.take("same-ip", 1200)).toBe(false);
    expect(limiter.take("same-ip", 2101)).toBe(true);
  });
});

describe("410 defaults", () => {
  it("uses a 15-second disconnect grace and a 30-minute hard TTL", () => {
    const config = configFromEnv({});
    expect(config.disconnectGraceMs).toBe(15_000);
    expect(config.hardTtlMs).toBe(30 * 60 * 1000);
    expect(config.metricsFile).toBe("/data/metrics.json");
  });
});

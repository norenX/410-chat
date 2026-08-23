import { randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join } from "node:path";
import { TRAFFIC_SOURCES, type TrafficSource } from "./attribution.js";

export const METRIC_NAMES = [
  "homepage_views",
  "rooms_created",
  "conversations_started",
  "messages_relayed",
  "destroyed_manual",
  "destroyed_disconnect",
  "destroyed_ttl",
  "responses_410"
] as const;

export type MetricName = typeof METRIC_NAMES[number];
export type MetricCounts = Record<MetricName, number>;

export const SOURCE_METRIC_NAMES = [
  "homepage_views",
  "rooms_created",
  "conversations_started",
  "messages_relayed"
] as const;

export type SourceMetricName = typeof SOURCE_METRIC_NAMES[number];
export type SourceMetricCounts = Record<SourceMetricName, number>;
export type AttributionSource = TrafficSource | "unattributed";
export type SourceBuckets = Partial<Record<AttributionSource, SourceMetricCounts>>;

interface MetricsDocument {
  version: 2;
  totals: MetricCounts;
  days: Record<string, MetricCounts>;
  sources: {
    totals: SourceBuckets;
    days: Record<string, SourceBuckets>;
  };
}

export interface MetricsSnapshot {
  startedAt: string;
  uptimeSeconds: number;
  now: {
    waiting: number;
    active: number;
  };
  today: MetricCounts;
  totals: MetricCounts;
  sources: {
    today: SourceBuckets;
    totals: SourceBuckets;
  };
}

export interface MetricsStoreOptions {
  flushDelayMs?: number;
  now?: () => number;
  logger?: Pick<Console, "warn">;
}

function emptyCounts(): MetricCounts {
  return Object.fromEntries(METRIC_NAMES.map((name) => [name, 0])) as MetricCounts;
}

function cloneCounts(counts: MetricCounts): MetricCounts {
  return Object.fromEntries(METRIC_NAMES.map((name) => [name, counts[name]])) as MetricCounts;
}

function emptySourceMetricCounts(): SourceMetricCounts {
  return Object.fromEntries(
    SOURCE_METRIC_NAMES.map((name) => [name, 0])
  ) as SourceMetricCounts;
}

function cloneSourceMetricCounts(counts: SourceMetricCounts): SourceMetricCounts {
  return Object.fromEntries(
    SOURCE_METRIC_NAMES.map((name) => [name, counts[name]])
  ) as SourceMetricCounts;
}

function cloneSourceBuckets(buckets: SourceBuckets): SourceBuckets {
  const result: SourceBuckets = {};
  for (const source of [...TRAFFIC_SOURCES, "unattributed"] as AttributionSource[]) {
    const counts = buckets[source];
    if (counts) result[source] = cloneSourceMetricCounts(counts);
  }
  return result;
}

function sourceMetricsFromCounts(counts: MetricCounts): SourceMetricCounts {
  return Object.fromEntries(
    SOURCE_METRIC_NAMES.map((name) => [name, counts[name]])
  ) as SourceMetricCounts;
}

function emptyDocument(): MetricsDocument {
  return {
    version: 2,
    totals: emptyCounts(),
    days: {},
    sources: {
      totals: {},
      days: {}
    }
  };
}

function utcDay(timestamp: number): string {
  return new Date(timestamp).toISOString().slice(0, 10);
}

function isUtcDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function parseCounts(value: unknown): MetricCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const counts = emptyCounts();
  for (const name of METRIC_NAMES) {
    const count = record[name];
    if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
    counts[name] = count as number;
  }
  return counts;
}

function parseSourceMetricCounts(value: unknown): SourceMetricCounts | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const counts = emptySourceMetricCounts();

  for (const name of SOURCE_METRIC_NAMES) {
    const count = record[name];
    if (!Number.isSafeInteger(count) || (count as number) < 0) return null;
    counts[name] = count as number;
  }

  return counts;
}

function isAttributionSource(value: string): value is AttributionSource {
  return value === "unattributed" ||
    (TRAFFIC_SOURCES as readonly string[]).includes(value);
}

function parseSourceBuckets(value: unknown): SourceBuckets | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const buckets: SourceBuckets = {};

  for (const [source, rawCounts] of Object.entries(value as Record<string, unknown>)) {
    if (!isAttributionSource(source)) return null;
    const counts = parseSourceMetricCounts(rawCounts);
    if (!counts) return null;
    buckets[source] = counts;
  }

  return buckets;
}

function parseSourceDays(value: unknown): Record<string, SourceBuckets> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const days: Record<string, SourceBuckets> = {};

  for (const [day, rawBuckets] of Object.entries(value as Record<string, unknown>)) {
    if (!isUtcDay(day)) return null;
    const buckets = parseSourceBuckets(rawBuckets);
    if (!buckets) return null;
    days[day] = buckets;
  }

  return days;
}

function parseDocument(value: unknown): MetricsDocument | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;

  if (record.version !== 1 && record.version !== 2) return null;

  const totals = parseCounts(record.totals);
  if (!totals || !record.days || typeof record.days !== "object" || Array.isArray(record.days)) return null;

  const days: Record<string, MetricCounts> = {};

  for (const [day, rawCounts] of Object.entries(record.days as Record<string, unknown>)) {
    const counts = parseCounts(rawCounts);
    if (!isUtcDay(day) || !counts) return null;
    days[day] = counts;
  }

  if (record.version === 1) {
    const sourceDays: Record<string, SourceBuckets> = {};

    for (const [day, counts] of Object.entries(days)) {
      sourceDays[day] = {
        unattributed: sourceMetricsFromCounts(counts)
      };
    }

    return {
      version: 2,
      totals,
      days,
      sources: {
        totals: {
          unattributed: sourceMetricsFromCounts(totals)
        },
        days: sourceDays
      }
    };
  }

  if (!record.sources || typeof record.sources !== "object" || Array.isArray(record.sources)) return null;

  const sourceRecord = record.sources as Record<string, unknown>;
  const sourceTotals = parseSourceBuckets(sourceRecord.totals);
  const sourceDays = parseSourceDays(sourceRecord.days);

  if (!sourceTotals || !sourceDays) return null;

  return {
    version: 2,
    totals,
    days,
    sources: {
      totals: sourceTotals,
      days: sourceDays
    }
  };
}

export class MetricsStore {
  private data = emptyDocument();
  private readonly flushDelayMs: number;
  private readonly now: () => number;
  private readonly logger: Pick<Console, "warn">;
  private readonly startedAtMs: number;
  private flushTimer?: NodeJS.Timeout;
  private flushPromise?: Promise<void>;
  private dirty = false;
  private closing = false;
  private initialized = false;

  constructor(
    readonly filePath: string,
    options: MetricsStoreOptions = {}
  ) {
    this.flushDelayMs = options.flushDelayMs ?? 1000;
    this.now = options.now ?? Date.now;
    this.logger = options.logger ?? console;
    this.startedAtMs = this.now();
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const decoded = JSON.parse(raw) as unknown;
      const parsed = parseDocument(decoded);
      if (!parsed) throw new Error("invalid metrics schema");
      this.data = parsed;

      if (
        decoded &&
        typeof decoded === "object" &&
        !Array.isArray(decoded) &&
        (decoded as Record<string, unknown>).version === 1
      ) {
        this.dirty = true;
        await this.flush();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        this.logger.warn("[410] metrics file is invalid or unreadable; starting from zero");
      }
      this.data = emptyDocument();
      this.dirty = true;
      await this.flush();
    }
  }

  increment(name: MetricName, timestamp = this.now()): void {
    const day = utcDay(timestamp);
    const daily = this.data.days[day] ?? (this.data.days[day] = emptyCounts());
    this.data.totals[name] = Math.min(Number.MAX_SAFE_INTEGER, this.data.totals[name] + 1);
    daily[name] = Math.min(Number.MAX_SAFE_INTEGER, daily[name] + 1);
    this.dirty = true;
    this.scheduleFlush();
  }

  incrementAttributed(
    name: SourceMetricName,
    source: TrafficSource,
    timestamp = this.now()
  ): void {
    const day = utcDay(timestamp);
    const daily = this.data.days[day] ?? (this.data.days[day] = emptyCounts());

    const totalSource =
      this.data.sources.totals[source] ??
      (this.data.sources.totals[source] = emptySourceMetricCounts());

    const dailySources =
      this.data.sources.days[day] ??
      (this.data.sources.days[day] = {});

    const dailySource =
      dailySources[source] ??
      (dailySources[source] = emptySourceMetricCounts());

    this.data.totals[name] = Math.min(
      Number.MAX_SAFE_INTEGER,
      this.data.totals[name] + 1
    );

    daily[name] = Math.min(
      Number.MAX_SAFE_INTEGER,
      daily[name] + 1
    );

    totalSource[name] = Math.min(
      Number.MAX_SAFE_INTEGER,
      totalSource[name] + 1
    );

    dailySource[name] = Math.min(
      Number.MAX_SAFE_INTEGER,
      dailySource[name] + 1
    );

    this.dirty = true;
    this.scheduleFlush();
  }

  snapshot(nowCounts: { waiting: number; active: number }, timestamp = this.now()): MetricsSnapshot {
    return {
      startedAt: new Date(this.startedAtMs).toISOString(),
      uptimeSeconds: Math.max(0, Math.floor((timestamp - this.startedAtMs) / 1000)),
      now: { waiting: nowCounts.waiting, active: nowCounts.active },
      today: cloneCounts(this.data.days[utcDay(timestamp)] ?? emptyCounts()),
      totals: cloneCounts(this.data.totals),
      sources: {
        today: cloneSourceBuckets(this.data.sources.days[utcDay(timestamp)] ?? {}),
        totals: cloneSourceBuckets(this.data.sources.totals)
      }
    };
  }

  async flush(): Promise<void> {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.flushPromise) {
      await this.flushPromise;
      return;
    }
    if (!this.dirty) return;

    const serialized = `${JSON.stringify(this.data, null, 2)}\n`;
    this.dirty = false;
    this.flushPromise = this.writeAtomically(serialized)
      .catch(() => {
        this.dirty = true;
        this.logger.warn("[410] metrics flush failed; aggregate counters remain in memory");
      })
      .finally(() => {
        this.flushPromise = undefined;
        if (this.dirty && !this.closing) this.scheduleFlush();
      });
    await this.flushPromise;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    if (this.flushPromise) await this.flushPromise;
    if (this.dirty) await this.flush();
  }

  private scheduleFlush(): void {
    if (this.closing || this.flushTimer || this.flushPromise) return;
    this.flushTimer = setTimeout(() => void this.flush(), this.flushDelayMs);
    this.flushTimer.unref();
  }

  private async writeAtomically(serialized: string): Promise<void> {
    const directory = dirname(this.filePath);
    await fs.mkdir(directory, { recursive: true });
    const temporary = join(
      directory,
      `.${basename(this.filePath)}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`
    );
    try {
      await fs.writeFile(temporary, serialized, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await fs.rename(temporary, this.filePath);
    } catch (error) {
      await fs.unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}

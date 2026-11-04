import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GROUP_METRIC_NAMES, METRIC_NAMES, MetricsStore } from "../../server/metrics.js";

const temporaryDirectories: string[] = [];

async function temporaryMetricsFile(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), "410-metrics-unit-"));
  temporaryDirectories.push(directory);
  return join(directory, "metrics.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("MetricsStore", () => {
  it("persists totals across restart and splits daily buckets at UTC midnight", async () => {
    const filePath = await temporaryMetricsFile();
    let now = Date.parse("2026-08-20T23:59:59.900Z");
    const first = new MetricsStore(filePath, { now: () => now, flushDelayMs: 60_000 });
    await first.init();
    first.increment("homepage_views");
    first.increment("rooms_created");
    first.incrementGroup("group_rooms_created");
    now = Date.parse("2026-08-21T00:00:00.100Z");
    first.increment("homepage_views");
    first.increment("messages_relayed");
    first.incrementGroup("group_participants_joined");
    await first.close();

    const persisted = JSON.parse(await fs.readFile(filePath, "utf8")) as {
      version: number;
      totals: Record<string, number>;
      days: Record<string, Record<string, number>>;
    };
    expect(persisted.version).toBe(3);
    expect(Object.keys(persisted.totals)).toEqual([...METRIC_NAMES]);
    expect(Object.keys(persisted.days)).toEqual(["2026-08-20", "2026-08-21"]);
    expect(persisted.days["2026-08-20"].homepage_views).toBe(1);
    expect(persisted.days["2026-08-21"].homepage_views).toBe(1);

    const restarted = new MetricsStore(filePath, { now: () => now });
    await restarted.init();
    const snapshot = restarted.snapshot(
      { waiting: 3, active: 2 },
      now,
      { rooms: 4, participants: 7 }
    );
    expect(snapshot.now).toEqual({ waiting: 3, active: 2 });
    expect(snapshot.today.homepage_views).toBe(1);
    expect(snapshot.today.messages_relayed).toBe(1);
    expect(snapshot.totals.homepage_views).toBe(2);
    expect(snapshot.totals.rooms_created).toBe(1);
    expect(snapshot.totals.messages_relayed).toBe(1);
    expect(snapshot.groups.now).toEqual({ rooms: 4, participants: 7 });
    expect(snapshot.groups.totals.group_rooms_created).toBe(1);
    expect(snapshot.groups.today.group_participants_joined).toBe(1);
    expect(Object.keys(snapshot.groups.totals)).toEqual([...GROUP_METRIC_NAMES]);
    await restarted.close();
  });

  it("migrates version 1 metrics without losing historical counters", async () => {
    const filePath = await temporaryMetricsFile();
    const timestamp = Date.parse("2026-08-23T05:00:00.000Z");

    const totals = Object.fromEntries(
      METRIC_NAMES.map((name) => [name, 0])
    ) as Record<string, number>;

    totals.homepage_views = 394;
    totals.rooms_created = 45;
    totals.conversations_started = 19;
    totals.messages_relayed = 106;
    totals.destroyed_manual = 9;
    totals.destroyed_disconnect = 32;
    totals.destroyed_ttl = 4;
    totals.responses_410 = 54;

    const day = { ...totals };

    await fs.writeFile(
      filePath,
      JSON.stringify({
        version: 1,
        totals,
        days: {
          "2026-08-23": day
        }
      }),
      "utf8"
    );

    const store = new MetricsStore(filePath, {
      now: () => timestamp,
      flushDelayMs: 60_000
    });

    await store.init();

    const snapshot = store.snapshot({ waiting: 0, active: 0 }, timestamp);

    expect(snapshot.totals).toEqual(totals);
    expect(snapshot.today).toEqual(day);

    expect(snapshot.sources.totals.unattributed).toEqual({
      homepage_views: 394,
      rooms_created: 45,
      conversations_started: 19,
      messages_relayed: 106
    });

    expect(snapshot.sources.today.unattributed).toEqual({
      homepage_views: 394,
      rooms_created: 45,
      conversations_started: 19,
      messages_relayed: 106
    });

    await store.close();

    const persisted = JSON.parse(
      await fs.readFile(filePath, "utf8")
    ) as {
      version: number;
      totals: Record<string, number>;
      sources: {
        totals: Record<string, Record<string, number>>;
      };
    };

    expect(persisted.version).toBe(3);
    expect(persisted.totals).toEqual(totals);
    expect(persisted.sources.totals.unattributed).toEqual({
      homepage_views: 394,
      rooms_created: 45,
      conversations_started: 19,
      messages_relayed: 106
    });
  });

  it("warns and starts from zero when the metrics file is damaged", async () => {
    const filePath = await temporaryMetricsFile();
    await fs.writeFile(filePath, "not-json", "utf8");
    const warn = vi.fn();
    const store = new MetricsStore(filePath, {
      now: () => Date.parse("2026-08-20T12:00:00Z"),
      logger: { warn }
    });
    await store.init();
    expect(warn).toHaveBeenCalledOnce();
    expect(store.snapshot({ waiting: 0, active: 0 }).totals).toEqual(
      Object.fromEntries(METRIC_NAMES.map((name) => [name, 0]))
    );
    await store.close();
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).version).toBe(3);
  });

  it("migrates version 2 metrics and starts isolated group counters at zero", async () => {
    const filePath = await temporaryMetricsFile();
    const totals = Object.fromEntries(METRIC_NAMES.map((name) => [name, 2]));
    const sources = {
      totals: {
        direct: {
          homepage_views: 2,
          rooms_created: 2,
          conversations_started: 2,
          messages_relayed: 2
        }
      },
      days: {
        "2026-08-23": {
          direct: {
            homepage_views: 2,
            rooms_created: 2,
            conversations_started: 2,
            messages_relayed: 2
          }
        }
      }
    };
    await fs.writeFile(filePath, JSON.stringify({
      version: 2,
      totals,
      days: { "2026-08-23": totals },
      sources
    }));
    const now = Date.parse("2026-08-23T12:00:00Z");
    const store = new MetricsStore(filePath, { now: () => now });
    await store.init();
    const snapshot = store.snapshot({ waiting: 0, active: 0 });
    expect(snapshot.totals).toEqual(totals);
    expect(snapshot.groups.totals).toEqual(
      Object.fromEntries(GROUP_METRIC_NAMES.map((name) => [name, 0]))
    );
    await store.close();
    expect(JSON.parse(await fs.readFile(filePath, "utf8")).version).toBe(3);
  });
});

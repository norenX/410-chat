import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  normalizeTrafficSource,
  trafficSourceFromPageRequest
} from "../../server/attribution.js";
import { MetricsStore } from "../../server/metrics.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { recursive: true, force: true })
    )
  );
});

describe("traffic attribution", () => {
  it("uses explicit source labels and coarse referrer categories", () => {
    expect(
      trafficSourceFromPageRequest(
        new URL("https://410.chat/?from=pikabu"),
        undefined
      )
    ).toBe("pikabu");

    expect(
      trafficSourceFromPageRequest(
        new URL("https://410.chat/"),
        "https://www.google.com/search?q=410"
      )
    ).toBe("google");

    expect(
      trafficSourceFromPageRequest(
        new URL("http://410.chat/"),
        "https://410.chat/security"
      )
    ).toBe("direct");

    expect(
      trafficSourceFromPageRequest(
        new URL("https://410.chat/"),
        "https://unknown.example/path"
      )
    ).toBe("other");

    expect(normalizeTrafficSource("habr")).toBe("habr");
    expect(normalizeTrafficSource("anything-arbitrary")).toBe("other");
    expect(normalizeTrafficSource(undefined)).toBe("direct");
  });

  it("keeps aggregate funnel counters separated by source", async () => {
    const directory = await mkdtemp(join(tmpdir(), "410-metrics-"));
    temporaryDirectories.push(directory);

    const timestamp = Date.parse("2026-08-23T08:00:00.000Z");

    const metrics = new MetricsStore(
      join(directory, "metrics.json"),
      {
        flushDelayMs: 5,
        now: () => timestamp
      }
    );

    await metrics.init();

    metrics.incrementAttributed("homepage_views", "pikabu");
    metrics.incrementAttributed("rooms_created", "pikabu");
    metrics.incrementAttributed("homepage_views", "google");

    const snapshot = metrics.snapshot(
      { waiting: 0, active: 0 },
      timestamp
    );

    expect(snapshot.today.homepage_views).toBe(2);
    expect(snapshot.today.rooms_created).toBe(1);

    expect(snapshot.sources.today.pikabu).toEqual({
      homepage_views: 1,
      rooms_created: 1,
      conversations_started: 0,
      messages_relayed: 0
    });

    expect(snapshot.sources.today.google).toEqual({
      homepage_views: 1,
      rooms_created: 0,
      conversations_started: 0,
      messages_relayed: 0
    });

    await metrics.close();
  });
});

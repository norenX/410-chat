import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createChatServer, type ChatServer } from "../../server/app.js";
import { configFromEnv } from "../../server/config.js";
import { GROUP_METRIC_NAMES, METRIC_NAMES, type MetricsSnapshot } from "../../server/metrics.js";
import { createLinkSecret, sodiumReady } from "../../client/src/crypto-session.js";
import { WsClient, waitUntil } from "../helpers.js";

const running: ChatServer[] = [];
const temporaryDirectories: string[] = [];

async function start(
  overrides: Partial<ReturnType<typeof configFromEnv>> = {},
  relays?: string[],
  transitions?: string[]
) {
  const metricsDirectory = await fs.mkdtemp(join(tmpdir(), "410-metrics-integration-"));
  temporaryDirectories.push(metricsDirectory);
  const config = {
    ...configFromEnv({}),
    host: "127.0.0.1",
    port: 0,
    hardTtlMs: 5000,
    disconnectGraceMs: 160,
    heartbeatEveryMs: 1000,
    heartbeatStaleMs: 4000,
    maxCreatesPerWindow: 20,
    metricsFile: join(metricsDirectory, "metrics.json"),
    ...overrides
  };
  const server = await createChatServer({
    config,
    devAssets: false,
    hooks: {
      onRelay: (data) => relays?.push(data),
      onTransition: (from, to) => transitions?.push(`${from}->${to}`)
    }
  });
  running.push(server);
  const address = await server.listen();
  return { server, httpUrl: `http://127.0.0.1:${address.port}`, wsUrl: `ws://127.0.0.1:${address.port}/ws` };
}

async function createRoom(httpUrl: string) {
  const response = await fetch(`${httpUrl}/api/rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: httpUrl },
    body: "{}"
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ roomId: string; inviteToken: string; resumeToken: string; expiresAt: number }>;
}

async function getStats(httpUrl: string): Promise<{ response: Response; stats: MetricsSnapshot }> {
  const response = await fetch(`${httpUrl}/__stats`);
  expect(response.status).toBe(200);
  return { response, stats: await response.json() as MetricsSnapshot };
}

function encodeRelayPacket(packet: unknown): string {
  return Buffer.from(JSON.stringify(packet), "utf8").toString("base64url");
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("410 lifecycle", () => {
  it("does not create a room on GET / and distinguishes room URLs from unknown routes", async () => {
    const { server, httpUrl } = await start();
    const home = await fetch(`${httpUrl}/`);
    expect(home.status).toBe(200);
    expect(server.manager.stats().activeRooms).toBe(0);

    const beforeSecurity = (await getStats(httpUrl)).stats;
    const security = await fetch(`${httpUrl}/security`);
    expect(security.status).toBe(200);
    expect(security.headers.get("cache-control")).toBe("no-store");
    await security.text();
    const afterSecurity = (await getStats(httpUrl)).stats;
    expect(afterSecurity.totals).toEqual(beforeSecurity.totals);
    expect(afterSecurity.now).toEqual({ waiting: 0, active: 0 });
    expect(server.manager.stats().activeRooms).toBe(0);

    const howItWorks = await fetch(`${httpUrl}/how-it-works`);
    expect(howItWorks.status).toBe(200);
    expect(howItWorks.headers.get("cache-control")).toBe("no-store");
    expect(await howItWorks.text()).toContain('<div id="root"></div>');
    const afterHowItWorks = (await getStats(httpUrl)).stats;
    expect(afterHowItWorks.totals).toEqual(afterSecurity.totals);
    expect(afterHowItWorks.now).toEqual({ waiting: 0, active: 0 });
    expect(server.manager.stats().activeRooms).toBe(0);

    const adminPage = await fetch(`${httpUrl}/admin/stats`);
    expect(adminPage.status).toBe(200);
    expect(adminPage.headers.get("cache-control")).toBe("no-store");
    expect(adminPage.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await adminPage.text()).toContain('<div id="root"></div>');

    const adminResponse = await fetch(`${httpUrl}/admin/api/stats`);
    expect(adminResponse.status).toBe(200);
    expect(adminResponse.headers.get("cache-control")).toBe("no-store");
    expect(adminResponse.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const adminStats = await adminResponse.json() as Record<string, Record<string, unknown>>;
    expect(Object.keys(adminStats)).toEqual(["direct", "group"]);
    expect(adminStats.direct).toEqual({
      now: afterSecurity.now,
      today: {
        homepage_views: afterSecurity.today.homepage_views,
        rooms_created: afterSecurity.today.rooms_created,
        conversations_started: afterSecurity.today.conversations_started,
        messages_relayed: afterSecurity.today.messages_relayed,
        responses_410: afterSecurity.today.responses_410
      },
      totals: {
        homepage_views: afterSecurity.totals.homepage_views,
        rooms_created: afterSecurity.totals.rooms_created,
        conversations_started: afterSecurity.totals.conversations_started,
        messages_relayed: afterSecurity.totals.messages_relayed,
        responses_410: afterSecurity.totals.responses_410
      }
    });
    expect(adminStats.group).toEqual({
      now: { rooms: 0, people: 0 },
      today: {
        group_rooms_created: 0,
        group_participants_joined: 0,
        group_messages_relayed: 0,
        group_responses_410: 0
      },
      totals: {
        group_rooms_created: 0,
        group_participants_joined: 0,
        group_messages_relayed: 0,
        group_responses_410: 0
      }
    });
    const afterAdmin = (await getStats(httpUrl)).stats;
    expect(afterAdmin.today).toEqual(afterSecurity.today);
    expect(afterAdmin.totals).toEqual(afterSecurity.totals);
    expect(afterAdmin.groups).toEqual(afterSecurity.groups);
    expect(server.manager.stats().activeRooms).toBe(0);

    const invalidRoom = await fetch(`${httpUrl}/r/${"A".repeat(43)}`);
    expect(invalidRoom.status).toBe(410);
    expect(invalidRoom.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(invalidRoom.headers.get("cache-control")).toBe("no-store");
    expect(invalidRoom.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await invalidRoom.text()).toContain("This conversation no longer exists.");
    const afterDirectGone = (await getStats(httpUrl)).stats;
    expect(afterDirectGone.totals.responses_410).toBe(1);
    expect(afterDirectGone.groups.totals.group_responses_410).toBe(0);
    expect(afterDirectGone.groups.totals).toEqual(
      Object.fromEntries(GROUP_METRIC_NAMES.map((name) => [name, 0]))
    );

    const unknown = await fetch(`${httpUrl}/foobar`);
    expect(unknown.status).toBe(404);
  });

  it("counts only encrypted chat ciphertext across handshake, reconnect, malformed relays, and Destroy", async () => {
    await sodiumReady();
    const { httpUrl, wsUrl } = await start({ disconnectGraceMs: 500 });
    const home = await fetch(`${httpUrl}/`);
    expect(home.status).toBe(200);
    await home.text();

    const created = await createRoom(httpUrl);
    const waitingSnapshot = (await getStats(httpUrl)).stats;
    expect(waitingSnapshot.now).toEqual({ waiting: 1, active: 0 });

    const creator = await WsClient.connect(wsUrl, {
      type: "resume",
      roomId: created.roomId,
      resumeToken: created.resumeToken
    });
    await creator.events.waitFor("session");
    const joiner = await WsClient.connect(wsUrl, { type: "join", inviteToken: created.inviteToken });
    const joined = await joiner.events.waitFor("session");
    await creator.events.waitFor("peer_joined");

    const linkSecret = createLinkSecret();
    await creator.setupCrypto("creator", created.roomId, linkSecret);
    await joiner.setupCrypto("joiner", created.roomId, linkSecret);
    creator.crypto!.startAsCreator();
    await Promise.all([creator.established, joiner.established]);
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(0);

    creator.sendEncrypted({ id: "before-reconnect-1", text: "first", sentAt: 1000 });
    await waitUntil(() => joiner.messages.length === 1);
    joiner.sendEncrypted({ id: "before-reconnect-2", text: "second", sentAt: 2000 });
    await waitUntil(() => creator.messages.length === 1);
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(2);

    joiner.close();
    await creator.events.waitFor("peer_disconnected");
    const resumed = await WsClient.connect(wsUrl, {
      type: "resume",
      roomId: created.roomId,
      resumeToken: joined.resumeToken!
    });
    await resumed.events.waitFor("session");
    await creator.events.waitFor("peer_resumed");

    creator.crypto!.destroy();
    joiner.crypto!.destroy();
    await creator.setupCrypto("creator", created.roomId, linkSecret);
    await resumed.setupCrypto("joiner", created.roomId, linkSecret);
    creator.crypto!.startAsCreator();
    await Promise.all([creator.established, resumed.established]);

    const activeSnapshot = (await getStats(httpUrl)).stats;
    expect(activeSnapshot.now).toEqual({ waiting: 0, active: 1 });
    expect(activeSnapshot.totals.conversations_started).toBe(1);
    expect(activeSnapshot.totals.messages_relayed).toBe(2);

    resumed.sendEncrypted({ id: "after-reconnect", text: "third", sentAt: 3000 });
    await waitUntil(() => creator.messages.length === 2);
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(3);

    creator.socket.send(JSON.stringify({
      type: "relay",
      data: Buffer.from("not-json", "utf8").toString("base64url")
    }));
    await resumed.events.waitFor("relay");
    creator.socket.send(JSON.stringify({
      type: "relay",
      data: encodeRelayPacket({ v: 1, kind: "unknown" })
    }));
    await resumed.events.waitFor("relay");
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(3);

    creator.socket.send(JSON.stringify({ type: "destroy" }));
    await Promise.all([creator.events.waitFor("destroyed"), resumed.events.waitFor("destroyed")]);
    const goneResponse = await fetch(`${httpUrl}/r/${created.inviteToken}`);
    expect(goneResponse.status).toBe(410);
    await goneResponse.text();

    const { response, stats } = await getStats(httpUrl);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(Object.keys(stats)).toEqual(["startedAt", "uptimeSeconds", "now", "today", "totals", "sources", "groups"]);
    expect(Object.keys(stats.totals)).toEqual([...METRIC_NAMES]);
    expect(stats.now).toEqual({ waiting: 0, active: 0 });
    expect(stats.totals).toEqual({
      homepage_views: 1,
      rooms_created: 1,
      conversations_started: 1,
      messages_relayed: 3,
      destroyed_manual: 1,
      destroyed_disconnect: 0,
      destroyed_ttl: 0,
      responses_410: 1
    });
    expect(stats.today).toEqual(stats.totals);
    expect(stats.sources.totals.direct).toEqual({
      homepage_views: 1,
      rooms_created: 1,
      conversations_started: 1,
      messages_relayed: 3
    });
    expect(stats.sources.today.direct).toEqual(
      stats.sources.totals.direct
    );

    const serialized = JSON.stringify(stats);
    for (const forbidden of [
      created.roomId,
      created.inviteToken,
      created.resumeToken,
      joined.resumeToken!,
      "127.0.0.1",
      "roomId",
      "inviteToken",
      "resumeToken",
      "connections"
    ]) expect(serialized).not.toContain(forbidden);
  });

  it("creates, consumes one invite, exchanges E2E messages, then irreversibly destroys everything", async () => {
    await sodiumReady();
    const observedRelays: string[] = [];
    const observedTransitions: string[] = [];
    const { server, httpUrl, wsUrl } = await start({}, observedRelays, observedTransitions);
    const created = await createRoom(httpUrl);
    expect(created.roomId).not.toBe(created.inviteToken);
    expect(created.roomId).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(created.inviteToken.length).toBeGreaterThanOrEqual(43);

    const liveInvite = await fetch(`${httpUrl}/r/${created.inviteToken}`);
    expect(liveInvite.status).toBe(200);

    const creator = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: created.resumeToken });
    const creatorSession = await creator.events.waitFor("session");
    expect(creatorSession.state).toBe("WAITING");
    expect(creatorSession.inviteState).toBe("ACTIVE");

    const joiner = await WsClient.connect(wsUrl, { type: "join", inviteToken: created.inviteToken });
    const joinerSession = await joiner.events.waitFor("session");
    expect(joinerSession.state).toBe("ACTIVE");
    expect(joinerSession.inviteState).toBe("CONSUMED");
    await creator.events.waitFor("peer_joined");

    const consumedInvite = await fetch(`${httpUrl}/r/${created.inviteToken}`);
    expect(consumedInvite.status).toBe(410);
    expect(consumedInvite.headers.get("cache-control")).toBe("no-store");
    expect(consumedInvite.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const intruder = await WsClient.connect(wsUrl, { type: "join", inviteToken: created.inviteToken });
      const unavailable = await intruder.events.waitFor("room_gone");
      expect(unavailable.message).toBe("This conversation no longer exists.");
      intruder.close();
    }

    const linkSecret = createLinkSecret();
    await creator.setupCrypto("creator", created.roomId, linkSecret);
    await joiner.setupCrypto("joiner", created.roomId, linkSecret);
    creator.crypto!.startAsCreator();
    await Promise.all([creator.established, joiner.established]);
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(0);
    expect(creator.fingerprint).toBe(joiner.fingerprint);
    expect(creator.fingerprint).toMatch(/^[A-Z]+ — \d{2} — [A-Z]+$/);

    const firstPlaintext = "private words from creator";
    const secondPlaintext = "private answer from joiner";
    creator.sendEncrypted({ id: "message-creator", text: firstPlaintext, sentAt: 1000 });
    await waitUntil(() => joiner.messages.length === 1);
    expect(joiner.messages[0].text).toBe(firstPlaintext);
    joiner.sendEncrypted({ id: "message-joiner", text: secondPlaintext, sentAt: 2000 });
    await waitUntil(() => creator.messages.length === 1);
    expect(creator.messages[0].text).toBe(secondPlaintext);
    expect(observedRelays.join(" ")).not.toContain(firstPlaintext);
    expect(observedRelays.join(" ")).not.toContain(secondPlaintext);
    expect(observedRelays).toHaveLength(6);
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(2);

    creator.socket.send(JSON.stringify({ type: "destroy" }));
    await Promise.all([creator.events.waitFor("destroyed"), joiner.events.waitFor("destroyed")]);
    expect(server.manager.stats()).toEqual({ activeRooms: 0, inviteTokens: 0, connectedSockets: 0, storedMessages: 0 });
    expect(observedTransitions).toEqual(["CREATED->WAITING", "WAITING->ACTIVE", "ACTIVE->DESTROYED"]);
    expect((await getStats(httpUrl)).stats.totals.messages_relayed).toBe(2);

    const destroyedInvite = await fetch(`${httpUrl}/r/${created.inviteToken}`);
    expect(destroyedInvite.status).toBe(410);

    const history = await fetch(`${httpUrl}/api/rooms/${created.roomId}/messages`);
    expect(history.status).toBe(404);
    expect(await history.text()).not.toContain(firstPlaintext);
    const stale = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: created.resumeToken });
    expect((await stale.events.waitFor("room_gone")).message).toBe("This conversation no longer exists.");
    stale.close();
  });

  it("destroys the entire active room after one participant misses the reconnect grace period", async () => {
    const { server, httpUrl, wsUrl } = await start({ disconnectGraceMs: 120 });
    const created = await createRoom(httpUrl);
    const creator = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: created.resumeToken });
    await creator.events.waitFor("session");
    const joiner = await WsClient.connect(wsUrl, { type: "join", inviteToken: created.inviteToken });
    await joiner.events.waitFor("session");
    await creator.events.waitFor("peer_joined");
    joiner.close();
    await creator.events.waitFor("peer_disconnected");
    await creator.events.waitFor("destroyed");
    expect(server.manager.stats().activeRooms).toBe(0);
    const stats = (await getStats(httpUrl)).stats;
    expect(stats.totals.destroyed_disconnect).toBe(1);
    expect(stats.totals.destroyed_manual).toBe(0);
    expect(stats.totals.destroyed_ttl).toBe(0);
  });

  it("allows a credentialed reconnect inside grace, then rekeys without preserving server history", async () => {
    const { server, httpUrl, wsUrl } = await start({ disconnectGraceMs: 500 });
    const created = await createRoom(httpUrl);
    const creator = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: created.resumeToken });
    await creator.events.waitFor("session");
    const joiner = await WsClient.connect(wsUrl, { type: "join", inviteToken: created.inviteToken });
    const joined = await joiner.events.waitFor("session");
    await creator.events.waitFor("peer_joined");
    joiner.close();
    await creator.events.waitFor("peer_disconnected");
    const resumed = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: joined.resumeToken! });
    expect((await resumed.events.waitFor("session")).state).toBe("ACTIVE");
    await creator.events.waitFor("peer_resumed");
    await new Promise((resolve) => setTimeout(resolve, 550));
    expect(server.manager.stats().activeRooms).toBe(1);
    creator.socket.send(JSON.stringify({ type: "destroy" }));
    await resumed.events.waitFor("destroyed");
  });

  it("starts a fresh hard TTL when the conversation becomes active and enforces creation rate limiting", async () => {
    const { server, httpUrl, wsUrl } = await start({ hardTtlMs: 220, maxCreatesPerWindow: 1, createWindowMs: 5000 });
    const created = await createRoom(httpUrl);
    const blocked = await fetch(`${httpUrl}/api/rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: httpUrl },
      body: "{}"
    });
    expect(blocked.status).toBe(429);
    const creator = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: created.resumeToken });
    await creator.events.waitFor("session");
    await new Promise((resolve) => setTimeout(resolve, 120));
    const joiner = await WsClient.connect(wsUrl, { type: "join", inviteToken: created.inviteToken });
    const joined = await joiner.events.waitFor("session");
    expect(joined.expiresAt).toBeGreaterThan(created.expiresAt);
    await creator.events.waitFor("peer_joined");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(server.manager.stats().activeRooms).toBe(1);
    await creator.events.waitFor("destroyed");
    await joiner.events.waitFor("destroyed");
    expect(server.manager.stats().activeRooms).toBe(0);
    const expiredInvite = await fetch(`${httpUrl}/r/${created.inviteToken}`);
    expect(expiredInvite.status).toBe(410);
    expect(expiredInvite.headers.get("cache-control")).toBe("no-store");
    expect(expiredInvite.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    const stats = (await getStats(httpUrl)).stats;
    expect(stats.totals.rooms_created).toBe(1);
    expect(stats.totals.conversations_started).toBe(1);
    expect(stats.totals.destroyed_ttl).toBe(1);
  });

  it("rate limits room creation independently by forwarded client IP when proxy is trusted", async () => {
    const { httpUrl } = await start({
      maxCreatesPerWindow: 1,
      createWindowMs: 5000,
      trustProxy: true
    });

    const createFromIp = (ip: string) =>
      fetch(`${httpUrl}/api/rooms`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: httpUrl,
          "x-forwarded-for": ip
        },
        body: "{}"
      });

    const firstFromA = await createFromIp("203.0.113.10");
    expect(firstFromA.status).toBe(201);

    const secondFromA = await createFromIp("203.0.113.10");
    expect(secondFromA.status).toBe(429);

    const firstFromB = await createFromIp("203.0.113.11");
    expect(firstFromB.status).toBe(201);
  });

  it("ignores forwarded client IP when proxy is not trusted", async () => {
    const { httpUrl } = await start({
      maxCreatesPerWindow: 1,
      createWindowMs: 5000,
      trustProxy: false
    });

    const createFromIp = (ip: string) =>
      fetch(`${httpUrl}/api/rooms`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: httpUrl,
          "x-forwarded-for": ip
        },
        body: "{}"
      });

    const first = await createFromIp("203.0.113.10");
    expect(first.status).toBe(201);

    const spoofedSecondIp = await createFromIp("203.0.113.11");
    expect(spoofedSecondIp.status).toBe(429);
  });

  it("treats heartbeat loss as a disconnect and destroys after grace", async () => {
    const { server, httpUrl, wsUrl } = await start({ heartbeatStaleMs: 90, heartbeatEveryMs: 30, disconnectGraceMs: 100 });
    const created = await createRoom(httpUrl);
    const creator = await WsClient.connect(wsUrl, { type: "resume", roomId: created.roomId, resumeToken: created.resumeToken });
    await creator.events.waitFor("session");
    await waitUntil(() => server.manager.stats().activeRooms === 0, 2000);
    expect(server.manager.stats().storedMessages).toBe(0);
  });
});

import { createHash, randomBytes } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";
import {
  GroupCryptoSession,
  groupSodiumReady,
  isRecoverableGroupCryptoError
} from "../../client/src/group-crypto-session.js";
import { createChatServer, type ChatServer } from "../../server/app.js";
import { configFromEnv } from "../../server/config.js";
import { GROUP_METRIC_NAMES, type MetricsSnapshot } from "../../server/metrics.js";
import type { GroupClientCommand, GroupServerEvent } from "../../shared/group-protocol.js";
import { waitUntil } from "../helpers.js";

const running: ChatServer[] = [];
const temporaryDirectories: string[] = [];

function token(): string {
  return randomBytes(32).toString("base64url");
}

type GroupJoinInput = {
  type: "group_join";
  inviteToken: string;
  browserVerifier?: string;
  tabVerifier?: string;
  ownerCapability?: string;
  ownerRecoverySecret?: string;
};

type GroupAuthInput = GroupJoinInput | Extract<GroupClientCommand, { type: "group_resume" }>;

function normalizedAuth(auth: GroupAuthInput): Extract<GroupClientCommand, { type: "group_join" | "group_resume" }> {
  if (auth.type === "group_resume") return auth;
  return {
    ...auth,
    browserVerifier: auth.browserVerifier || token(),
    tabVerifier: auth.tabVerifier || token()
  };
}

function ownerCredentials(): {
  capability: string;
  verifier: string;
  recoverySecret: string;
  recoveryVerifier: string;
} {
  const capability = token();
  const recoverySecret = token();
  return {
    capability,
    verifier: createHash("sha256").update(Buffer.from(capability, "base64url")).digest("base64url"),
    recoverySecret,
    recoveryVerifier: createHash("sha256").update(Buffer.from(recoverySecret, "base64url")).digest("base64url")
  };
}

async function start(overrides: Partial<ReturnType<typeof configFromEnv>> = {}) {
  const metricsDirectory = await fs.mkdtemp(join(tmpdir(), "410-group-integration-"));
  temporaryDirectories.push(metricsDirectory);
  const server = await createChatServer({
    config: {
      ...configFromEnv({}),
      host: "127.0.0.1",
      port: 0,
      metricsFile: join(metricsDirectory, "metrics.json"),
      groupRoomsEnabled: true,
      groupHardTtlMs: 10_000,
      groupRekeyTimeoutMs: 2_000,
      disconnectGraceMs: 180,
      heartbeatEveryMs: 1_000,
      heartbeatStaleMs: 5_000,
      maxCreatesPerWindow: 50,
      maxConnectionsPerWindow: 100,
      ...overrides
    },
    devAssets: false
  });
  running.push(server);
  const address = await server.listen();
  return {
    server,
    httpUrl: `http://127.0.0.1:${address.port}`,
    wsUrl: `ws://127.0.0.1:${address.port}/group-ws`
  };
}

async function createGroup(httpUrl: string, verifier: string, recoveryVerifier: string) {
  const response = await fetch(`${httpUrl}/api/group-rooms`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: httpUrl },
    body: JSON.stringify({ ownerVerifier: verifier, ownerRecoveryVerifier: recoveryVerifier })
  });
  expect(response.status).toBe(201);
  return response.json() as Promise<{ roomId: string; inviteToken: string; expiresAt: number }>;
}

class GroupEventQueue {
  private readonly events: GroupServerEvent[] = [];
  private readonly waiters: Array<{
    type: GroupServerEvent["type"];
    resolve: (event: GroupServerEvent) => void;
    timer: NodeJS.Timeout;
  }> = [];

  push(event: GroupServerEvent): void {
    const index = this.waiters.findIndex((waiter) => waiter.type === event.type);
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.events.push(event);
  }

  waitFor<T extends GroupServerEvent["type"]>(
    type: T,
    timeoutMs = 3_000
  ): Promise<Extract<GroupServerEvent, { type: T }>> {
    const index = this.events.findIndex((event) => event.type === type);
    if (index >= 0) {
      return Promise.resolve(this.events.splice(index, 1)[0] as Extract<GroupServerEvent, { type: T }>);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({ type, resolve: (event) => resolve(event as Extract<GroupServerEvent, { type: T }>), timer });
    });
  }
}

class RawGroupClient {
  readonly events = new GroupEventQueue();

  protected constructor(readonly socket: WebSocket) {
    socket.on("message", (raw) => this.events.push(JSON.parse(raw.toString()) as GroupServerEvent));
  }

  static async connect(wsUrl: string, auth: GroupAuthInput): Promise<RawGroupClient> {
    const socket = new WebSocket(wsUrl, { origin: wsUrl.replace(/^ws/, "http").replace(/\/group-ws$/, "") });
    const client = new RawGroupClient(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify(normalizedAuth(auth)));
    return client;
  }

  send(command: GroupClientCommand): void {
    this.socket.send(JSON.stringify(command));
  }

  close(): void {
    this.socket.close();
  }
}

class SecureGroupClient {
  readonly events = new GroupEventQueue();
  readonly messages: Array<{ id: string; text: string; sentAt: number }> = [];
  session?: Extract<GroupServerEvent, { type: "group_session" }>;
  crypto?: GroupCryptoSession;
  activeEpoch = 0;
  private pendingRelayId?: string;
  private poisonedReady = false;
  private processing = Promise.resolve();

  private constructor(
    readonly socket: WebSocket,
    private readonly linkSecret: string,
    private readonly options: {
      poisonReadyOnce?: boolean;
      poisonCorrectionDelayMs?: number;
      duplicateAnnouncements?: number;
    } = {}
  ) {
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as GroupServerEvent;
      this.events.push(event);
      this.processing = this.processing.then(() => this.handle(event));
    });
  }

  static async connect(
    wsUrl: string,
    auth: GroupAuthInput,
    linkSecret: string,
    options: {
      poisonReadyOnce?: boolean;
      poisonCorrectionDelayMs?: number;
      duplicateAnnouncements?: number;
    } = {}
  ): Promise<SecureGroupClient> {
    const socket = new WebSocket(wsUrl, { origin: wsUrl.replace(/^ws/, "http").replace(/\/group-ws$/, "") });
    const client = new SecureGroupClient(socket, linkSecret, options);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send(JSON.stringify(normalizedAuth(auth)));
    return client;
  }

  private async handle(event: GroupServerEvent): Promise<void> {
    if (event.type === "group_session") {
      this.session = event;
      this.crypto?.destroy();
      this.crypto = new GroupCryptoSession({
        roomId: event.roomId,
        selfMemberId: event.memberId,
        linkSecret: this.linkSecret,
        callbacks: {
          sendControl: (control) => {
            const command = { type: "group_control", ...control } as const;
            this.send(command);
            if (!control.to) {
              for (let index = 0; index < (this.options.duplicateAnnouncements || 0); index += 1) {
                this.send(command);
              }
            }
          },
          sendReady: (ready) => {
            if (this.options.poisonReadyOnce && !this.poisonedReady) {
              this.poisonedReady = true;
              this.send({ type: "group_ready", ...ready, epochDigest: token() });
              if (this.options.poisonCorrectionDelayMs) {
                setTimeout(() => this.send({ type: "group_ready", ...ready }), this.options.poisonCorrectionDelayMs);
                return;
              }
            }
            this.send({ type: "group_ready", ...ready });
          },
          onActive: ({ epoch }) => { this.activeEpoch = epoch; },
          onMessage: (message) => this.messages.push(message)
        }
      });
      await this.crypto.beginEpoch(event);
      return;
    }
    if (event.type === "group_epoch") {
      this.pendingRelayId = undefined;
      await this.crypto?.beginEpoch(event);
      return;
    }
    if (event.type === "group_control") {
      try {
        this.crypto?.handleControl(event);
      } catch (error) {
        if (!isRecoverableGroupCryptoError(error)) throw error;
      }
    } else if (event.type === "group_epoch_ready") {
      try {
        this.crypto?.handleEpochReady(event);
      } catch (error) {
        if (!isRecoverableGroupCryptoError(error)) throw error;
      }
    } else if (event.type === "group_relay") {
      try {
        this.crypto?.handleApplication(event);
      } catch (error) {
        if (!isRecoverableGroupCryptoError(error)) throw error;
      }
    }
    else if (event.type === "group_relay_accepted" && event.relayId === this.pendingRelayId) {
      this.crypto?.commitOutbound();
      this.pendingRelayId = undefined;
    } else if (event.type === "group_relay_rejected" && event.relayId === this.pendingRelayId) {
      this.crypto?.rejectOutbound();
      this.pendingRelayId = undefined;
    }
  }

  send(command: GroupClientCommand): void {
    this.socket.send(JSON.stringify(command));
  }

  sendMessage(id: string, text: string): void {
    if (this.pendingRelayId) throw new Error("relay pending");
    const encrypted = this.crypto!.encryptMessage({ id, text, sentAt: Date.now() });
    this.pendingRelayId = randomBytes(16).toString("base64url");
    this.send({ type: "group_relay", relayId: this.pendingRelayId, ...encrypted });
  }

  get relayPending(): boolean {
    return Boolean(this.pendingRelayId);
  }

  close(): void {
    this.socket.close();
  }
}

afterEach(async () => {
  await Promise.all(running.splice(0).map((server) => server.close()));
  await Promise.all(temporaryDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe("experimental group room lifecycle", () => {
  it("exchanges E2E messages without history, rekeys on resume, enforces owner destroy, and returns real 410", async () => {
    await groupSodiumReady();
    const { server, httpUrl, wsUrl } = await start();
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const linkSecret = token();
    expect(created.roomId).not.toBe(created.inviteToken);
    expect(created.expiresAt).toBeGreaterThan(Date.now());
    expect((await fetch(`${httpUrl}/g/${created.inviteToken}`)).status).toBe(200);
    const createdStats = await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot;
    expect(createdStats.groups.now).toEqual({ rooms: 1, participants: 0 });
    expect(createdStats.groups.totals.group_rooms_created).toBe(1);
    expect(createdStats.groups.totals.group_participants_joined).toBe(0);

    const a = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      ownerCapability: owner.capability
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 1);
    expect(a.session?.ownerAuthorized).toBe(true);

    const b = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 2 && b.activeEpoch === 2);
    expect(b.session?.ownerAuthorized).toBe(false);

    a.sendMessage("before-c", "visible to A and B only");
    await waitUntil(() => b.messages.length === 1);

    const c = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 3 && b.activeEpoch === 3 && c.activeEpoch === 3);
    expect(c.messages).toEqual([]);
    a.sendMessage("after-c", "visible after C joined");
    await waitUntil(() => b.messages.length === 2 && c.messages.length === 1);

    const cSession = c.session!;
    c.close();
    a.sendMessage("during-gap", "not replayed to C");
    await waitUntil(() => b.messages.length === 3);
    expect(c.messages).toHaveLength(1);

    const resumedC = await SecureGroupClient.connect(wsUrl, {
      type: "group_resume",
      roomId: cSession.roomId,
      memberId: cSession.memberId,
      resumeToken: cSession.resumeToken
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 4 && b.activeEpoch === 4 && resumedC.activeEpoch === 4);
    expect(resumedC.session?.memberId).toBe(cSession.memberId);
    expect(resumedC.messages).toEqual([]);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.totals.group_participants_joined).toBe(3);
    b.sendMessage("after-resume", "fresh epoch");
    await waitUntil(() => a.messages.length === 1 && resumedC.messages.length === 1);

    b.send({ type: "group_destroy", ownerCapability: token() });
    await b.events.waitFor("group_forbidden");
    expect((await fetch(`${httpUrl}/g/${created.inviteToken}`)).status).toBe(200);

    b.send({
      type: "group_relay",
      relayId: randomBytes(16).toString("base64url"),
      epoch: b.activeEpoch,
      epochDigest: b.crypto!.epochDigest!,
      data: Buffer.from(JSON.stringify({ v: 1, kind: "group_ciphertext" })).toString("base64url")
    });
    expect((await b.events.waitFor("group_relay_rejected")).reason).toBe("invalid");

    a.send({ type: "group_destroy", ownerCapability: owner.capability });
    await Promise.all([
      a.events.waitFor("group_destroyed"),
      b.events.waitFor("group_destroyed"),
      resumedC.events.waitFor("group_destroyed")
    ]);
    const gone = await fetch(`${httpUrl}/g/${created.inviteToken}`);
    expect(gone.status).toBe(410);
    expect(gone.headers.get("cache-control")).toBe("no-store");
    expect(gone.headers.get("x-robots-tag")).toBe("noindex, nofollow");

    const statsResponse = await fetch(`${httpUrl}/__stats`);
    const stats = await statsResponse.json() as MetricsSnapshot;
    expect(stats.groups.totals).toMatchObject({
      group_rooms_created: 1,
      group_participants_joined: 3,
      group_conversations_started: 1,
      group_messages_relayed: 4,
      group_destroyed_manual: 1,
      group_destroyed_ttl: 0,
      group_responses_410: 1
    });
    expect(stats.groups.now).toEqual({ rooms: 0, participants: 0 });
    expect(stats.totals.responses_410).toBe(0);
    const serialized = JSON.stringify(stats);
    expect(serialized).not.toContain(created.roomId);
    expect(serialized).not.toContain(created.inviteToken);
    expect(serialized).not.toContain(owner.capability);
    expect(server.groupManager.stats()).toEqual({
      activeRooms: 0,
      inviteTokens: 0,
      resumeTokens: 0,
      participants: 0,
      connectedSockets: 0,
      storedMessages: 0,
      personaMappings: 0,
      usedPersonas: 0
    });
  });

  it("reserves grace slots, survives owner disconnect, rejects spoofed control, and caps membership at ten", async () => {
    const { server, httpUrl, wsUrl } = await start({ groupRekeyTimeoutMs: 60_000, disconnectGraceMs: 120 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const clients: RawGroupClient[] = [];
    const sessions: Array<Extract<GroupServerEvent, { type: "group_session" }>> = [];
    for (let index = 0; index < 10; index += 1) {
      const client = await RawGroupClient.connect(wsUrl, {
        type: "group_join",
        inviteToken: created.inviteToken,
        ...(index === 0 ? { ownerCapability: owner.capability } : {})
      });
      clients.push(client);
      sessions.push(await client.events.waitFor("group_session"));
    }
    expect(server.groupManager.stats().participants).toBe(10);
    expect(new Set(sessions.map((session) => session.persona.nickname)).size).toBe(10);
    expect(new Set(sessions.map((session) => session.persona.color)).size).toBe(10);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot).groups).toMatchObject({
      now: { rooms: 1, participants: 10 },
      totals: { group_participants_joined: 10 }
    });

    const eleventh = await RawGroupClient.connect(wsUrl, { type: "group_join", inviteToken: created.inviteToken });
    expect((await eleventh.events.waitFor("group_room_full")).maxParticipants).toBe(10);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.totals.group_participants_joined).toBe(10);
    expect((await fetch(`${httpUrl}/g/${created.inviteToken}`)).status).toBe(200);

    const sender = clients[1]!;
    let currentEpoch: Pick<Extract<GroupServerEvent, { type: "group_epoch" }>, "epoch" | "rosterDigest"> = sessions[1]!;
    for (let index = 2; index < 10; index += 1) {
      currentEpoch = await sender.events.waitFor("group_epoch");
    }
    const otherMemberId = sessions[2]!.memberId;
    sender.send({
      type: "group_control",
      epoch: currentEpoch.epoch,
      rosterDigest: currentEpoch.rosterDigest,
      data: Buffer.from(JSON.stringify({
        v: 1,
        kind: "key_announcement",
        memberId: otherMemberId,
        publicKey: token(),
        authTag: token()
      })).toString("base64url")
    });
    expect((await sender.events.waitFor("group_protocol_error")).code).toBe("invalid_control");

    sender.send({
      type: "group_ready",
      epoch: currentEpoch.epoch - 1,
      rosterDigest: currentEpoch.rosterDigest,
      epochDigest: token()
    });
    expect((await sender.events.waitFor("group_protocol_error")).code).toBe("stale_epoch");

    clients[0]!.close();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(server.groupManager.stats().activeRooms).toBe(1);
    expect(server.groupManager.stats().participants).toBe(10);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.now.participants).toBe(10);
    await waitUntil(() => server.groupManager.stats().participants === 9, 1_000);
    expect(server.groupManager.stats().activeRooms).toBe(1);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.now.participants).toBe(9);
    expect((await fetch(`${httpUrl}/g/${created.inviteToken}`)).status).toBe(200);
    for (const client of clients.slice(1)) client.close();
  });

  it("assigns room-scoped personas and enforces three live sessions per browser", async () => {
    const { server, httpUrl, wsUrl } = await start({ groupRekeyTimeoutMs: 60_000, disconnectGraceMs: 100 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const browserVerifier = token();
    const firstTabVerifier = token();

    const primary = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: firstTabVerifier,
      ownerCapability: owner.capability,
      ownerRecoverySecret: owner.recoverySecret
    });
    const primarySession = await primary.events.waitFor("group_session");
    expect(primarySession.personaKind).toBe("primary");

    const reloadedPrimary = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: firstTabVerifier,
      ownerCapability: owner.capability
    });
    const reloadedSession = await reloadedPrimary.events.waitFor("group_session");
    expect(reloadedSession.memberId).not.toBe(primarySession.memberId);
    expect(reloadedSession.persona).toEqual(primarySession.persona);
    expect(reloadedSession.personaKind).toBe("primary");
    expect(server.groupManager.stats().participants).toBe(1);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.totals.group_participants_joined).toBe(2);

    const secondary = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token()
    });
    const secondarySession = await secondary.events.waitFor("group_session");
    secondary.send({ type: "group_destroy", ownerCapability: browserVerifier });
    await secondary.events.waitFor("group_forbidden");
    expect(server.groupManager.stats().activeRooms).toBe(1);
    const third = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token()
    });
    const thirdSession = await third.events.waitFor("group_session");
    expect(secondarySession.personaKind).toBe("ephemeral");
    expect(thirdSession.personaKind).toBe("ephemeral");

    const fourth = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token()
    });
    expect((await fourth.events.waitFor("group_browser_limit")).maxSessions).toBe(3);
    expect(server.groupManager.stats().participants).toBe(3);
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.totals.group_participants_joined).toBe(4);

    const otherBrowser = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken
    });
    const otherSession = await otherBrowser.events.waitFor("group_session");
    const initialPersonas = [reloadedSession, secondarySession, thirdSession, otherSession].map((session) => session.persona);
    expect(new Set(initialPersonas.map((persona) => persona.nickname)).size).toBe(4);
    expect(new Set(initialPersonas.map((persona) => persona.color)).size).toBe(4);

    reloadedPrimary.close();
    await waitUntil(() => server.groupManager.currentCounts().connected === 3);
    const returnedPrimary = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token(),
      ownerCapability: owner.capability
    });
    const returnedSession = await returnedPrimary.events.waitFor("group_session");
    expect(returnedSession.memberId).not.toBe(reloadedSession.memberId);
    expect(returnedSession.personaKind).toBe("primary");
    expect(returnedSession.persona).toEqual(reloadedSession.persona);
    expect(returnedSession.resumeToken).not.toBe(reloadedSession.resumeToken);

    secondary.close();
    await waitUntil(() => server.groupManager.stats().participants === 3, 1_000);
    const replacementEphemeral = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token()
    });
    const replacementSession = await replacementEphemeral.events.waitFor("group_session");
    expect(replacementSession.personaKind).toBe("ephemeral");
    expect(replacementSession.persona.nickname).not.toBe(secondarySession.persona.nickname);

    expect(server.groupManager.stats()).toMatchObject({
      participants: 4,
      personaMappings: 2,
      usedPersonas: 5,
      storedMessages: 0
    });
    expect((await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot)
      .groups.totals.group_participants_joined).toBe(7);
    expect(JSON.stringify(server.groupManager.stats())).not.toContain(browserVerifier);
    returnedPrimary.send({ type: "group_destroy", ownerCapability: owner.capability });
    await returnedPrimary.events.waitFor("group_destroyed");
    expect(server.groupManager.stats()).toMatchObject({
      activeRooms: 0,
      participants: 0,
      personaMappings: 0,
      usedPersonas: 0,
      storedMessages: 0
    });
  });

  it("recovers fresh owner authority only for the creator primary browser profile", async () => {
    const { server, httpUrl, wsUrl } = await start({ groupRekeyTimeoutMs: 60_000, disconnectGraceMs: 80 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const creatorBrowserVerifier = token();

    const primary = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: creatorBrowserVerifier,
      tabVerifier: token(),
      ownerCapability: owner.capability,
      ownerRecoverySecret: owner.recoverySecret
    });
    const primarySession = await primary.events.waitFor("group_session");
    expect(primarySession.ownerAuthorized).toBe(true);
    expect(primarySession.ownerCapability).toBeUndefined();

    const secondTab = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: creatorBrowserVerifier,
      tabVerifier: token(),
      ownerRecoverySecret: owner.recoverySecret
    });
    const secondSession = await secondTab.events.waitFor("group_session");
    expect(secondSession.personaKind).toBe("ephemeral");
    expect(secondSession.ownerAuthorized).toBe(false);
    expect(secondSession.ownerCapability).toBeUndefined();

    const thirdTab = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: creatorBrowserVerifier,
      tabVerifier: token(),
      ownerRecoverySecret: owner.recoverySecret
    });
    const thirdSession = await thirdTab.events.waitFor("group_session");
    expect(thirdSession.personaKind).toBe("ephemeral");
    expect(thirdSession.ownerAuthorized).toBe(false);

    const otherProfile = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: token(),
      tabVerifier: token(),
      ownerRecoverySecret: owner.recoverySecret
    });
    const otherSession = await otherProfile.events.waitFor("group_session");
    expect(otherSession.personaKind).toBe("primary");
    expect(otherSession.ownerAuthorized).toBe(false);
    expect(otherSession.ownerCapability).toBeUndefined();

    primary.close();
    await waitUntil(() => server.groupManager.stats().participants === 3, 1_000);

    const browserTokenOnly = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: creatorBrowserVerifier,
      tabVerifier: token(),
      ownerRecoverySecret: creatorBrowserVerifier
    });
    const tokenOnlySession = await browserTokenOnly.events.waitFor("group_session");
    expect(tokenOnlySession.personaKind).toBe("primary");
    expect(tokenOnlySession.persona).toEqual(primarySession.persona);
    expect(tokenOnlySession.ownerAuthorized).toBe(false);
    expect(tokenOnlySession.ownerCapability).toBeUndefined();
    browserTokenOnly.close();
    await waitUntil(() => server.groupManager.stats().participants === 3, 1_000);

    const recovered = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: creatorBrowserVerifier,
      tabVerifier: token(),
      ownerRecoverySecret: owner.recoverySecret
    });
    const recoveredSession = await recovered.events.waitFor("group_session");
    expect(recoveredSession.personaKind).toBe("primary");
    expect(recoveredSession.persona).toEqual(primarySession.persona);
    expect(recoveredSession.ownerAuthorized).toBe(true);
    expect(recoveredSession.ownerCapability).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(recoveredSession.ownerCapability).not.toBe(owner.capability);

    recovered.send({ type: "group_destroy", ownerCapability: owner.capability });
    await recovered.events.waitFor("group_forbidden");
    expect(server.groupManager.stats().activeRooms).toBe(1);

    recovered.send({ type: "group_destroy", ownerCapability: recoveredSession.ownerCapability! });
    await recovered.events.waitFor("group_destroyed");
    expect(server.groupManager.stats().activeRooms).toBe(0);
    const staleRecovery = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier: creatorBrowserVerifier,
      tabVerifier: token(),
      ownerRecoverySecret: owner.recoverySecret
    });
    await staleRecovery.events.waitFor("group_room_gone");
  });

  it("uses an absolute creation TTL and cleans all room references", async () => {
    const { server, httpUrl, wsUrl } = await start({ groupHardTtlMs: 400 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const browserVerifier = token();
    const participant = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token()
    });
    await participant.events.waitFor("group_session");
    expect(server.groupManager.stats().activeRooms).toBe(1);
    expect(server.groupManager.stats()).toMatchObject({ personaMappings: 1, usedPersonas: 1 });
    await waitUntil(() => server.groupManager.stats().activeRooms === 0, 1_000);
    const gone = await fetch(`${httpUrl}/g/${created.inviteToken}`);
    expect(gone.status).toBe(410);
    const stats = await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot;
    expect(stats.groups.totals.group_destroyed_ttl).toBe(1);
    expect(stats.groups.totals.group_responses_410).toBe(1);
    expect(server.groupManager.stats()).toMatchObject({
      storedMessages: 0,
      personaMappings: 0,
      usedPersonas: 0
    });
    const stale = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      browserVerifier,
      tabVerifier: token(),
      ownerRecoverySecret: owner.recoverySecret
    });
    await stale.events.waitFor("group_room_gone");
  });

  it("does not activate a partial roster during a join racing disconnect grace", async () => {
    await groupSodiumReady();
    const { httpUrl, wsUrl } = await start({ disconnectGraceMs: 140 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const linkSecret = token();
    const a = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      ownerCapability: owner.capability
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 1);
    const b = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 2 && b.activeEpoch === 2);

    b.close();
    const c = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken
    }, linkSecret);
    await c.events.waitFor("group_session");
    await waitUntil(() => a.crypto?.state === "REKEYING");
    expect(() => a.sendMessage("blocked", "must not leave during partial roster")).toThrow(/active/i);
    await waitUntil(() => a.activeEpoch >= 4 && c.activeEpoch === a.activeEpoch, 2_000);
    expect(c.messages).toEqual([]);
    a.sendMessage("committed", "only after the removal epoch");
    await waitUntil(() => c.messages.length === 1);
    a.send({ type: "group_destroy", ownerCapability: owner.capability });
    await Promise.all([a.events.waitFor("group_destroyed"), c.events.waitFor("group_destroyed")]);
  });

  it("rejects self-asserted READY poisoning without selecting a digest or evicting honest members", async () => {
    const { httpUrl, wsUrl, server } = await start({ groupRekeyTimeoutMs: 80 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const a = await RawGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      ownerCapability: owner.capability
    });
    await a.events.waitFor("group_session");
    const b = await RawGroupClient.connect(wsUrl, { type: "group_join", inviteToken: created.inviteToken });
    const bSession = await b.events.waitFor("group_session");
    const aEpoch = await a.events.waitFor("group_epoch");
    a.send({
      type: "group_ready",
      epoch: aEpoch.epoch,
      rosterDigest: aEpoch.rosterDigest,
      epochDigest: token()
    });
    b.send({
      type: "group_ready",
      epoch: bSession.epoch,
      rosterDigest: bSession.rosterDigest,
      epochDigest: token()
    });
    expect((await a.events.waitFor("group_protocol_error")).code).toBe("invalid_control");
    expect((await b.events.waitFor("group_protocol_error")).code).toBe("invalid_control");
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(server.groupManager.currentCounts().rekeying).toBe(1);
    expect(server.groupManager.stats().participants).toBe(2);
    a.close();
    b.close();
  });

  it("requires unanimous canonical READY state and tolerates a poisoned value before correction", async () => {
    await groupSodiumReady();
    const { httpUrl, wsUrl } = await start();
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const linkSecret = token();
    const a = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      ownerCapability: owner.capability
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 1);
    const b = await SecureGroupClient.connect(
      wsUrl,
      { type: "group_join", inviteToken: created.inviteToken },
      linkSecret,
      { poisonReadyOnce: true, poisonCorrectionDelayMs: 100 }
    );
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(a.activeEpoch).toBe(1);
    expect(b.activeEpoch).toBe(0);
    await waitUntil(() => a.activeEpoch === 2 && b.activeEpoch === 2);
    a.send({ type: "group_destroy", ownerCapability: owner.capability });
  });

  it("completes a rapid full rekey with ten crypto participants under production budgets", async () => {
    await groupSodiumReady();
    const { httpUrl, wsUrl } = await start({ groupRekeyTimeoutMs: 5_000 });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const linkSecret = token();
    const clients: SecureGroupClient[] = [];
    for (let index = 0; index < 10; index += 1) {
      clients.push(await SecureGroupClient.connect(wsUrl, {
        type: "group_join",
        inviteToken: created.inviteToken,
        ...(index === 0 ? { ownerCapability: owner.capability } : {})
      }, linkSecret));
    }
    await waitUntil(() => clients.every((client) => client.activeEpoch === 10), 10_000);
    clients[0]!.sendMessage("ten-members", "one logical group message");
    await waitUntil(() => clients.slice(1).every((client) => client.messages.length === 1), 5_000);
    expect(clients.slice(1).every((client) => client.messages[0]?.id === "ten-members")).toBe(true);
    clients[0]!.send({ type: "group_destroy", ownerCapability: owner.capability });
  });

  it("rejects an application relay transaction without creating a sequence gap", async () => {
    await groupSodiumReady();
    const { httpUrl, wsUrl } = await start({
      maxRelaysPerWindow: 1,
      maxGroupRelaysPerWindow: 1,
      groupRelayWindowMs: 80
    });
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const linkSecret = token();
    const a = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      ownerCapability: owner.capability
    }, linkSecret);
    const b = await SecureGroupClient.connect(wsUrl, { type: "group_join", inviteToken: created.inviteToken }, linkSecret);
    await waitUntil(() => a.activeEpoch === 2 && b.activeEpoch === 2);

    a.sendMessage("accepted-1", "first");
    await waitUntil(() => b.messages.length === 1 && !a.relayPending);
    a.sendMessage("rejected", "rate limited");
    expect((await a.events.waitFor("group_relay_rejected")).reason).toBe("rate_limited");
    await waitUntil(() => !a.relayPending);
    expect(b.messages.map((message) => message.id)).toEqual(["accepted-1"]);
    const c = await SecureGroupClient.connect(wsUrl, { type: "group_join", inviteToken: created.inviteToken }, linkSecret);
    await waitUntil(() => a.activeEpoch === 3 && b.activeEpoch === 3 && c.activeEpoch === 3);
    expect(c.messages).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 100));

    a.sendMessage("accepted-2", "sequence remains contiguous");
    await waitUntil(() => b.messages.length === 2 && c.messages.length === 1 && !a.relayPending);
    expect(b.messages.map((message) => message.id)).toEqual(["accepted-1", "accepted-2"]);
    expect(c.messages.map((message) => message.id)).toEqual(["accepted-2"]);
    expect(a.activeEpoch).toBe(3);
    expect(b.activeEpoch).toBe(3);
    a.send({ type: "group_destroy", ownerCapability: owner.capability });
  });

  it("deduplicates control storms and confines malformed control errors to the sender", async () => {
    await groupSodiumReady();
    const { httpUrl, wsUrl } = await start();
    const owner = ownerCredentials();
    const created = await createGroup(httpUrl, owner.verifier, owner.recoveryVerifier);
    const linkSecret = token();
    const a = await SecureGroupClient.connect(wsUrl, {
      type: "group_join",
      inviteToken: created.inviteToken,
      ownerCapability: owner.capability
    }, linkSecret);
    await waitUntil(() => a.activeEpoch === 1);
    const b = await SecureGroupClient.connect(
      wsUrl,
      { type: "group_join", inviteToken: created.inviteToken },
      linkSecret,
      { duplicateAnnouncements: 20 }
    );
    await waitUntil(() => a.activeEpoch === 2 && b.activeEpoch === 2);
    const epoch = b.session!;
    for (let index = 0; index < 20; index += 1) {
      b.send({
        type: "group_control",
        epoch: 2,
        rosterDigest: epoch.rosterDigest,
        data: Buffer.from(JSON.stringify({ v: 1, kind: "key_announcement", publicKey: token(), authTag: token(), extra: index })).toString("base64url")
      });
    }
    await b.events.waitFor("group_protocol_error");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(a.socket.readyState).toBe(WebSocket.OPEN);
    expect(a.activeEpoch).toBe(2);
    expect(b.activeEpoch).toBe(2);
    a.send({ type: "group_destroy", ownerCapability: owner.capability });
  });

  it("keeps the group feature unreachable when the flag is disabled", async () => {
    const { httpUrl } = await start({ groupRoomsEnabled: false });
    const owner = ownerCredentials();
    const response = await fetch(`${httpUrl}/api/group-rooms`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: httpUrl },
      body: JSON.stringify({ ownerVerifier: owner.verifier })
    });
    expect(response.status).toBe(404);
    const stats = await (await fetch(`${httpUrl}/__stats`)).json() as MetricsSnapshot;
    expect(stats.groups.now).toEqual({ rooms: 0, participants: 0 });
    expect(stats.groups.totals).toEqual(
      Object.fromEntries(GROUP_METRIC_NAMES.map((name) => [name, 0]))
    );
    const adminStats = await (await fetch(`${httpUrl}/admin/api/stats`)).json() as {
      group: { now: { rooms: number; people: number }; today: Record<string, number>; totals: Record<string, number> };
    };
    expect(adminStats.group.now).toEqual({ rooms: 0, people: 0 });
    expect(Object.values(adminStats.group.today)).toEqual([0, 0, 0, 0]);
    expect(Object.values(adminStats.group.totals)).toEqual([0, 0, 0, 0]);
    expect((await fetch(`${httpUrl}/g/${token()}`)).status).toBe(410);
    expect(await (await fetch(`${httpUrl}/api/features`)).json()).toEqual({ groupRooms: false });
  });
});

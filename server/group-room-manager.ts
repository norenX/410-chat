import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import {
  encodeCanonicalGroupRoster,
  GROUP_GONE_MESSAGE,
  type GroupClientCommand,
  type GroupEpochDescriptor,
  type GroupMemberPersona,
  type GroupPersona,
  type GroupRoomPhase,
  type GroupRoomState,
  type GroupServerEvent
} from "../shared/group-protocol.js";
import type { TrafficSource } from "./attribution.js";
import { allocateGroupPersona } from "./group-persona.js";

export const GROUP_HARD_TTL_MS = 24 * 60 * 60 * 1000;
export const GROUP_MAX_PARTICIPANTS = 10;
export const GROUP_MAX_BROWSER_SESSIONS = 3;

export interface GroupRoomManagerConfig {
  hardTtlMs: number;
  rekeyTimeoutMs: number;
  disconnectGraceMs: number;
  heartbeatEveryMs: number;
  heartbeatStaleMs: number;
  authTimeoutMs: number;
  maxWsMessageBytes: number;
  maxRelayChars: number;
  maxRelaysPerWindow: number;
  maxRoomRelaysPerWindow: number;
  relayWindowMs: number;
  maxInboundFramesPerWindow: number;
  maxInboundBytesPerWindow: number;
  inboundWindowMs: number;
  maxBufferedAmount: number;
  maxParticipants: number;
  maxRooms: number;
  maxEmptyRooms: number;
}

export const DEFAULT_GROUP_ROOM_MANAGER_CONFIG: Readonly<GroupRoomManagerConfig> = Object.freeze({
  hardTtlMs: GROUP_HARD_TTL_MS,
  rekeyTimeoutMs: 15_000,
  disconnectGraceMs: 15_000,
  heartbeatEveryMs: 5_000,
  heartbeatStaleMs: 12_000,
  authTimeoutMs: 5_000,
  maxWsMessageBytes: 32 * 1024,
  maxRelayChars: 24 * 1024,
  maxRelaysPerWindow: 30,
  maxRoomRelaysPerWindow: 120,
  relayWindowMs: 10_000,
  maxInboundFramesPerWindow: 160,
  maxInboundBytesPerWindow: 512 * 1024,
  inboundWindowMs: 10_000,
  maxBufferedAmount: 512 * 1024,
  maxParticipants: GROUP_MAX_PARTICIPANTS,
  maxRooms: 1_000,
  maxEmptyRooms: 250
});

export type GroupDestructionReason = "manual" | "ttl" | "shutdown";

export interface GroupRoomManagerHooks {
  onRoomCreated?: (source: TrafficSource) => void;
  onParticipantJoined?: (source: TrafficSource) => void;
  onConversationStarted?: (source: TrafficSource) => void;
  onMessageRelayed?: (source: TrafficSource) => void;
  onDestroyed?: (reason: GroupDestructionReason) => void;
  onEpochChanged?: (roomId: string, epoch: number, rosterDigest: string) => void;
}

export interface CreateGroupRoomResult {
  roomId: string;
  inviteToken: string;
  expiresAt: number;
}

interface GroupMember {
  id: string;
  browserHash: Buffer;
  tabHash: Buffer;
  persona: GroupPersona;
  personaKind: "primary" | "ephemeral";
  resumeHash: Buffer;
  ownerAuthorized: boolean;
  socket?: WebSocket;
  connected: boolean;
  lastSeenAt: number;
  connectionGeneration: number;
  disconnectTimer?: NodeJS.Timeout;
  relayTimes: number[];
  inboundFrames: Array<{ at: number; bytes: number }>;
}

interface PrimaryPersona {
  browserHash: Buffer;
  persona: GroupPersona;
  primaryMemberId?: string;
}

interface StoredAnnouncement {
  publicKey: string;
  authTag: string;
  encoded: string;
}

interface StoredConfirmation {
  epochDigest: string;
  encoded: string;
}

interface GroupRoom {
  id: string;
  source: TrafficSource;
  state: GroupRoomState;
  phase: GroupRoomPhase;
  inviteHash: Buffer;
  ownerVerifier: Buffer;
  ownerRecoveryVerifier: Buffer;
  ownerBrowserHash?: Buffer;
  createdAt: number;
  expiresAt: number;
  hardTtlTimer: NodeJS.Timeout;
  rekeyTimer?: NodeJS.Timeout;
  members: Map<string, GroupMember>;
  epoch: number;
  epochNonce: string;
  rosterDigest: string;
  epochMembers: string[];
  readyDigests: Map<string, string>;
  announcements: Map<string, StoredAnnouncement>;
  confirmations: Map<string, StoredConfirmation>;
  readyEpochDigest?: string;
  conversationStarted: boolean;
  relayTimes: number[];
  primaryPersonas: Map<string, PrimaryPersona>;
  usedNicknames: Set<string>;
}

interface GroupConnectionContext {
  roomId: string;
  memberId: string;
  generation: number;
}

interface ResumeIndexValue {
  roomId: string;
  memberId: string;
}

const ROOM_ID_PATTERN = /^[A-Za-z0-9_-]{32}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const SECRET_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const RELAY_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;
const RELAY_PATTERN = /^[A-Za-z0-9_-]+$/;

function exactKeys(record: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(record);
  return required.every((key) => Object.hasOwn(record, key)) && keys.every((key) => allowed.has(key));
}

function randomToken(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function sha256(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

function hashCapability(capability: string): Buffer | null {
  if (!SECRET_PATTERN.test(capability)) return null;
  const decoded = Buffer.from(capability, "base64url");
  if (decoded.length !== 32) return null;
  return sha256(decoded);
}

function decodeVerifier(value: string): Buffer | null {
  if (!SECRET_PATTERN.test(value)) return null;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === 32 ? Buffer.from(decoded) : null;
}

function hashesEqual(left: Buffer, right: Buffer | null): boolean {
  return Boolean(right && left.length === right.length && timingSafeEqual(left, right));
}

function parseGroupCommand(raw: string): GroupClientCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const ownerCapability = typeof record.ownerCapability === "string" ? record.ownerCapability : undefined;
  const ownerRecoverySecret = typeof record.ownerRecoverySecret === "string" ? record.ownerRecoverySecret : undefined;
  if (
    record.type === "group_join" && typeof record.inviteToken === "string" &&
    typeof record.browserVerifier === "string" && typeof record.tabVerifier === "string" &&
    exactKeys(record, ["type", "inviteToken", "browserVerifier", "tabVerifier"], ["ownerCapability", "ownerRecoverySecret"]) &&
    (record.ownerCapability === undefined || typeof record.ownerCapability === "string") &&
    (record.ownerRecoverySecret === undefined || typeof record.ownerRecoverySecret === "string")
  ) {
    return {
      type: "group_join",
      inviteToken: record.inviteToken,
      browserVerifier: record.browserVerifier,
      tabVerifier: record.tabVerifier,
      ...(ownerCapability ? { ownerCapability } : {}),
      ...(ownerRecoverySecret ? { ownerRecoverySecret } : {})
    };
  }
  if (
    record.type === "group_resume" &&
    typeof record.roomId === "string" &&
    typeof record.memberId === "string" &&
    typeof record.resumeToken === "string" &&
    exactKeys(record, ["type", "roomId", "memberId", "resumeToken"], ["ownerCapability"]) &&
    (record.ownerCapability === undefined || typeof record.ownerCapability === "string")
  ) {
    return {
      type: "group_resume",
      roomId: record.roomId,
      memberId: record.memberId,
      resumeToken: record.resumeToken,
      ...(ownerCapability ? { ownerCapability } : {})
    };
  }
  if (record.type === "heartbeat" && exactKeys(record, ["type"])) return { type: "heartbeat" };
  if (
    record.type === "group_control" &&
    Number.isSafeInteger(record.epoch) &&
    typeof record.rosterDigest === "string" &&
    typeof record.data === "string" &&
    (record.to === undefined || typeof record.to === "string") &&
    exactKeys(record, ["type", "epoch", "rosterDigest", "data"], ["to"])
  ) {
    return {
      type: "group_control",
      epoch: record.epoch as number,
      rosterDigest: record.rosterDigest,
      data: record.data,
      ...(typeof record.to === "string" ? { to: record.to } : {})
    };
  }
  if (
    record.type === "group_ready" &&
    Number.isSafeInteger(record.epoch) &&
    typeof record.rosterDigest === "string" &&
    typeof record.epochDigest === "string" &&
    exactKeys(record, ["type", "epoch", "rosterDigest", "epochDigest"])
  ) {
    return {
      type: "group_ready",
      epoch: record.epoch as number,
      rosterDigest: record.rosterDigest,
      epochDigest: record.epochDigest
    };
  }
  if (
    record.type === "group_relay" &&
    typeof record.relayId === "string" &&
    Number.isSafeInteger(record.epoch) &&
    typeof record.epochDigest === "string" &&
    typeof record.data === "string" &&
    exactKeys(record, ["type", "relayId", "epoch", "epochDigest", "data"])
  ) {
    return {
      type: "group_relay",
      relayId: record.relayId,
      epoch: record.epoch as number,
      epochDigest: record.epochDigest,
      data: record.data
    };
  }
  if (record.type === "group_destroy" && ownerCapability && exactKeys(record, ["type", "ownerCapability"])) {
    return { type: "group_destroy", ownerCapability };
  }
  if (
    record.type === "group_owner_destroy" && typeof record.roomId === "string" && ownerCapability &&
    exactKeys(record, ["type", "roomId", "ownerCapability"])
  ) {
    return { type: "group_owner_destroy", roomId: record.roomId, ownerCapability };
  }
  return null;
}

function decodeProtocolPacket(data: string): Record<string, unknown> | null {
  try {
    if (!RELAY_PATTERN.test(data)) return null;
    const decoded = Buffer.from(data, "base64url");
    if (decoded.toString("base64url") !== data) return null;
    const value = JSON.parse(decoded.toString("utf8")) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function encodedBytes(value: unknown, expectedLength?: number): value is string {
  if (typeof value !== "string" || !RELAY_PATTERN.test(value)) return false;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value && (expectedLength === undefined || decoded.length === expectedLength);
  } catch {
    return false;
  }
}

type ValidControlPacket =
  | { kind: "key_announcement"; publicKey: string; authTag: string }
  | { kind: "key_confirmation"; epochDigest: string; tag: string };

function validControlPacket(data: string, targetId?: string): ValidControlPacket | null {
  const packet = decodeProtocolPacket(data);
  if (!packet || packet.v !== 1) return null;
  if (packet.kind === "key_announcement") {
    if (
      targetId !== undefined || !exactKeys(packet, ["v", "kind", "publicKey", "authTag"]) ||
      !encodedBytes(packet.publicKey, 32) || !encodedBytes(packet.authTag, 32)
    ) return null;
    return { kind: "key_announcement", publicKey: packet.publicKey, authTag: packet.authTag };
  }
  if (packet.kind === "key_confirmation") {
    if (
      !targetId || !exactKeys(packet, ["v", "kind", "epochDigest", "tag"]) ||
      !encodedBytes(packet.epochDigest, 32) || !encodedBytes(packet.tag, 32)
    ) return null;
    return { kind: "key_confirmation", epochDigest: packet.epochDigest, tag: packet.tag };
  }
  return null;
}

function validApplicationPacket(data: string, senderId: string, members: readonly string[]): boolean {
  const packet = decodeProtocolPacket(data);
  if (
    !packet || packet.v !== 1 || packet.kind !== "group_ciphertext" ||
    !exactKeys(packet, ["v", "kind", "contentId", "contentNonce", "contentCiphertext", "contentDigest", "wraps"])
  ) return false;
  if (
    !encodedBytes(packet.contentId, 16) ||
    !encodedBytes(packet.contentNonce, 24) ||
    !encodedBytes(packet.contentDigest, 32) ||
    !encodedBytes(packet.contentCiphertext) ||
    Buffer.from(packet.contentCiphertext, "base64url").length < 16 ||
    !Array.isArray(packet.wraps)
  ) return false;
  const expectedRecipients = members.filter((memberId) => memberId !== senderId);
  if (packet.wraps.length !== expectedRecipients.length) return false;
  return packet.wraps.every((rawWrap, index) => {
    if (!rawWrap || typeof rawWrap !== "object" || Array.isArray(rawWrap)) return false;
    const wrap = rawWrap as Record<string, unknown>;
    return exactKeys(wrap, ["recipientMemberId", "sequence", "nonce", "ciphertext"]) &&
      wrap.recipientMemberId === expectedRecipients[index] &&
      Number.isSafeInteger(wrap.sequence) && (wrap.sequence as number) > 0 &&
      encodedBytes(wrap.nonce, 24) && encodedBytes(wrap.ciphertext, 48);
  });
}

export class GroupRoomManager {
  private readonly rooms = new Map<string, GroupRoom>();
  private readonly inviteIndex = new Map<string, string>();
  private readonly resumeIndex = new Map<string, ResumeIndexValue>();
  private readonly contexts = new Map<WebSocket, GroupConnectionContext>();
  private readonly sweepTimer: NodeJS.Timeout;
  private readonly config: GroupRoomManagerConfig;

  constructor(
    config: Partial<GroupRoomManagerConfig> = {},
    private readonly hooks: GroupRoomManagerHooks = {}
  ) {
    this.config = { ...DEFAULT_GROUP_ROOM_MANAGER_CONFIG, ...config };
    for (const [name, value] of Object.entries(this.config)) {
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid group config: ${name}`);
    }
    if (this.config.maxParticipants > GROUP_MAX_PARTICIPANTS) {
      throw new Error(`Group rooms cannot exceed ${GROUP_MAX_PARTICIPANTS} participants`);
    }
    if (this.config.maxEmptyRooms > this.config.maxRooms) {
      throw new Error("Empty group-room cap cannot exceed the total room cap");
    }
    const interval = Math.max(100, Math.min(1000, Math.floor(this.config.heartbeatEveryMs / 2)));
    this.sweepTimer = setInterval(() => this.sweepHeartbeats(), interval);
    this.sweepTimer.unref();
  }

  createRoom(
    ownerVerifier: string,
    ownerRecoveryVerifier: string,
    now = Date.now(),
    source: TrafficSource = "direct"
  ): CreateGroupRoomResult | null {
    const verifier = decodeVerifier(ownerVerifier);
    const recoveryVerifier = decodeVerifier(ownerRecoveryVerifier);
    if (!verifier || !recoveryVerifier) {
      verifier?.fill(0);
      recoveryVerifier?.fill(0);
      throw new Error("Invalid owner verifier");
    }
    const emptyRooms = [...this.rooms.values()].filter((room) => room.members.size === 0).length;
    if (this.rooms.size >= this.config.maxRooms || emptyRooms >= this.config.maxEmptyRooms) {
      verifier.fill(0);
      recoveryVerifier.fill(0);
      return null;
    }
    let roomId = randomToken(24);
    while (this.rooms.has(roomId)) roomId = randomToken(24);
    let inviteToken = randomToken(32);
    let inviteHash = sha256(inviteToken);
    while (this.inviteIndex.has(inviteHash.toString("hex"))) {
      inviteToken = randomToken(32);
      inviteHash = sha256(inviteToken);
    }
    const expiresAt = now + this.config.hardTtlMs;
    const delay = Math.max(0, expiresAt - Date.now());
    const hardTtlTimer = setTimeout(() => this.destroyRoom(roomId, "ttl"), delay);
    hardTtlTimer.unref();
    const room: GroupRoom = {
      id: roomId,
      source,
      state: "OPEN",
      phase: "ACTIVE",
      inviteHash,
      ownerVerifier: verifier,
      ownerRecoveryVerifier: recoveryVerifier,
      createdAt: now,
      expiresAt,
      hardTtlTimer,
      members: new Map(),
      epoch: 0,
      epochNonce: "",
      rosterDigest: "",
      epochMembers: [],
      readyDigests: new Map(),
      announcements: new Map(),
      confirmations: new Map(),
      conversationStarted: false,
      relayTimes: [],
      primaryPersonas: new Map(),
      usedNicknames: new Set()
    };
    this.rooms.set(roomId, room);
    this.inviteIndex.set(inviteHash.toString("hex"), roomId);
    this.hooks.onRoomCreated?.(source);
    return { roomId, inviteToken, expiresAt };
  }

  hasActiveInvite(inviteToken: string, now = Date.now()): boolean {
    const room = this.roomForInvite(inviteToken, now);
    return Boolean(room);
  }

  acceptSocket(socket: WebSocket): void {
    const authTimer = setTimeout(() => {
      this.gone(socket);
      socket.close(4408, "authentication timeout");
    }, this.config.authTimeoutMs);
    authTimer.unref();

    const authenticate = (data: Buffer, isBinary: boolean) => {
      clearTimeout(authTimer);
      if (isBinary || data.byteLength > this.config.maxWsMessageBytes) {
        socket.close(4400, "invalid message");
        return;
      }
      const command = parseGroupCommand(data.toString("utf8"));
      if (!command) {
        this.gone(socket);
        return;
      }
      if (command.type === "group_owner_destroy") {
        if (this.destroyWithOwnerCapability(command.roomId, command.ownerCapability)) {
          this.send(socket, { type: "group_destroyed" });
          socket.close(4000, "room destroyed");
        } else {
          this.gone(socket);
        }
        return;
      }
      const attached = command.type === "group_join"
        ? this.join(
            socket,
            command.inviteToken,
            command.browserVerifier,
            command.tabVerifier,
            command.ownerCapability,
            command.ownerRecoverySecret
          )
        : command.type === "group_resume"
          ? this.resume(socket, command.roomId, command.memberId, command.resumeToken, command.ownerCapability)
          : false;
      if (!attached) {
        if (command.type !== "group_join" && command.type !== "group_resume") this.gone(socket);
        return;
      }
      socket.on("message", (nextData, nextIsBinary) => {
        const buffer = Buffer.isBuffer(nextData) ? nextData : Buffer.from(nextData as ArrayBuffer);
        this.handleAuthenticatedMessage(socket, buffer, nextIsBinary);
      });
      socket.on("close", () => this.onSocketClosed(socket));
      socket.on("error", () => undefined);
    };
    socket.once("message", authenticate);
    socket.once("close", () => clearTimeout(authTimer));
  }

  private join(
    socket: WebSocket,
    inviteToken: string,
    browserVerifier: string,
    tabVerifier: string,
    ownerCapability?: string,
    ownerRecoverySecret?: string
  ): boolean {
    const room = this.roomForInvite(inviteToken);
    if (!room) return this.gone(socket);
    const decodedBrowserVerifier = decodeVerifier(browserVerifier);
    const decodedTabVerifier = decodeVerifier(tabVerifier);
    if (!decodedBrowserVerifier || !decodedTabVerifier) {
      decodedBrowserVerifier?.fill(0);
      decodedTabVerifier?.fill(0);
      return this.gone(socket);
    }
    const browserHash = sha256(decodedBrowserVerifier);
    const tabHash = sha256(decodedTabVerifier);
    decodedBrowserVerifier.fill(0);
    decodedTabVerifier.fill(0);
    const browserKey = browserHash.toString("hex");
    const primary = room.primaryPersonas.get(browserKey);

    const sameTab = [...room.members.values()].find((candidate) =>
      timingSafeEqual(candidate.browserHash, browserHash) && timingSafeEqual(candidate.tabHash, tabHash)
    );
    if (sameTab) this.replaceMember(room, sameTab);

    const primaryMember = primary?.primaryMemberId
      ? room.members.get(primary.primaryMemberId)
      : undefined;
    if (primaryMember && !primaryMember.connected) this.replaceMember(room, primaryMember);

    const browserSessionCount = [...room.members.values()].filter((candidate) =>
      timingSafeEqual(candidate.browserHash, browserHash)
    ).length;
    if (browserSessionCount >= GROUP_MAX_BROWSER_SESSIONS) {
      browserHash.fill(0);
      tabHash.fill(0);
      this.send(socket, { type: "group_browser_limit", maxSessions: GROUP_MAX_BROWSER_SESSIONS });
      socket.close(4410, "browser session limit");
      return false;
    }
    if (room.members.size >= this.config.maxParticipants) {
      browserHash.fill(0);
      tabHash.fill(0);
      this.send(socket, { type: "group_room_full", maxParticipants: this.config.maxParticipants });
      socket.close(4409, "room full");
      return false;
    }
    let primaryPersona = primary;
    if (!primaryPersona) {
      const unavailableColors = new Set([
        ...[...room.primaryPersonas.values()].map((entry) => entry.persona.color),
        ...[...room.members.values()].map((entry) => entry.persona.color)
      ]);
      primaryPersona = {
        browserHash: Buffer.from(browserHash),
        persona: allocateGroupPersona(
          room.usedNicknames,
          unavailableColors,
          [...room.members.values()].map((entry) => entry.persona.color)
        )
      };
      room.primaryPersonas.set(browserKey, primaryPersona);
    }
    const personaKind = primaryPersona.primaryMemberId ? "ephemeral" : "primary";
    const persona = personaKind === "primary"
      ? primaryPersona.persona
      : allocateGroupPersona(
          room.usedNicknames,
          new Set([
            ...[...room.primaryPersonas.values()].map((entry) => entry.persona.color),
            ...[...room.members.values()].map((entry) => entry.persona.color)
          ]),
          [...room.members.values()].map((entry) => entry.persona.color)
        );
    const suppliedOwnerCapability = this.ownerMatches(room, ownerCapability);
    if (
      suppliedOwnerCapability && personaKind === "primary" && !room.ownerBrowserHash &&
      this.ownerRecoveryMatches(room, ownerRecoverySecret)
    ) {
      room.ownerBrowserHash = Buffer.from(browserHash);
    }
    const recoveredOwnerCapability = !suppliedOwnerCapability && personaKind === "primary"
      ? this.recoverOwnerCapability(room, browserHash, ownerRecoverySecret)
      : undefined;
    const memberId = this.uniqueMemberId(room);
    const resumeToken = randomToken(32);
    const resumeHash = sha256(resumeToken);
    const member: GroupMember = {
      id: memberId,
      browserHash,
      tabHash,
      persona,
      personaKind,
      resumeHash,
      ownerAuthorized: suppliedOwnerCapability || Boolean(recoveredOwnerCapability),
      socket,
      connected: true,
      lastSeenAt: Date.now(),
      connectionGeneration: 1,
      relayTimes: [],
      inboundFrames: []
    };
    room.members.set(member.id, member);
    if (personaKind === "primary") primaryPersona.primaryMemberId = member.id;
    this.resumeIndex.set(resumeHash.toString("hex"), { roomId: room.id, memberId: member.id });
    this.contexts.set(socket, { roomId: room.id, memberId: member.id, generation: member.connectionGeneration });
    this.rotateEpoch(room);
    this.sendSession(room, member, resumeToken, recoveredOwnerCapability);
    this.broadcastEpoch(room, socket);
    this.broadcastPresence(room);
    this.hooks.onParticipantJoined?.(room.source);
    return true;
  }

  private resume(
    socket: WebSocket,
    roomId: string,
    memberId: string,
    resumeToken: string,
    ownerCapability?: string
  ): boolean {
    if (!ROOM_ID_PATTERN.test(roomId) || !MEMBER_ID_PATTERN.test(memberId) || !SECRET_PATTERN.test(resumeToken)) {
      return this.gone(socket);
    }
    const room = this.liveRoom(roomId);
    const member = room?.members.get(memberId);
    const suppliedHash = sha256(resumeToken);
    const indexed = this.resumeIndex.get(suppliedHash.toString("hex"));
    if (
      !room || !member ||
      !indexed || indexed.roomId !== room.id || indexed.memberId !== member.id ||
      !timingSafeEqual(member.resumeHash, suppliedHash)
    ) return this.gone(socket);

    const replacedSocket = member.socket;
    if (replacedSocket) {
      this.contexts.delete(replacedSocket);
      replacedSocket.close(4001, "connection replaced");
    }
    if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
    member.disconnectTimer = undefined;
    this.resumeIndex.delete(member.resumeHash.toString("hex"));
    member.resumeHash.fill(0);
    const nextResumeToken = randomToken(32);
    member.resumeHash = sha256(nextResumeToken);
    this.resumeIndex.set(member.resumeHash.toString("hex"), { roomId: room.id, memberId: member.id });
    member.ownerAuthorized ||= this.ownerMatches(room, ownerCapability);
    member.connected = true;
    member.socket = socket;
    member.lastSeenAt = Date.now();
    member.connectionGeneration += 1;
    member.relayTimes.length = 0;
    member.inboundFrames.length = 0;
    this.contexts.set(socket, { roomId: room.id, memberId: member.id, generation: member.connectionGeneration });
    this.rotateEpoch(room);
    this.sendSession(room, member, nextResumeToken);
    this.broadcastEpoch(room, socket);
    return true;
  }

  private handleAuthenticatedMessage(socket: WebSocket, data: Buffer, isBinary: boolean): void {
    const attached = this.attached(socket);
    if (!attached) {
      this.gone(socket);
      return;
    }
    const { room, member } = attached;
    if (!this.takeInboundBudget(member, data.byteLength)) {
      socket.close(4408, "rate limit");
      return;
    }
    if (isBinary || data.byteLength > this.config.maxWsMessageBytes) {
      socket.close(4400, "invalid message");
      return;
    }
    const command = parseGroupCommand(data.toString("utf8"));
    if (!command || command.type === "group_join" || command.type === "group_resume" || command.type === "group_owner_destroy") {
      socket.close(4400, "invalid message");
      return;
    }
    member.lastSeenAt = Date.now();
    if (command.type === "heartbeat") return;
    if (command.type === "group_destroy") {
      if (!this.ownerMatches(room, command.ownerCapability)) {
        this.send(socket, { type: "group_forbidden" });
        return;
      }
      this.destroyRoom(room.id, "manual");
      return;
    }
    if (command.type === "group_ready") {
      this.handleReady(room, member, socket, command.epoch, command.rosterDigest, command.epochDigest);
      return;
    }
    if (command.type === "group_control") {
      this.handleControl(room, member, socket, command);
      return;
    }
    this.handleApplicationRelay(room, member, socket, command);
  }

  private handleReady(
    room: GroupRoom,
    member: GroupMember,
    socket: WebSocket,
    epoch: number,
    rosterDigest: string,
    epochDigest: string
  ): void {
    if (
      room.phase !== "REKEYING" || epoch !== room.epoch || rosterDigest !== room.rosterDigest ||
      !SECRET_PATTERN.test(epochDigest) || !room.epochMembers.includes(member.id)
    ) {
      this.send(socket, { type: "group_protocol_error", code: "stale_epoch" });
      return;
    }
    if (room.announcements.size !== room.epochMembers.length) {
      this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
      return;
    }
    const sentEveryConfirmation = room.epochMembers.every((peerId) =>
      peerId === member.id || room.confirmations.get(`${member.id}:${peerId}`)?.epochDigest === epochDigest
    );
    if (!sentEveryConfirmation) {
      this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
      return;
    }
    room.readyDigests.set(member.id, epochDigest);
    const complete = room.epochMembers.every((id) => room.readyDigests.has(id));
    if (!complete) return;
    const agreedDigests = new Set(room.readyDigests.values());
    if (agreedDigests.size !== 1) return;
    const agreedDigest = room.readyDigests.values().next().value as string;
    room.phase = "ACTIVE";
    room.readyEpochDigest = agreedDigest;
    if (room.rekeyTimer) clearTimeout(room.rekeyTimer);
    room.rekeyTimer = undefined;
    const readyEvent: GroupServerEvent = {
      type: "group_epoch_ready",
      epoch: room.epoch,
      rosterDigest: room.rosterDigest,
      epochDigest: agreedDigest
    };
    this.broadcast(room, readyEvent);
    if (!room.conversationStarted && room.epochMembers.length >= 2) {
      room.conversationStarted = true;
      this.hooks.onConversationStarted?.(room.source);
    }
  }

  private handleControl(
    room: GroupRoom,
    member: GroupMember,
    socket: WebSocket,
    command: Extract<GroupClientCommand, { type: "group_control" }>
  ): void {
    if (command.epoch !== room.epoch || command.rosterDigest !== room.rosterDigest) {
      this.send(socket, { type: "group_protocol_error", code: "stale_epoch" });
      return;
    }
    const packet = command.data.length <= this.config.maxRelayChars
      ? validControlPacket(command.data, command.to)
      : null;
    if (room.phase !== "REKEYING" || !packet) {
      this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
      return;
    }
    if (packet.kind === "key_announcement") {
      const existing = room.announcements.get(member.id);
      if (existing) {
        if (existing.encoded === command.data) return;
        this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
        return;
      }
      room.announcements.set(member.id, { ...packet, encoded: command.data });
    } else {
      if (
        !command.to || room.announcements.size !== room.epochMembers.length ||
        !room.epochMembers.includes(command.to) || command.to === member.id
      ) {
        this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
        return;
      }
      const confirmationId = `${member.id}:${command.to}`;
      const existing = room.confirmations.get(confirmationId);
      if (existing) {
        if (existing.encoded === command.data) return;
        this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
        return;
      }
      room.confirmations.set(confirmationId, { epochDigest: packet.epochDigest, encoded: command.data });
    }
    const event: GroupServerEvent = {
      type: "group_control",
      epoch: room.epoch,
      rosterDigest: room.rosterDigest,
      from: member.id,
      data: command.data
    };
    if (command.to) {
      const target = room.members.get(command.to);
      if (target?.connected && target.socket) this.send(target.socket, event);
      return;
    }
    this.broadcast(room, event, socket);
  }

  private handleApplicationRelay(
    room: GroupRoom,
    member: GroupMember,
    socket: WebSocket,
    command: Extract<GroupClientCommand, { type: "group_relay" }>
  ): void {
    if (!encodedBytes(command.relayId, 16) || !RELAY_ID_PATTERN.test(command.relayId)) {
      this.send(socket, { type: "group_protocol_error", code: "invalid_control" });
      return;
    }
    if (command.epoch !== room.epoch || command.epochDigest !== room.readyEpochDigest) {
      this.send(socket, { type: "group_relay_rejected", relayId: command.relayId, reason: "unavailable" });
      return;
    }
    if (room.phase !== "ACTIVE") {
      this.send(socket, { type: "group_relay_rejected", relayId: command.relayId, reason: "unavailable" });
      return;
    }
    if (
      !RELAY_PATTERN.test(command.data) || command.data.length > this.config.maxRelayChars ||
      !validApplicationPacket(command.data, member.id, room.epochMembers)
    ) {
      this.send(socket, { type: "group_relay_rejected", relayId: command.relayId, reason: "invalid" });
      return;
    }
    if (!this.takeRelayBudget(room, member)) {
      this.send(socket, { type: "group_relay_rejected", relayId: command.relayId, reason: "rate_limited" });
      return;
    }
    const event: GroupServerEvent = {
      type: "group_relay",
      epoch: room.epoch,
      epochDigest: command.epochDigest,
      from: member.id,
      data: command.data
    };
    let delivered = false;
    for (const other of room.members.values()) {
      if (other.id === member.id || !other.connected || !other.socket) continue;
      delivered = this.send(other.socket, event) || delivered;
    }
    if (delivered) {
      this.send(socket, { type: "group_relay_accepted", relayId: command.relayId });
      this.hooks.onMessageRelayed?.(room.source);
    } else {
      this.send(socket, { type: "group_relay_rejected", relayId: command.relayId, reason: "unavailable" });
    }
  }

  private takeInboundBudget(member: GroupMember, bytes: number, now = Date.now()): boolean {
    const cutoff = now - this.config.inboundWindowMs;
    member.inboundFrames = member.inboundFrames.filter((frame) => frame.at > cutoff);
    const currentBytes = member.inboundFrames.reduce((total, frame) => total + frame.bytes, 0);
    if (
      member.inboundFrames.length >= this.config.maxInboundFramesPerWindow ||
      currentBytes + bytes > this.config.maxInboundBytesPerWindow
    ) return false;
    member.inboundFrames.push({ at: now, bytes });
    return true;
  }

  private takeRelayBudget(room: GroupRoom, member: GroupMember, now = Date.now()): boolean {
    const cutoff = now - this.config.relayWindowMs;
    member.relayTimes = member.relayTimes.filter((time) => time > cutoff);
    room.relayTimes = room.relayTimes.filter((time) => time > cutoff);
    if (
      member.relayTimes.length >= this.config.maxRelaysPerWindow ||
      room.relayTimes.length >= this.config.maxRoomRelaysPerWindow
    ) return false;
    member.relayTimes.push(now);
    room.relayTimes.push(now);
    return true;
  }

  private onSocketClosed(socket: WebSocket): void {
    const context = this.contexts.get(socket);
    this.contexts.delete(socket);
    if (!context) return;
    const room = this.rooms.get(context.roomId);
    const member = room?.members.get(context.memberId);
    if (
      !room || room.state !== "OPEN" || !member || member.socket !== socket ||
      member.connectionGeneration !== context.generation
    ) return;
    member.connected = false;
    member.socket = undefined;
    const generation = member.connectionGeneration;
    member.disconnectTimer = setTimeout(
      () => this.expireDisconnectedMember(room.id, member.id, generation),
      this.config.disconnectGraceMs
    );
    member.disconnectTimer.unref();
  }

  private expireDisconnectedMember(roomId: string, memberId: string, generation: number): void {
    const room = this.rooms.get(roomId);
    const member = room?.members.get(memberId);
    if (!room || !member || member.connected || member.connectionGeneration !== generation) return;
    this.removeMember(room, member);
    this.rotateEpoch(room);
    this.broadcastEpoch(room);
    this.broadcastPresence(room);
  }

  private removeMember(room: GroupRoom, member: GroupMember): void {
    if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
    this.resumeIndex.delete(member.resumeHash.toString("hex"));
    member.resumeHash.fill(0);
    member.relayTimes.length = 0;
    member.inboundFrames.length = 0;
    room.readyDigests.delete(member.id);
    room.members.delete(member.id);
    if (member.personaKind === "primary") {
      const primary = room.primaryPersonas.get(member.browserHash.toString("hex"));
      if (primary?.primaryMemberId === member.id) primary.primaryMemberId = undefined;
    }
    member.browserHash.fill(0);
    member.tabHash.fill(0);
    if (member.socket) this.contexts.delete(member.socket);
    member.socket = undefined;
    member.connected = false;
  }

  private replaceMember(room: GroupRoom, member: GroupMember): void {
    const previousSocket = member.socket;
    this.removeMember(room, member);
    if (previousSocket) previousSocket.close(4001, "session replaced");
  }

  private sweepHeartbeats(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      if (now >= room.expiresAt) {
        this.destroyRoom(room.id, "ttl");
        continue;
      }
      for (const member of room.members.values()) {
        if (!member.connected || !member.socket) continue;
        if (now - member.lastSeenAt > this.config.heartbeatStaleMs) member.socket.terminate();
      }
    }
  }

  destroyWithOwnerCapability(roomId: string, ownerCapability: string): boolean {
    const room = this.liveRoom(roomId);
    if (!room || !this.ownerMatches(room, ownerCapability)) return false;
    this.destroyRoom(room.id, "manual");
    return true;
  }

  destroyRoom(roomId: string, reason: GroupDestructionReason): boolean {
    const room = this.rooms.get(roomId);
    if (!room || room.state === "DESTROYED") return false;
    room.state = "DESTROYED";
    this.rooms.delete(room.id);
    this.inviteIndex.delete(room.inviteHash.toString("hex"));
    clearTimeout(room.hardTtlTimer);
    if (room.rekeyTimer) clearTimeout(room.rekeyTimer);
    room.inviteHash.fill(0);
    room.ownerVerifier.fill(0);
    room.ownerRecoveryVerifier.fill(0);
    room.ownerBrowserHash?.fill(0);
    room.ownerBrowserHash = undefined;
    room.readyDigests.clear();
    room.announcements.clear();
    room.confirmations.clear();
    room.relayTimes.length = 0;
    for (const primary of room.primaryPersonas.values()) primary.browserHash.fill(0);
    room.primaryPersonas.clear();
    room.usedNicknames.clear();
    const members = [...room.members.values()];
    room.members.clear();
    for (const member of members) {
      if (member.disconnectTimer) clearTimeout(member.disconnectTimer);
      this.resumeIndex.delete(member.resumeHash.toString("hex"));
      member.resumeHash.fill(0);
      member.browserHash.fill(0);
      member.tabHash.fill(0);
      member.relayTimes.length = 0;
      member.inboundFrames.length = 0;
      if (member.socket) {
        this.contexts.delete(member.socket);
        this.send(member.socket, { type: "group_destroyed" });
        member.socket.close(4000, "room destroyed");
      }
      member.socket = undefined;
      member.connected = false;
    }
    this.hooks.onDestroyed?.(reason);
    return true;
  }

  private roomForInvite(inviteToken: string, now = Date.now()): GroupRoom | undefined {
    if (!SECRET_PATTERN.test(inviteToken)) return undefined;
    const inviteHash = sha256(inviteToken);
    const roomId = this.inviteIndex.get(inviteHash.toString("hex"));
    const room = roomId ? this.liveRoom(roomId, now) : undefined;
    if (!room || !timingSafeEqual(room.inviteHash, inviteHash)) return undefined;
    return room;
  }

  private liveRoom(roomId: string, now = Date.now()): GroupRoom | undefined {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== "OPEN") return undefined;
    if (now >= room.expiresAt) {
      this.destroyRoom(room.id, "ttl");
      return undefined;
    }
    return room;
  }

  private ownerMatches(room: GroupRoom, ownerCapability?: string): boolean {
    if (!ownerCapability) return false;
    return hashesEqual(room.ownerVerifier, hashCapability(ownerCapability));
  }

  private ownerRecoveryMatches(room: GroupRoom, ownerRecoverySecret?: string): boolean {
    if (!ownerRecoverySecret) return false;
    return hashesEqual(room.ownerRecoveryVerifier, hashCapability(ownerRecoverySecret));
  }

  private recoverOwnerCapability(
    room: GroupRoom,
    browserHash: Buffer,
    ownerRecoverySecret?: string
  ): string | undefined {
    if (
      !room.ownerBrowserHash || !timingSafeEqual(room.ownerBrowserHash, browserHash) ||
      !this.ownerRecoveryMatches(room, ownerRecoverySecret)
    ) return undefined;
    const capability = randomToken(32);
    const verifier = hashCapability(capability);
    if (!verifier) return undefined;
    room.ownerVerifier.fill(0);
    room.ownerVerifier = verifier;
    return capability;
  }

  private attached(socket: WebSocket): { room: GroupRoom; member: GroupMember } | undefined {
    const context = this.contexts.get(socket);
    if (!context) return undefined;
    const room = this.liveRoom(context.roomId);
    const member = room?.members.get(context.memberId);
    if (
      !room || !member || !member.connected || member.socket !== socket ||
      member.connectionGeneration !== context.generation
    ) return undefined;
    return { room, member };
  }

  private rotateEpoch(room: GroupRoom): GroupEpochDescriptor {
    if (room.rekeyTimer) clearTimeout(room.rekeyTimer);
    room.rekeyTimer = undefined;
    room.epoch += 1;
    room.epochNonce = randomToken(32);
    room.epochMembers = [...room.members.values()]
      .map((member) => member.id)
      .sort();
    room.rosterDigest = sha256(
      encodeCanonicalGroupRoster(room.id, room.epoch, room.epochNonce, room.epochMembers)
    ).toString("base64url");
    room.readyDigests.clear();
    room.announcements.clear();
    room.confirmations.clear();
    room.readyEpochDigest = undefined;
    room.phase = room.epochMembers.length ? "REKEYING" : "ACTIVE";
    if (room.phase === "REKEYING") {
      const epoch = room.epoch;
      room.rekeyTimer = setTimeout(
        () => this.expireUnreadyMembers(room.id, epoch),
        this.config.rekeyTimeoutMs
      );
      room.rekeyTimer.unref();
    }
    this.hooks.onEpochChanged?.(room.id, room.epoch, room.rosterDigest);
    return this.epochDescriptor(room);
  }

  private expireUnreadyMembers(roomId: string, epoch: number): void {
    const room = this.rooms.get(roomId);
    if (!room || room.state !== "OPEN" || room.epoch !== epoch || room.phase !== "REKEYING") return;
    room.rekeyTimer = undefined;
    this.broadcast(room, { type: "group_epoch_failed", epoch: room.epoch, rosterDigest: room.rosterDigest });
  }

  private epochDescriptor(room: GroupRoom): GroupEpochDescriptor {
    return {
      epoch: room.epoch,
      epochNonce: room.epochNonce,
      rosterDigest: room.rosterDigest,
      members: [...room.epochMembers]
    };
  }

  private personaRoster(room: GroupRoom): GroupMemberPersona[] {
    return room.epochMembers.map((memberId) => {
      const member = room.members.get(memberId)!;
      return { memberId, ...member.persona };
    });
  }

  private sendSession(
    room: GroupRoom,
    member: GroupMember,
    resumeToken: string,
    ownerCapability?: string
  ): void {
    this.send(member.socket!, {
      type: "group_session",
      roomId: room.id,
      memberId: member.id,
      resumeToken,
      ownerAuthorized: member.ownerAuthorized,
      ...(ownerCapability ? { ownerCapability } : {}),
      state: "OPEN",
      phase: room.phase,
      expiresAt: room.expiresAt,
      heartbeatEveryMs: this.config.heartbeatEveryMs,
      disconnectGraceMs: this.config.disconnectGraceMs,
      maxParticipants: this.config.maxParticipants,
      presenceCount: room.members.size,
      persona: { ...member.persona },
      personaKind: member.personaKind,
      personas: this.personaRoster(room),
      ...this.epochDescriptor(room)
    });
  }

  private broadcastEpoch(room: GroupRoom, excluded?: WebSocket): void {
    if (!room.epochMembers.length) return;
    this.broadcast(room, {
      type: "group_epoch",
      phase: "REKEYING",
      personas: this.personaRoster(room),
      ...this.epochDescriptor(room)
    }, excluded);
  }

  private broadcastPresence(room: GroupRoom): void {
    this.broadcast(room, { type: "group_presence", presenceCount: room.members.size });
  }

  private broadcast(room: GroupRoom, event: GroupServerEvent, excluded?: WebSocket): void {
    for (const member of room.members.values()) {
      if (!member.connected || !member.socket || member.socket === excluded) continue;
      this.send(member.socket, event);
    }
  }

  private uniqueMemberId(room: GroupRoom): string {
    let memberId = randomToken(18);
    while (room.members.has(memberId)) memberId = randomToken(18);
    return memberId;
  }

  private send(socket: WebSocket, event: GroupServerEvent): boolean {
    if (socket.readyState !== 1) return false;
    const payload = JSON.stringify(event);
    if (socket.bufferedAmount + Buffer.byteLength(payload) > this.config.maxBufferedAmount) {
      socket.terminate();
      return false;
    }
    try {
      socket.send(payload);
      return true;
    } catch {
      return false;
    }
  }

  private gone(socket: WebSocket): false {
    this.send(socket, { type: "group_room_gone", message: GROUP_GONE_MESSAGE });
    socket.close(4404, "room unavailable");
    return false;
  }

  stats(): {
    activeRooms: number;
    inviteTokens: number;
    resumeTokens: number;
    participants: number;
    connectedSockets: number;
    storedMessages: number;
    personaMappings: number;
    usedPersonas: number;
  } {
    let participants = 0;
    let personaMappings = 0;
    let usedPersonas = 0;
    for (const room of this.rooms.values()) {
      participants += room.members.size;
      personaMappings += room.primaryPersonas.size;
      usedPersonas += room.usedNicknames.size;
    }
    return {
      activeRooms: this.rooms.size,
      inviteTokens: this.inviteIndex.size,
      resumeTokens: this.resumeIndex.size,
      participants,
      connectedSockets: this.contexts.size,
      storedMessages: 0,
      personaMappings,
      usedPersonas
    };
  }

  currentCounts(): { rooms: number; participants: number; connected: number; rekeying: number } {
    let participants = 0;
    let connected = 0;
    let rekeying = 0;
    for (const room of this.rooms.values()) {
      participants += room.members.size;
      connected += [...room.members.values()].filter((member) => member.connected).length;
      if (room.phase === "REKEYING") rekeying += 1;
    }
    return { rooms: this.rooms.size, participants, connected, rekeying };
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const roomId of [...this.rooms.keys()]) this.destroyRoom(roomId, "shutdown");
    this.contexts.clear();
    this.inviteIndex.clear();
    this.resumeIndex.clear();
  }
}

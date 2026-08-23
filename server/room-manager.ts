import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { WebSocket } from "ws";
import { GONE_MESSAGE, type ClientCommand, type InviteState, type Role, type RoomState, type ServerEvent } from "../shared/protocol.js";
import type { ChatConfig } from "./config.js";
import type { TrafficSource } from "./attribution.js";

interface Participant {
  role: Role;
  resumeHash: Buffer;
  socket?: WebSocket;
  connected: boolean;
  lastSeenAt: number;
  disconnectTimer?: NodeJS.Timeout;
  relayTimes: number[];
}

interface Room {
  id: string;
  source: TrafficSource;
  state: RoomState;
  inviteState: InviteState;
  inviteHash: Buffer | null;
  createdAt: number;
  expiresAt: number;
  creator: Participant;
  joiner?: Participant;
  hardTtlTimer: NodeJS.Timeout;
}

interface ConnectionContext {
  roomId: string;
  role: Role;
}

export interface CreateRoomResult {
  roomId: string;
  inviteToken: string;
  resumeToken: string;
  expiresAt: number;
}

export interface RoomManagerHooks {
  onRelay?: (opaqueRelay: string) => void;
  onTransition?: (from: RoomState, to: RoomState) => void;
  onRoomCreated?: (source: TrafficSource) => void;
  onConversationStarted?: (source: TrafficSource) => void;
  onMessageRelayed?: (source: TrafficSource) => void;
  onDestroyed?: (reason: DestructionReason) => void;
}

export type DestructionReason = "manual" | "disconnect" | "ttl" | "shutdown";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{32,128}$/;
const RELAY_PATTERN = /^[A-Za-z0-9_-]+$/;

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

function sameHash(left: Buffer, rawRight: string): boolean {
  const right = hash(rawRight);
  return left.length === right.length && timingSafeEqual(left, right);
}

function parseCommand(raw: string): ClientCommand | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.type === "resume" && typeof record.roomId === "string" && typeof record.resumeToken === "string") {
    return { type: "resume", roomId: record.roomId, resumeToken: record.resumeToken };
  }
  if (record.type === "join" && typeof record.inviteToken === "string") {
    return { type: "join", inviteToken: record.inviteToken };
  }
  if (record.type === "heartbeat" || record.type === "destroy") return { type: record.type };
  if (record.type === "relay" && typeof record.data === "string") return { type: "relay", data: record.data };
  return null;
}

function isEncryptedChatRelay(data: string): boolean {
  try {
    const value = JSON.parse(Buffer.from(data, "base64url").toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const packet = value as Record<string, unknown>;
    return (
      packet.v === 1 &&
      packet.kind === "ciphertext" &&
      typeof packet.id === "string" && packet.id.length > 0 &&
      Number.isSafeInteger(packet.sequence) && (packet.sequence as number) > 0 &&
      typeof packet.nonce === "string" && packet.nonce.length > 0 &&
      typeof packet.ciphertext === "string" && packet.ciphertext.length > 0
    );
  } catch {
    return false;
  }
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly inviteIndex = new Map<string, string>();
  private readonly contexts = new Map<WebSocket, ConnectionContext>();
  private readonly sweepTimer: NodeJS.Timeout;

  constructor(
    private readonly config: ChatConfig,
    private readonly hooks: RoomManagerHooks = {}
  ) {
    const interval = Math.max(100, Math.min(1000, Math.floor(config.heartbeatEveryMs / 2)));
    this.sweepTimer = setInterval(() => this.sweepHeartbeats(), interval);
    this.sweepTimer.unref();
  }

  createRoom(now = Date.now(), source: TrafficSource = "direct"): CreateRoomResult {
    const roomId = token(24);
    const inviteToken = token(32);
    const resumeToken = token(32);
    const inviteHash = hash(inviteToken);
    const expiresAt = now + this.config.hardTtlMs;
    const room: Room = {
      id: roomId,
      source,
      state: "CREATED",
      inviteState: "ACTIVE",
      inviteHash,
      createdAt: now,
      expiresAt,
      creator: {
        role: "creator",
        resumeHash: hash(resumeToken),
        connected: false,
        lastSeenAt: now,
        relayTimes: []
      },
      hardTtlTimer: setTimeout(() => this.destroyRoom(roomId, "ttl"), this.config.hardTtlMs)
    };
    room.hardTtlTimer.unref();
    this.rooms.set(roomId, room);
    this.inviteIndex.set(inviteHash.toString("hex"), roomId);
    this.transition(room, "WAITING");
    this.hooks.onRoomCreated?.(room.source);
    return { roomId, inviteToken, resumeToken, expiresAt };
  }

  hasActiveInvite(inviteToken: string): boolean {
    if (!TOKEN_PATTERN.test(inviteToken)) return false;
    const inviteHash = hash(inviteToken);
    const roomId = this.inviteIndex.get(inviteHash.toString("hex"));
    const room = roomId ? this.rooms.get(roomId) : undefined;
    return Boolean(
      room && room.state === "WAITING" && room.inviteState === "ACTIVE" && !room.joiner &&
      room.inviteHash && timingSafeEqual(room.inviteHash, inviteHash)
    );
  }

  acceptSocket(socket: WebSocket): void {
    const authTimer = setTimeout(() => {
      this.send(socket, { type: "room_gone", message: GONE_MESSAGE });
      socket.close(4408, "authentication timeout");
    }, this.config.authTimeoutMs);
    authTimer.unref();

    const authenticate = (data: Buffer, isBinary: boolean) => {
      clearTimeout(authTimer);
      if (isBinary || data.byteLength > this.config.maxWsMessageBytes) {
        socket.close(4400, "invalid message");
        return;
      }
      const command = parseCommand(data.toString("utf8"));
      if (!command || (command.type !== "resume" && command.type !== "join")) {
        this.gone(socket);
        return;
      }
      const attached = command.type === "resume"
        ? this.resume(socket, command.roomId, command.resumeToken)
        : this.join(socket, command.inviteToken);
      if (!attached) return;
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

  private resume(socket: WebSocket, roomId: string, resumeToken: string): boolean {
    if (!TOKEN_PATTERN.test(roomId) || !TOKEN_PATTERN.test(resumeToken)) return this.gone(socket);
    const room = this.rooms.get(roomId);
    if (!room || room.state === "DESTROYED") return this.gone(socket);
    let participant: Participant | undefined;
    if (sameHash(room.creator.resumeHash, resumeToken)) participant = room.creator;
    else if (room.joiner && sameHash(room.joiner.resumeHash, resumeToken)) participant = room.joiner;
    if (!participant || participant.connected) return this.gone(socket);
    this.attach(room, participant, socket, true);
    this.send(socket, {
      type: "session",
      roomId: room.id,
      role: participant.role,
      state: room.state === "ACTIVE" ? "ACTIVE" : "WAITING",
      inviteState: room.inviteState,
      expiresAt: room.expiresAt,
      heartbeatEveryMs: this.config.heartbeatEveryMs,
      disconnectGraceMs: this.config.disconnectGraceMs,
      peerConnected: this.peerOf(room, participant.role)?.connected === true
    });
    return true;
  }

  private join(socket: WebSocket, inviteToken: string): boolean {
    if (!TOKEN_PATTERN.test(inviteToken)) return this.gone(socket);
    const inviteHash = hash(inviteToken);
    const inviteKey = inviteHash.toString("hex");
    const roomId = this.inviteIndex.get(inviteKey);
    const room = roomId ? this.rooms.get(roomId) : undefined;
    if (!room || room.state !== "WAITING" || room.inviteState !== "ACTIVE" || room.joiner) return this.gone(socket);
    if (!room.inviteHash || !timingSafeEqual(room.inviteHash, inviteHash)) return this.gone(socket);

    this.inviteIndex.delete(inviteKey);
    room.inviteHash.fill(0);
    room.inviteHash = null;
    room.inviteState = "CONSUMED";
    clearTimeout(room.hardTtlTimer);
    room.expiresAt = Date.now() + this.config.hardTtlMs;
    room.hardTtlTimer = setTimeout(() => this.destroyRoom(room.id, "ttl"), this.config.hardTtlMs);
    room.hardTtlTimer.unref();
    const resumeToken = token(32);
    const participant: Participant = {
      role: "joiner",
      resumeHash: hash(resumeToken),
      connected: false,
      lastSeenAt: Date.now(),
      relayTimes: []
    };
    room.joiner = participant;
    this.transition(room, "ACTIVE");
    this.hooks.onConversationStarted?.(room.source);
    this.attach(room, participant, socket, false);
    this.send(socket, {
      type: "session",
      roomId: room.id,
      role: "joiner",
      state: "ACTIVE",
      inviteState: "CONSUMED",
      resumeToken,
      expiresAt: room.expiresAt,
      heartbeatEveryMs: this.config.heartbeatEveryMs,
      disconnectGraceMs: this.config.disconnectGraceMs,
      peerConnected: room.creator.connected
    });
    if (room.creator.connected && room.creator.socket) {
      this.send(room.creator.socket, { type: "peer_joined", inviteState: "CONSUMED", expiresAt: room.expiresAt });
    }
    return true;
  }

  private attach(room: Room, participant: Participant, socket: WebSocket, notifyPeer: boolean): void {
    if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
    participant.disconnectTimer = undefined;
    participant.socket = socket;
    participant.connected = true;
    participant.lastSeenAt = Date.now();
    participant.relayTimes = [];
    this.contexts.set(socket, { roomId: room.id, role: participant.role });
    const peer = this.peerOf(room, participant.role);
    if (notifyPeer && peer?.connected && peer.socket) this.send(peer.socket, { type: "peer_resumed" });
  }

  private handleAuthenticatedMessage(socket: WebSocket, data: Buffer, isBinary: boolean): void {
    const context = this.contexts.get(socket);
    if (!context) return;
    const room = this.rooms.get(context.roomId);
    const participant = room ? this.participantOf(room, context.role) : undefined;
    if (!room || !participant || participant.socket !== socket) {
      this.gone(socket);
      return;
    }
    if (isBinary || data.byteLength > this.config.maxWsMessageBytes) {
      socket.close(4400, "invalid message");
      return;
    }
    const command = parseCommand(data.toString("utf8"));
    if (!command || command.type === "join" || command.type === "resume") {
      socket.close(4400, "invalid message");
      return;
    }
    participant.lastSeenAt = Date.now();
    if (command.type === "heartbeat") return;
    if (command.type === "destroy") {
      this.destroyRoom(room.id, "manual");
      return;
    }
    if (room.state !== "ACTIVE" || !RELAY_PATTERN.test(command.data) || command.data.length > this.config.maxRelayChars) {
      socket.close(4400, "invalid relay");
      return;
    }
    const now = Date.now();
    participant.relayTimes = participant.relayTimes.filter((time) => time > now - this.config.relayWindowMs);
    if (participant.relayTimes.length >= this.config.maxRelaysPerWindow) {
      this.send(socket, { type: "rate_limited" });
      return;
    }
    participant.relayTimes.push(now);
    const peer = this.peerOf(room, participant.role);
    if (!peer?.connected || !peer.socket) return;
    if (this.send(peer.socket, { type: "relay", data: command.data })) {
      if (isEncryptedChatRelay(command.data)) this.hooks.onMessageRelayed?.(room.source);
      this.hooks.onRelay?.(command.data);
    }
  }

  private onSocketClosed(socket: WebSocket): void {
    const context = this.contexts.get(socket);
    this.contexts.delete(socket);
    if (!context) return;
    const room = this.rooms.get(context.roomId);
    const participant = room ? this.participantOf(room, context.role) : undefined;
    if (!room || !participant || participant.socket !== socket || room.state === "DESTROYED") return;
    participant.connected = false;
    participant.socket = undefined;
    const graceEndsAt = Date.now() + this.config.disconnectGraceMs;
    const peer = this.peerOf(room, participant.role);
    if (peer?.connected && peer.socket) this.send(peer.socket, { type: "peer_disconnected", graceEndsAt });
    participant.disconnectTimer = setTimeout(() => this.destroyRoom(room.id, "disconnect"), this.config.disconnectGraceMs);
    participant.disconnectTimer.unref();
  }

  private sweepHeartbeats(): void {
    const now = Date.now();
    for (const room of this.rooms.values()) {
      for (const participant of [room.creator, room.joiner]) {
        if (!participant?.connected || !participant.socket) continue;
        if (now - participant.lastSeenAt > this.config.heartbeatStaleMs) participant.socket.terminate();
      }
    }
  }

  destroyRoom(roomId: string, reason: DestructionReason): void {
    const room = this.rooms.get(roomId);
    if (!room || room.state === "DESTROYED") return;
    this.transition(room, "DESTROYED");
    this.hooks.onDestroyed?.(reason);
    clearTimeout(room.hardTtlTimer);
    if (room.inviteHash) {
      this.inviteIndex.delete(room.inviteHash.toString("hex"));
      room.inviteHash.fill(0);
      room.inviteHash = null;
    }
    for (const participant of [room.creator, room.joiner]) {
      if (!participant) continue;
      if (participant.disconnectTimer) clearTimeout(participant.disconnectTimer);
      participant.resumeHash.fill(0);
      participant.relayTimes.length = 0;
      if (participant.socket) {
        this.contexts.delete(participant.socket);
        this.send(participant.socket, { type: "destroyed" });
        participant.socket.close(4000, "conversation destroyed");
      }
      participant.socket = undefined;
      participant.connected = false;
    }
    room.joiner = undefined;
    this.rooms.delete(roomId);
  }

  private transition(room: Room, next: RoomState): void {
    const allowed: Record<RoomState, RoomState[]> = {
      CREATED: ["WAITING", "DESTROYED"],
      WAITING: ["ACTIVE", "DESTROYED"],
      ACTIVE: ["DESTROYED"],
      DESTROYED: []
    };
    if (!allowed[room.state].includes(next)) throw new Error(`Invalid room transition ${room.state} -> ${next}`);
    const previous = room.state;
    room.state = next;
    this.hooks.onTransition?.(previous, next);
  }

  private participantOf(room: Room, role: Role): Participant | undefined {
    return role === "creator" ? room.creator : room.joiner;
  }

  private peerOf(room: Room, role: Role): Participant | undefined {
    return role === "creator" ? room.joiner : room.creator;
  }

  private send(socket: WebSocket, event: ServerEvent): boolean {
    if (socket.readyState !== 1) return false;
    try {
      socket.send(JSON.stringify(event));
      return true;
    } catch {
      return false;
    }
  }

  private gone(socket: WebSocket): false {
    this.send(socket, { type: "room_gone", message: GONE_MESSAGE });
    socket.close(4404, "conversation unavailable");
    return false;
  }

  stats(): { activeRooms: number; inviteTokens: number; connectedSockets: number; storedMessages: number } {
    return {
      activeRooms: this.rooms.size,
      inviteTokens: this.inviteIndex.size,
      connectedSockets: this.contexts.size,
      storedMessages: 0
    };
  }

  currentCounts(): { waiting: number; active: number } {
    let waiting = 0;
    let active = 0;
    for (const room of this.rooms.values()) {
      if (room.state === "WAITING") waiting += 1;
      else if (room.state === "ACTIVE") active += 1;
    }
    return { waiting, active };
  }

  shutdown(): void {
    clearInterval(this.sweepTimer);
    for (const roomId of [...this.rooms.keys()]) this.destroyRoom(roomId, "shutdown");
    this.contexts.clear();
    this.inviteIndex.clear();
  }
}

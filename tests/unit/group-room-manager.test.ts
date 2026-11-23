import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { GroupRoomManager } from "../../server/group-room-manager.js";
import type { GroupClientCommand, GroupParticipantLimit, GroupServerEvent } from "../../shared/group-protocol.js";

class FakeSocket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  readonly sent: GroupServerEvent[] = [];
  terminated = false;
  closeCode?: number;

  send(payload: string): void {
    this.sent.push(JSON.parse(payload) as GroupServerEvent);
  }

  close(code?: number): void {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.readyState = 3;
    this.emit("close");
  }

  terminate(): void {
    if (this.readyState === 3) return;
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }

  receive(command: GroupClientCommand | Record<string, unknown>): void {
    this.emit("message", Buffer.from(JSON.stringify(command)), false);
  }
}

const managers: GroupRoomManager[] = [];

function room(manager: GroupRoomManager, participantLimit: GroupParticipantLimit = 10): {
  inviteToken: string;
  capability: string;
  participantLimit: GroupParticipantLimit;
} {
  const capability = randomBytes(32);
  const verifier = createHash("sha256").update(capability).digest("base64url");
  const recoveryVerifier = createHash("sha256").update(randomBytes(32)).digest("base64url");
  return {
    ...manager.createRoom(verifier, recoveryVerifier, Date.now(), "direct", participantLimit)!,
    capability: capability.toString("base64url")
  };
}

function join(manager: GroupRoomManager, socket: FakeSocket, inviteToken: string, ownerCapability?: string): void {
  manager.acceptSocket(socket as unknown as WebSocket);
  socket.receive({
    type: "group_join",
    inviteToken,
    browserVerifier: randomBytes(32).toString("base64url"),
    tabVerifier: randomBytes(32).toString("base64url"),
    ...(ownerCapability ? { ownerCapability } : {})
  });
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

describe("GroupRoomManager hardening", () => {
  it("stores every supported immutable participant limit and defaults old callers to ten", () => {
    const manager = new GroupRoomManager({ maxRooms: 20, maxEmptyRooms: 20, rekeyTimeoutMs: 60_000 });
    managers.push(manager);
    for (const participantLimit of [3, 4, 5, 6, 7, 8, 9, 10] as const) {
      expect(room(manager, participantLimit).participantLimit).toBe(participantLimit);
    }
    const capability = randomBytes(32);
    const verifier = createHash("sha256").update(capability).digest("base64url");
    const recoveryVerifier = createHash("sha256").update(randomBytes(32)).digest("base64url");
    expect(manager.createRoom(verifier, recoveryVerifier)?.participantLimit).toBe(10);
    for (const invalid of [0, 1, 2, 11, -1, 3.5, Number.NaN, Number.POSITIVE_INFINITY, "5", null]) {
      expect(() => manager.createRoom(
        verifier,
        recoveryVerifier,
        Date.now(),
        "direct",
        invalid as GroupParticipantLimit
      )).toThrow("Invalid group participant limit");
    }
  });

  it("admits the final allowed participant, auto-seals once, and rejects the next serialized join", () => {
    let sealedCount = 0;
    const manager = new GroupRoomManager(
      { rekeyTimeoutMs: 60_000 },
      { onSealed: () => { sealedCount += 1; } }
    );
    managers.push(manager);
    const created = room(manager, 3);
    const first = new FakeSocket();
    const second = new FakeSocket();
    const third = new FakeSocket();
    const racingFourth = new FakeSocket();
    join(manager, first, created.inviteToken, created.capability);
    join(manager, second, created.inviteToken);
    join(manager, third, created.inviteToken);
    join(manager, racingFourth, created.inviteToken);

    expect(manager.currentCounts()).toMatchObject({ participants: 3, connected: 3 });
    expect(third.sent.some((event) => event.type === "group_session" && event.participantLimit === 3)).toBe(true);
    expect([first, second, third].every((socket) => socket.sent.some((event) => event.type === "group_room_sealed"))).toBe(true);
    expect(manager.hasActiveInvite(created.inviteToken)).toBe(false);
    expect(racingFourth.sent.at(-1)?.type).toBe("group_room_gone");
    expect(sealedCount).toBe(1);
  });

  it("serializes competing final admissions at both four and ten participants", () => {
    for (const participantLimit of [4, 10] as const) {
      const manager = new GroupRoomManager({ rekeyTimeoutMs: 60_000 });
      managers.push(manager);
      const created = room(manager, participantLimit);
      for (let index = 0; index < participantLimit - 1; index += 1) {
        join(manager, new FakeSocket(), created.inviteToken, index === 0 ? created.capability : undefined);
      }
      const finalAllowed = new FakeSocket();
      const competing = new FakeSocket();
      join(manager, finalAllowed, created.inviteToken);
      join(manager, competing, created.inviteToken);

      expect(finalAllowed.sent.some((event) =>
        event.type === "group_session" && event.presenceCount === participantLimit
      )).toBe(true);
      expect(competing.sent.at(-1)?.type).toBe("group_room_gone");
      expect(manager.currentCounts().participants).toBe(participantLimit);
      expect(manager.hasActiveInvite(created.inviteToken)).toBe(false);
    }
  });

  it("caps the pool of empty rooms independently of the total room cap", () => {
    const manager = new GroupRoomManager({ maxRooms: 3, maxEmptyRooms: 1, rekeyTimeoutMs: 60_000 });
    managers.push(manager);
    const first = room(manager);
    const verifier = createHash("sha256").update(randomBytes(32)).digest("base64url");
    const recoveryVerifier = createHash("sha256").update(randomBytes(32)).digest("base64url");
    expect(manager.createRoom(verifier, recoveryVerifier)).toBeNull();

    join(manager, new FakeSocket(), first.inviteToken);
    expect(manager.createRoom(verifier, recoveryVerifier)).not.toBeNull();
  });

  it("terminates a slow consumer before queuing another server event", () => {
    const manager = new GroupRoomManager({ maxBufferedAmount: 1024, rekeyTimeoutMs: 60_000 });
    managers.push(manager);
    const created = room(manager);
    const slow = new FakeSocket();
    join(manager, slow, created.inviteToken);
    slow.bufferedAmount = 1024;

    const healthy = new FakeSocket();
    join(manager, healthy, created.inviteToken);

    expect(slow.terminated).toBe(true);
    expect(healthy.terminated).toBe(false);
    expect(manager.currentCounts().connected).toBe(1);
  });

  it("applies an all-frame budget per offender without disconnecting another member", () => {
    const manager = new GroupRoomManager({
      maxInboundFramesPerWindow: 2,
      maxInboundBytesPerWindow: 1024 * 1024,
      rekeyTimeoutMs: 60_000
    });
    managers.push(manager);
    const created = room(manager);
    const offender = new FakeSocket();
    const peer = new FakeSocket();
    join(manager, offender, created.inviteToken);
    join(manager, peer, created.inviteToken);

    offender.receive({ type: "heartbeat" });
    offender.receive({ type: "heartbeat" });
    offender.receive({ type: "heartbeat" });

    expect(offender.closeCode).toBe(4408);
    expect(peer.readyState).toBe(1);
    expect(manager.currentCounts().connected).toBe(1);
  });

  it("applies the inbound byte ceiling independently of the frame ceiling", () => {
    const manager = new GroupRoomManager({
      maxInboundFramesPerWindow: 100,
      maxInboundBytesPerWindow: 30,
      rekeyTimeoutMs: 60_000
    });
    managers.push(manager);
    const created = room(manager);
    const offender = new FakeSocket();
    const peer = new FakeSocket();
    join(manager, offender, created.inviteToken);
    join(manager, peer, created.inviteToken);

    offender.receive({ type: "heartbeat" });
    offender.receive({ type: "heartbeat" });

    expect(offender.closeCode).toBe(4408);
    expect(peer.readyState).toBe(1);
  });

  it("rejects unknown outer fields on only the sending socket", () => {
    const manager = new GroupRoomManager({ rekeyTimeoutMs: 60_000 });
    managers.push(manager);
    const created = room(manager);
    const offender = new FakeSocket();
    const peer = new FakeSocket();
    join(manager, offender, created.inviteToken);
    join(manager, peer, created.inviteToken);

    offender.receive({ type: "heartbeat", padding: "not allowed" });

    expect(offender.closeCode).toBe(4400);
    expect(peer.readyState).toBe(1);
  });

  it("seals admission atomically, preserves admitted sockets, and counts only the first owner seal", () => {
    let sealedCount = 0;
    const manager = new GroupRoomManager(
      { rekeyTimeoutMs: 60_000 },
      { onSealed: () => { sealedCount += 1; } }
    );
    managers.push(manager);
    const created = room(manager);
    const owner = new FakeSocket();
    const admitted = new FakeSocket();
    join(manager, owner, created.inviteToken, created.capability);
    join(manager, admitted, created.inviteToken);

    admitted.receive({ type: "group_seal", ownerCapability: randomBytes(32).toString("base64url") });
    expect(admitted.sent.at(-1)?.type).toBe("group_forbidden");
    expect(manager.hasActiveInvite(created.inviteToken)).toBe(true);

    owner.receive({ type: "group_seal", ownerCapability: created.capability });
    expect(owner.sent.some((event) => event.type === "group_room_sealed")).toBe(true);
    expect(admitted.sent.some((event) => event.type === "group_room_sealed")).toBe(true);
    expect(manager.hasActiveInvite(created.inviteToken)).toBe(false);
    expect(manager.currentCounts()).toMatchObject({ rooms: 1, participants: 2, connected: 2 });
    expect(sealedCount).toBe(1);

    const late = new FakeSocket();
    join(manager, late, created.inviteToken);
    expect(late.sent.at(-1)?.type).toBe("group_room_gone");
    expect(manager.currentCounts()).toMatchObject({ participants: 2, connected: 2 });

    owner.receive({ type: "group_seal", ownerCapability: created.capability });
    expect(owner.sent.at(-1)?.type).toBe("group_room_sealed");
    expect(sealedCount).toBe(1);
  });
});

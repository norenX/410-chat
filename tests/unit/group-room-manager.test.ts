import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import type { WebSocket } from "ws";
import { afterEach, describe, expect, it } from "vitest";
import { GroupRoomManager } from "../../server/group-room-manager.js";
import type { GroupClientCommand, GroupServerEvent } from "../../shared/group-protocol.js";

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

function room(manager: GroupRoomManager): { inviteToken: string } {
  const capability = randomBytes(32);
  const verifier = createHash("sha256").update(capability).digest("base64url");
  return manager.createRoom(verifier)!;
}

function join(manager: GroupRoomManager, socket: FakeSocket, inviteToken: string): void {
  manager.acceptSocket(socket as unknown as WebSocket);
  socket.receive({ type: "group_join", inviteToken });
}

afterEach(() => {
  for (const manager of managers.splice(0)) manager.shutdown();
});

describe("GroupRoomManager hardening", () => {
  it("caps the pool of empty rooms independently of the total room cap", () => {
    const manager = new GroupRoomManager({ maxRooms: 3, maxEmptyRooms: 1, rekeyTimeoutMs: 60_000 });
    managers.push(manager);
    const first = room(manager);
    const verifier = createHash("sha256").update(randomBytes(32)).digest("base64url");
    expect(manager.createRoom(verifier)).toBeNull();

    join(manager, new FakeSocket(), first.inviteToken);
    expect(manager.createRoom(verifier)).not.toBeNull();
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
});

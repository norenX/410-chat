import { createHash, randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { encodeCanonicalGroupRoster, type GroupEpochDescriptor } from "../../shared/group-protocol.js";
import {
  GroupCryptoSession,
  groupSodiumReady,
  type GroupDecryptedMessage,
  type GroupInboundApplication,
  type GroupOutboundControl,
  type GroupOutboundReady
} from "../../client/src/group-crypto-session.js";

const ROOM_ID = "R".repeat(32);
const MEMBER_A = "A".repeat(24);
const MEMBER_B = "B".repeat(24);
const MEMBER_C = "C".repeat(24);

function token(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function descriptor(epoch: number, members: string[]): GroupEpochDescriptor {
  const epochNonce = token();
  const sorted = [...members].sort();
  return {
    epoch,
    epochNonce,
    members: sorted,
    rosterDigest: createHash("sha256")
      .update(encodeCanonicalGroupRoster(ROOM_ID, epoch, epochNonce, sorted))
      .digest("base64url")
  };
}

interface QueuedControl extends GroupOutboundControl {
  from: string;
}

class CryptoHarness {
  readonly sessions = new Map<string, GroupCryptoSession>();
  readonly messages = new Map<string, GroupDecryptedMessage[]>();
  readonly active = new Map<string, string>();
  readonly controls: QueuedControl[] = [];
  readonly readies: Array<GroupOutboundReady & { from: string }> = [];

  constructor(readonly linkSecret = token()) {}

  add(memberId: string): GroupCryptoSession {
    const received: GroupDecryptedMessage[] = [];
    this.messages.set(memberId, received);
    const session = new GroupCryptoSession({
      roomId: ROOM_ID,
      selfMemberId: memberId,
      linkSecret: this.linkSecret,
      callbacks: {
        sendControl: (control) => this.controls.push({ from: memberId, ...control }),
        sendReady: (ready) => this.readies.push({ from: memberId, ...ready }),
        onActive: ({ epochDigest }) => this.active.set(memberId, epochDigest),
        onMessage: (message) => received.push(message)
      }
    });
    this.sessions.set(memberId, session);
    return session;
  }

  async establish(epochDescriptor: GroupEpochDescriptor): Promise<string> {
    this.controls.length = 0;
    this.readies.length = 0;
    await Promise.all(epochDescriptor.members.map((memberId) => {
      const session = this.sessions.get(memberId);
      if (!session) throw new Error(`Missing session ${memberId}`);
      return session.beginEpoch(epochDescriptor);
    }));
    while (this.controls.length) {
      const control = this.controls.shift()!;
      const recipients = control.to
        ? [control.to]
        : epochDescriptor.members.filter((memberId) => memberId !== control.from);
      for (const recipient of recipients) {
        this.sessions.get(recipient)!.handleControl({
          epoch: control.epoch,
          rosterDigest: control.rosterDigest,
          from: control.from,
          data: control.data
        });
      }
    }
    expect(this.readies.map((ready) => ready.from).sort()).toEqual([...epochDescriptor.members].sort());
    const digests = new Set(this.readies.map((ready) => ready.epochDigest));
    expect(digests.size).toBe(1);
    const epochDigest = this.readies[0]!.epochDigest;
    for (const memberId of epochDescriptor.members) {
      this.sessions.get(memberId)!.handleEpochReady({
        epoch: epochDescriptor.epoch,
        rosterDigest: epochDescriptor.rosterDigest,
        epochDigest
      });
    }
    return epochDigest;
  }

  encrypt(from: string, message: GroupDecryptedMessage): GroupInboundApplication {
    const session = this.sessions.get(from)!;
    const encrypted = session.encryptMessage(message);
    session.commitOutbound();
    return { from, ...encrypted };
  }

  deliver(to: string, event: GroupInboundApplication): void {
    this.sessions.get(to)!.handleApplication(event);
  }

  destroy(): void {
    for (const session of this.sessions.values()) session.destroy();
  }
}

beforeAll(groupSodiumReady);

describe("GroupCryptoSession", () => {
  it("establishes one canonical full-group epoch and exchanges recipient-wrapped ciphertext", async () => {
    const harness = new CryptoHarness();
    harness.add(MEMBER_A);
    harness.add(MEMBER_B);
    harness.add(MEMBER_C);
    const epochDigest = await harness.establish(descriptor(1, [MEMBER_A, MEMBER_B, MEMBER_C]));
    expect(new Set(harness.active.values())).toEqual(new Set([epochDigest]));

    const event = harness.encrypt(MEMBER_A, { id: "m1", text: "hello room", sentAt: 1 });
    expect(Buffer.from(event.data, "base64url").toString("utf8")).not.toContain("hello room");
    harness.deliver(MEMBER_B, event);
    harness.deliver(MEMBER_C, event);
    expect(harness.messages.get(MEMBER_B)).toEqual([{ id: "m1", text: "hello room", sentAt: 1 }]);
    expect(harness.messages.get(MEMBER_C)).toEqual([{ id: "m1", text: "hello room", sentAt: 1 }]);
    harness.destroy();
  });

  it("prevents a joining member from reading an old epoch and a removed member from reading a new epoch", async () => {
    const harness = new CryptoHarness();
    harness.add(MEMBER_A);
    harness.add(MEMBER_B);
    await harness.establish(descriptor(1, [MEMBER_A, MEMBER_B]));
    const oldEvent = harness.encrypt(MEMBER_A, { id: "old", text: "before C", sentAt: 1 });
    harness.deliver(MEMBER_B, oldEvent);

    harness.add(MEMBER_C);
    await harness.establish(descriptor(2, [MEMBER_A, MEMBER_B, MEMBER_C]));
    expect(() => harness.deliver(MEMBER_C, oldEvent)).toThrow(/epoch/i);

    await harness.establish(descriptor(3, [MEMBER_A, MEMBER_B]));
    const futureEvent = harness.encrypt(MEMBER_A, { id: "future", text: "after C", sentAt: 2 });
    harness.deliver(MEMBER_B, futureEvent);
    expect(() => harness.deliver(MEMBER_C, futureEvent)).toThrow(/epoch/i);
    expect(harness.messages.get(MEMBER_C)).toEqual([]);
    harness.destroy();
  });

  it("rejects replay and old-epoch packets, ignores stale descriptors, and rejects wrong ready digests", async () => {
    const harness = new CryptoHarness();
    harness.add(MEMBER_A);
    harness.add(MEMBER_B);
    const firstDescriptor = descriptor(1, [MEMBER_A, MEMBER_B]);
    await harness.establish(firstDescriptor);
    const event = harness.encrypt(MEMBER_A, { id: "once", text: "once", sentAt: 1 });
    harness.deliver(MEMBER_B, event);
    expect(() => harness.deliver(MEMBER_B, event)).toThrow(/replayed|reordered/i);

    const secondDescriptor = descriptor(2, [MEMBER_A, MEMBER_B]);
    await harness.establish(secondDescriptor);
    expect(() => harness.deliver(MEMBER_B, event)).toThrow(/epoch/i);
    await expect(harness.sessions.get(MEMBER_A)!.beginEpoch(firstDescriptor)).resolves.toBeUndefined();

    const thirdDescriptor = descriptor(3, [MEMBER_A, MEMBER_B]);
    harness.controls.length = 0;
    harness.readies.length = 0;
    await Promise.all([
      harness.sessions.get(MEMBER_A)!.beginEpoch(thirdDescriptor),
      harness.sessions.get(MEMBER_B)!.beginEpoch(thirdDescriptor)
    ]);
    while (harness.controls.length) {
      const control = harness.controls.shift()!;
      const targets = control.to ? [control.to] : thirdDescriptor.members.filter((id) => id !== control.from);
      for (const target of targets) {
        harness.sessions.get(target)!.handleControl({ ...control, from: control.from });
      }
    }
    const ready = harness.readies.find((item) => item.from === MEMBER_A)!;
    expect(() => harness.sessions.get(MEMBER_A)!.handleEpochReady({
      epoch: ready.epoch,
      rosterDigest: ready.rosterDigest,
      epochDigest: token()
    })).toThrow(/digest/i);
    harness.destroy();
  });

  it("rejects unauthenticated and stale key announcements", async () => {
    const harness = new CryptoHarness();
    const a = harness.add(MEMBER_A);
    const b = harness.add(MEMBER_B);
    const current = descriptor(1, [MEMBER_A, MEMBER_B]);
    await Promise.all([a.beginEpoch(current), b.beginEpoch(current)]);
    const announcement = harness.controls.find((control) => control.from === MEMBER_A && !control.to)!;
    const packet = JSON.parse(Buffer.from(announcement.data, "base64url").toString("utf8")) as Record<string, unknown>;
    packet.authTag = token();
    expect(() => b.handleControl({
      epoch: current.epoch,
      rosterDigest: current.rosterDigest,
      from: MEMBER_A,
      data: Buffer.from(JSON.stringify(packet)).toString("base64url")
    })).toThrow(/unauthenticated/i);

    const stale = { ...announcement, epoch: 0 };
    expect(() => b.handleControl({ ...stale, from: MEMBER_A })).toThrow(/stale/i);
    harness.destroy();
  });

  it("reuses an uncommitted sequence after relay rejection without creating a receive gap", async () => {
    const harness = new CryptoHarness();
    const a = harness.add(MEMBER_A);
    harness.add(MEMBER_B);
    await harness.establish(descriptor(1, [MEMBER_A, MEMBER_B]));

    const rejected = a.encryptMessage({ id: "rejected", text: "not relayed", sentAt: 1 });
    const rejectedPacket = JSON.parse(Buffer.from(rejected.data, "base64url").toString("utf8")) as {
      wraps: Array<{ sequence: number }>;
    };
    expect(rejectedPacket.wraps[0]?.sequence).toBe(1);
    a.rejectOutbound();

    const accepted = a.encryptMessage({ id: "accepted", text: "relayed", sentAt: 2 });
    const acceptedPacket = JSON.parse(Buffer.from(accepted.data, "base64url").toString("utf8")) as {
      wraps: Array<{ sequence: number }>;
    };
    expect(acceptedPacket.wraps[0]?.sequence).toBe(1);
    a.commitOutbound();
    harness.deliver(MEMBER_B, { from: MEMBER_A, ...accepted });

    const next = a.encryptMessage({ id: "next", text: "sequence two", sentAt: 3 });
    const nextPacket = JSON.parse(Buffer.from(next.data, "base64url").toString("utf8")) as {
      wraps: Array<{ sequence: number }>;
    };
    expect(nextPacket.wraps[0]?.sequence).toBe(2);
    a.commitOutbound();
    harness.deliver(MEMBER_B, { from: MEMBER_A, ...next });
    expect(harness.messages.get(MEMBER_B)?.map((message) => message.id)).toEqual(["accepted", "next"]);
    harness.destroy();
  });

  it("treats exact duplicate control as idempotent and rejects conflicting or extended schemas", async () => {
    const harness = new CryptoHarness();
    const a = harness.add(MEMBER_A);
    const b = harness.add(MEMBER_B);
    const current = descriptor(1, [MEMBER_A, MEMBER_B]);
    await Promise.all([a.beginEpoch(current), b.beginEpoch(current)]);
    const announcement = harness.controls.find((control) => control.from === MEMBER_A && !control.to)!;
    const inbound = { ...announcement, from: MEMBER_A };
    expect(() => b.handleControl(inbound)).not.toThrow();
    expect(() => b.handleControl(inbound)).not.toThrow();

    const packet = JSON.parse(Buffer.from(announcement.data, "base64url").toString("utf8")) as Record<string, unknown>;
    const extended = Buffer.from(JSON.stringify({ ...packet, ignored: true })).toString("base64url");
    expect(() => b.handleControl({ ...inbound, data: extended })).toThrow(/unknown|conflicting/i);
    harness.destroy();
  });

  it("rejects timestamps outside the safe Date range before encryption", async () => {
    const harness = new CryptoHarness();
    const a = harness.add(MEMBER_A);
    harness.add(MEMBER_B);
    await harness.establish(descriptor(1, [MEMBER_A, MEMBER_B]));
    for (const sentAt of [Number.MAX_VALUE, Number.POSITIVE_INFINITY, -1, 1.5]) {
      expect(() => a.encryptMessage({ id: "bad-time", text: "x", sentAt })).toThrow(/plaintext/i);
    }
    harness.destroy();
  });
});

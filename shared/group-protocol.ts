export type GroupRoomState = "OPEN" | "DESTROYED";
export type GroupRoomPhase = "REKEYING" | "ACTIVE";

export interface GroupEpochDescriptor {
  epoch: number;
  epochNonce: string;
  rosterDigest: string;
  members: string[];
}

export interface GroupPersona {
  nickname: string;
  color: string;
}

export interface GroupMemberPersona extends GroupPersona {
  memberId: string;
}

export const GROUP_PERSONA_COLORS = [
  "#9C2A2A",
  "#7A4E00",
  "#0A6B4F",
  "#1C5D99",
  "#6240A0",
  "#A13A73",
  "#2A6F73",
  "#6B4F3A",
  "#465E15",
  "#8A3B12",
  "#315B7D",
  "#5A3F7A"
] as const;

export type GroupClientCommand =
  | {
      type: "group_join";
      inviteToken: string;
      browserVerifier: string;
      tabVerifier: string;
      ownerCapability?: string;
      ownerRecoverySecret?: string;
    }
  | {
      type: "group_resume";
      roomId: string;
      memberId: string;
      resumeToken: string;
      ownerCapability?: string;
    }
  | { type: "heartbeat" }
  | {
      type: "group_control";
      epoch: number;
      rosterDigest: string;
      to?: string;
      data: string;
    }
  | { type: "group_ready"; epoch: number; rosterDigest: string; epochDigest: string }
  | { type: "group_relay"; relayId: string; epoch: number; epochDigest: string; data: string }
  | { type: "group_destroy"; ownerCapability: string }
  | { type: "group_owner_destroy"; roomId: string; ownerCapability: string };

export type GroupProtocolErrorCode = "stale_epoch" | "rekeying" | "invalid_control";

export type GroupServerEvent =
  | ({
      type: "group_session";
      roomId: string;
      memberId: string;
      resumeToken: string;
      ownerAuthorized: boolean;
      ownerCapability?: string;
      state: "OPEN";
      phase: GroupRoomPhase;
      expiresAt: number;
      heartbeatEveryMs: number;
      disconnectGraceMs: number;
      maxParticipants: number;
      presenceCount: number;
      persona: GroupPersona;
      personaKind: "primary" | "ephemeral";
      personas: GroupMemberPersona[];
    } & GroupEpochDescriptor)
  | { type: "group_presence"; presenceCount: number }
  | ({ type: "group_epoch"; phase: "REKEYING"; personas: GroupMemberPersona[] } & GroupEpochDescriptor)
  | { type: "group_epoch_failed"; epoch: number; rosterDigest: string }
  | { type: "group_epoch_ready"; epoch: number; rosterDigest: string; epochDigest: string }
  | { type: "group_control"; epoch: number; rosterDigest: string; from: string; data: string }
  | { type: "group_relay"; epoch: number; epochDigest: string; from: string; data: string }
  | { type: "group_relay_accepted"; relayId: string }
  | { type: "group_relay_rejected"; relayId: string; reason: "rate_limited" | "unavailable" | "invalid" }
  | { type: "group_destroyed" }
  | { type: "group_room_gone"; message: string }
  | { type: "group_room_full"; maxParticipants: number }
  | { type: "group_browser_limit"; maxSessions: number }
  | { type: "group_rate_limited" }
  | { type: "group_forbidden" }
  | { type: "group_protocol_error"; code: GroupProtocolErrorCode };

export const GROUP_GONE_MESSAGE = "This room no longer exists.";

const textEncoder = new TextEncoder();

function lengthPrefixed(value: Uint8Array): Uint8Array {
  const output = new Uint8Array(4 + value.length);
  new DataView(output.buffer).setUint32(0, value.length, false);
  output.set(value, 4);
  return output;
}

function concat(values: readonly Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

export function encodeCanonicalGroupRoster(
  roomId: string,
  epoch: number,
  epochNonce: string,
  members: readonly string[]
): Uint8Array {
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new Error("Invalid group epoch");
  const epochBytes = new Uint8Array(8);
  new DataView(epochBytes.buffer).setBigUint64(0, BigInt(epoch), false);
  const count = new Uint8Array(4);
  new DataView(count.buffer).setUint32(0, members.length, false);
  return concat([
    lengthPrefixed(textEncoder.encode("410-group-roster-v1")),
    lengthPrefixed(textEncoder.encode(roomId)),
    epochBytes,
    lengthPrefixed(textEncoder.encode(epochNonce)),
    count,
    ...members.map((member) => lengthPrefixed(textEncoder.encode(member)))
  ]);
}

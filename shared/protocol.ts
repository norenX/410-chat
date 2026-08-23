export type RoomState = "CREATED" | "WAITING" | "ACTIVE" | "DESTROYED";
export type InviteState = "ACTIVE" | "CONSUMED";
export type Role = "creator" | "joiner";

export type ClientCommand =
  | { type: "resume"; roomId: string; resumeToken: string }
  | { type: "join"; inviteToken: string }
  | { type: "heartbeat" }
  | { type: "relay"; data: string }
  | { type: "destroy" };

export type ServerEvent =
  | {
      type: "session";
      roomId: string;
      role: Role;
      state: "WAITING" | "ACTIVE";
      inviteState: InviteState;
      resumeToken?: string;
      expiresAt: number;
      heartbeatEveryMs: number;
      disconnectGraceMs: number;
      peerConnected: boolean;
    }
  | { type: "peer_joined"; inviteState: "CONSUMED"; expiresAt: number }
  | { type: "peer_disconnected"; graceEndsAt: number }
  | { type: "peer_resumed" }
  | { type: "relay"; data: string }
  | { type: "destroyed" }
  | { type: "room_gone"; message: string }
  | { type: "rate_limited" };

export const GONE_MESSAGE = "This conversation no longer exists.";

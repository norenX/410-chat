export interface ChatConfig {
  host: string;
  port: number;
  metricsFile: string;
  trustProxy: boolean;
  hardTtlMs: number;
  disconnectGraceMs: number;
  heartbeatEveryMs: number;
  heartbeatStaleMs: number;
  authTimeoutMs: number;
  maxWsMessageBytes: number;
  maxRelayChars: number;
  maxRelaysPerWindow: number;
  relayWindowMs: number;
  maxCreatesPerWindow: number;
  createWindowMs: number;
  maxConnectionsPerWindow: number;
  connectionWindowMs: number;
  allowedOrigins: string[];
  groupRoomsEnabled: boolean;
  groupHardTtlMs: number;
  groupRekeyTimeoutMs: number;
  maxGroupRooms: number;
  maxGroupEmptyRooms: number;
  maxGroupWsMessageBytes: number;
  maxGroupRelayChars: number;
  maxGroupRelaysPerWindow: number;
  groupRelayWindowMs: number;
  maxGroupInboundFramesPerWindow: number;
  maxGroupInboundBytesPerWindow: number;
  groupInboundWindowMs: number;
  maxGroupBufferedAmount: number;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boolean(value: string | undefined, fallback = false): boolean {
  if (value === undefined) return fallback;
  return value.trim().toLowerCase() === "true";
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  return {
    host: env.HOST || "0.0.0.0",
    port: positiveInteger(env.PORT, 8080),
    metricsFile: env.METRICS_FILE || "/data/metrics.json",
    trustProxy: boolean(env.TRUST_PROXY),
    hardTtlMs: positiveInteger(env.HARD_TTL_MS, 30 * 60 * 1000),
    disconnectGraceMs: positiveInteger(env.DISCONNECT_GRACE_MS, 15 * 1000),
    heartbeatEveryMs: positiveInteger(env.HEARTBEAT_EVERY_MS, 5 * 1000),
    heartbeatStaleMs: positiveInteger(env.HEARTBEAT_STALE_MS, 12 * 1000),
    authTimeoutMs: positiveInteger(env.AUTH_TIMEOUT_MS, 5 * 1000),
    maxWsMessageBytes: positiveInteger(env.MAX_WS_MESSAGE_BYTES, 32 * 1024),
    maxRelayChars: positiveInteger(env.MAX_RELAY_CHARS, 24 * 1024),
    maxRelaysPerWindow: positiveInteger(env.MAX_RELAYS_PER_WINDOW, 30),
    relayWindowMs: positiveInteger(env.RELAY_WINDOW_MS, 10 * 1000),
    maxCreatesPerWindow: positiveInteger(env.MAX_CREATES_PER_WINDOW, 10),
    createWindowMs: positiveInteger(env.CREATE_WINDOW_MS, 60 * 60 * 1000),
    maxConnectionsPerWindow: positiveInteger(env.MAX_CONNECTIONS_PER_WINDOW, 60),
    connectionWindowMs: positiveInteger(env.CONNECTION_WINDOW_MS, 60 * 1000),
    allowedOrigins: (env.ALLOWED_ORIGINS || "")
      .split(",")
      .map((origin) => origin.trim())
      .filter(Boolean),
    groupRoomsEnabled: boolean(env.GROUP_ROOMS_ENABLED),
    groupHardTtlMs: positiveInteger(env.GROUP_HARD_TTL_MS, 24 * 60 * 60 * 1000),
    groupRekeyTimeoutMs: positiveInteger(env.GROUP_REKEY_TIMEOUT_MS, 15 * 1000),
    maxGroupRooms: positiveInteger(env.MAX_GROUP_ROOMS, 1000),
    maxGroupEmptyRooms: positiveInteger(env.MAX_GROUP_EMPTY_ROOMS, 250),
    maxGroupWsMessageBytes: positiveInteger(env.MAX_GROUP_WS_MESSAGE_BYTES, 32 * 1024),
    maxGroupRelayChars: positiveInteger(env.MAX_GROUP_RELAY_CHARS, 24 * 1024),
    maxGroupRelaysPerWindow: positiveInteger(env.MAX_GROUP_RELAYS_PER_WINDOW, 120),
    groupRelayWindowMs: positiveInteger(env.GROUP_RELAY_WINDOW_MS, 10 * 1000),
    maxGroupInboundFramesPerWindow: positiveInteger(env.MAX_GROUP_INBOUND_FRAMES_PER_WINDOW, 160),
    maxGroupInboundBytesPerWindow: positiveInteger(env.MAX_GROUP_INBOUND_BYTES_PER_WINDOW, 1024 * 1024),
    groupInboundWindowMs: positiveInteger(env.GROUP_INBOUND_WINDOW_MS, 10 * 1000),
    maxGroupBufferedAmount: positiveInteger(env.MAX_GROUP_BUFFERED_AMOUNT, 512 * 1024)
  };
}

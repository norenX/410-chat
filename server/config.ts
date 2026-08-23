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
}

function positiveInteger(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): ChatConfig {
  return {
    host: env.HOST || "0.0.0.0",
    port: positiveInteger(env.PORT, 8080),
    metricsFile: env.METRICS_FILE || "/data/metrics.json",
    trustProxy: env.TRUST_PROXY?.trim().toLowerCase() === "true",
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
      .filter(Boolean)
  };
}

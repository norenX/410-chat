import { createReadStream, promises as fs } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { WebSocketServer } from "ws";
import type { ViteDevServer } from "vite";
import { adminStatsSnapshot } from "./admin-stats.js";
import type { ChatConfig } from "./config.js";
import { MetricsStore, type MetricName } from "./metrics.js";
import { normalizeTrafficSource, trafficSourceFromPageRequest } from "./attribution.js";
import { SlidingWindowLimiter } from "./rate-limit.js";
import { RoomManager, type DestructionReason, type RoomManagerHooks } from "./room-manager.js";
import {
  GroupRoomManager,
  type GroupDestructionReason,
  type GroupRoomManagerHooks
} from "./group-room-manager.js";

export interface ChatServerOptions {
  config: ChatConfig;
  devAssets?: boolean;
  hooks?: RoomManagerHooks;
  groupHooks?: GroupRoomManagerHooks;
  metrics?: MetricsStore;
}

export interface ChatServer {
  manager: RoomManager;
  groupManager: GroupRoomManager;
  metrics: MetricsStore;
  listen(): Promise<{ host: string; port: number; url: string }>;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2"
};

const INVITE_PATH = /^\/r\/([A-Za-z0-9_-]{43})$/;
const GROUP_INVITE_PATH = /^\/g\/([A-Za-z0-9_-]{43})$/;
const GONE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>410 Gone</title>
</head>
<body>
  <h1>410 Gone</h1>
  <p>This conversation no longer exists.</p>
</body>
</html>`;

function clientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];

    if (typeof forwarded === "string") {
      const ip = forwarded.split(",")[0]?.trim();
      if (ip) return ip;
    }

    if (Array.isArray(forwarded)) {
      const ip = forwarded[0]?.split(",")[0]?.trim();
      if (ip) return ip;
    }
  }

  return request.socket.remoteAddress || "unknown";
}

function applySecurityHeaders(response: ServerResponse, path: string): void {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'; media-src 'none'; manifest-src 'self'"
  );
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  response.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  response.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), payment=(), usb=()");
  response.setHeader("Cache-Control", path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-store");
  if (path.startsWith("/admin/")) response.setHeader("X-Robots-Tag", "noindex, nofollow");
}

function json(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

function gone(response: ServerResponse, headOnly: boolean, onSent: () => void): void {
  response.once("finish", onSent);
  response.statusCode = 410;
  response.setHeader("Content-Type", "text/html; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Robots-Tag", "noindex, nofollow");
  response.setHeader("Content-Security-Policy", "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
  response.end(headOnly ? undefined : GONE_HTML);
}

function notFound(response: ServerResponse, headOnly: boolean): void {
  response.statusCode = 404;
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end(headOnly ? undefined : "Not found");
}

function isDevAsset(path: string): boolean {
  return path.startsWith("/src/") || path.startsWith("/@") || path.startsWith("/node_modules/");
}

function originAllowed(request: IncomingMessage, configuredOrigins: string[]): boolean {
  const origin = request.headers.origin;
  if (!origin) return true;
  if (configuredOrigins.includes(origin)) return true;
  const host = request.headers.host;
  return Boolean(host && (origin === `http://${host}` || origin === `https://${host}`));
}

async function drainSmallBody(request: IncomingMessage, maxBytes = 1024): Promise<boolean> {
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > maxBytes) return false;
  }
  return true;
}

async function readSmallJson(
  request: IncomingMessage,
  maxBytes = 1024
): Promise<{ value?: Record<string, unknown>; tooLarge: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.byteLength;
    if (size > maxBytes) return { tooLarge: true };
    chunks.push(buffer);
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? { value: parsed as Record<string, unknown>, tooLarge: false }
      : { tooLarge: false };
  } catch {
    return { tooLarge: false };
  }
}

export async function createChatServer(options: ChatServerOptions): Promise<ChatServer> {
  const { config } = options;
  const metrics = options.metrics ?? new MetricsStore(config.metricsFile);
  await metrics.init();
  const externalHooks = options.hooks;
  const destructionMetric: Partial<Record<DestructionReason, MetricName>> = {
    manual: "destroyed_manual",
    disconnect: "destroyed_disconnect",
    ttl: "destroyed_ttl"
  };
  const manager = new RoomManager(config, {
    onRelay: externalHooks?.onRelay,
    onTransition: externalHooks?.onTransition,
    onRoomCreated: (source) => {
      metrics.incrementAttributed("rooms_created", source);
      externalHooks?.onRoomCreated?.(source);
    },
    onConversationStarted: (source) => {
      metrics.incrementAttributed("conversations_started", source);
      externalHooks?.onConversationStarted?.(source);
    },
    onMessageRelayed: (source) => {
      metrics.incrementAttributed("messages_relayed", source);
      externalHooks?.onMessageRelayed?.(source);
    },
    onDestroyed: (reason) => {
      const name = destructionMetric[reason];
      if (name) metrics.increment(name);
      externalHooks?.onDestroyed?.(reason);
    }
  });
  const externalGroupHooks = options.groupHooks;
  const groupDestructionMetric: Partial<Record<GroupDestructionReason, "group_destroyed_manual" | "group_destroyed_ttl">> = {
    manual: "group_destroyed_manual",
    ttl: "group_destroyed_ttl"
  };
  const groupManager = new GroupRoomManager({
    hardTtlMs: config.groupHardTtlMs,
    rekeyTimeoutMs: config.groupRekeyTimeoutMs,
    disconnectGraceMs: config.disconnectGraceMs,
    heartbeatEveryMs: config.heartbeatEveryMs,
    heartbeatStaleMs: config.heartbeatStaleMs,
    authTimeoutMs: config.authTimeoutMs,
    maxWsMessageBytes: config.maxGroupWsMessageBytes,
    maxRelayChars: config.maxGroupRelayChars,
    maxRelaysPerWindow: config.maxRelaysPerWindow,
    maxRoomRelaysPerWindow: config.maxGroupRelaysPerWindow,
    relayWindowMs: config.groupRelayWindowMs,
    maxInboundFramesPerWindow: config.maxGroupInboundFramesPerWindow,
    maxInboundBytesPerWindow: config.maxGroupInboundBytesPerWindow,
    inboundWindowMs: config.groupInboundWindowMs,
    maxBufferedAmount: config.maxGroupBufferedAmount,
    maxParticipants: 10,
    maxRooms: config.maxGroupRooms,
    maxEmptyRooms: config.maxGroupEmptyRooms
  }, {
    onRoomCreated: (source) => {
      metrics.incrementGroup("group_rooms_created");
      externalGroupHooks?.onRoomCreated?.(source);
    },
    onParticipantJoined: (source) => {
      metrics.incrementGroup("group_participants_joined");
      externalGroupHooks?.onParticipantJoined?.(source);
    },
    onConversationStarted: (source) => {
      metrics.incrementGroup("group_conversations_started");
      externalGroupHooks?.onConversationStarted?.(source);
    },
    onMessageRelayed: (source) => {
      metrics.incrementGroup("group_messages_relayed");
      externalGroupHooks?.onMessageRelayed?.(source);
    },
    onDestroyed: (reason) => {
      const name = groupDestructionMetric[reason];
      if (name) metrics.incrementGroup(name);
      externalGroupHooks?.onDestroyed?.(reason);
    },
    onEpochChanged: externalGroupHooks?.onEpochChanged
  });
  const createLimiter = new SlidingWindowLimiter(config.maxCreatesPerWindow, config.createWindowMs);
  const connectionLimiter = new SlidingWindowLimiter(config.maxConnectionsPerWindow, config.connectionWindowMs);
  const distRoot = join(process.cwd(), "dist-client");
  let vite: ViteDevServer | undefined;

  function currentMetricsSnapshot() {
    const groupCounts = groupManager.currentCounts();
    return metrics.snapshot(
      manager.currentCounts(),
      Date.now(),
      { rooms: groupCounts.rooms, participants: groupCounts.participants }
    );
  }

  const server = createServer(async (request, response) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    applySecurityHeaders(response, url.pathname);

    if (request.method === "GET" && url.pathname === "/") {
      const source = trafficSourceFromPageRequest(url, request.headers.referer);
      response.once("finish", () => {
        if (response.statusCode === 200) metrics.incrementAttributed("homepage_views", source);
      });
    }

    if (request.method === "GET" && url.pathname === "/healthz") {
      json(response, 200, { status: "ok" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/features") {
      json(response, 200, { groupRooms: config.groupRoomsEnabled });
      return;
    }

    if (request.method === "GET" && url.pathname === "/__stats") {
      json(response, 200, currentMetricsSnapshot());
      return;
    }

    if (request.method === "GET" && url.pathname === "/admin/api/stats") {
      json(response, 200, adminStatsSnapshot(currentMetricsSnapshot()));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/rooms") {
      if (!originAllowed(request, config.allowedOrigins)) {
        json(response, 403, { error: "request_rejected" });
        return;
      }
      if (!createLimiter.take(clientIp(request, config.trustProxy))) {
        response.setHeader("Retry-After", String(Math.ceil(config.createWindowMs / 1000)));
        json(response, 429, { error: "rate_limited" });
        return;
      }
      if (!(await drainSmallBody(request))) {
        json(response, 413, { error: "request_too_large" });
        return;
      }
      const source = normalizeTrafficSource(request.headers["x-410-source"]);
      json(response, 201, manager.createRoom(Date.now(), source));
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/group-rooms" && config.groupRoomsEnabled) {
      if (!originAllowed(request, config.allowedOrigins)) {
        json(response, 403, { error: "request_rejected" });
        return;
      }
      if (!createLimiter.take(clientIp(request, config.trustProxy))) {
        response.setHeader("Retry-After", String(Math.ceil(config.createWindowMs / 1000)));
        json(response, 429, { error: "rate_limited" });
        return;
      }
      let parsed: Awaited<ReturnType<typeof readSmallJson>>;
      try {
        parsed = await readSmallJson(request);
      } catch {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      if (parsed.tooLarge) {
        json(response, 413, { error: "request_too_large" });
        return;
      }
      const ownerVerifier = parsed.value?.ownerVerifier;
      const ownerRecoveryVerifier = parsed.value?.ownerRecoveryVerifier;
      if (typeof ownerVerifier !== "string" || typeof ownerRecoveryVerifier !== "string") {
        json(response, 400, { error: "invalid_request" });
        return;
      }
      try {
        const source = normalizeTrafficSource(request.headers["x-410-source"]);
        const created = groupManager.createRoom(ownerVerifier, ownerRecoveryVerifier, Date.now(), source);
        if (!created) {
          json(response, 503, { error: "capacity_reached" });
          return;
        }
        json(response, 201, created);
      } catch {
        json(response, 400, { error: "invalid_request" });
      }
      return;
    }

    if (url.pathname.startsWith("/api/")) {
      json(response, 404, { error: "not_found" });
      return;
    }

    const inviteMatch = url.pathname.match(INVITE_PATH);
    const groupInviteMatch = url.pathname.match(GROUP_INVITE_PATH);
    const isRoomPath = url.pathname === "/r" || url.pathname.startsWith("/r/");
    const isGroupRoomPath = url.pathname === "/g" || url.pathname.startsWith("/g/");
    const isDocumentRequest = request.method === "GET" || request.method === "HEAD";
    if (isDocumentRequest && isRoomPath && (!inviteMatch || !manager.hasActiveInvite(inviteMatch[1]))) {
      gone(response, request.method === "HEAD", () => metrics.increment("responses_410"));
      return;
    }
    if (
      isDocumentRequest && isGroupRoomPath &&
      (!config.groupRoomsEnabled || !groupInviteMatch || !groupManager.hasActiveInvite(groupInviteMatch[1]))
    ) {
      gone(response, request.method === "HEAD", () => metrics.incrementGroup("group_responses_410"));
      return;
    }
    const servesApp = url.pathname === "/" || url.pathname === "/security" ||
      url.pathname === "/admin/stats" ||
      Boolean(inviteMatch) || Boolean(groupInviteMatch);

    if (vite) {
      if (!servesApp && !isDevAsset(url.pathname)) {
        notFound(response, request.method === "HEAD");
        return;
      }
      vite.middlewares(request, response, () => {
        if (!response.writableEnded) {
          notFound(response, request.method === "HEAD");
        }
      });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      response.statusCode = 405;
      response.end("Method not allowed");
      return;
    }

    const requested = servesApp ? "/index.html" : url.pathname;
    const normalized = normalize(requested).replace(/^(\.\.[/\\])+/, "");
    const filePath = join(distRoot, normalized);
    if (!filePath.startsWith(distRoot)) {
      response.statusCode = 404;
      response.end("Not found");
      return;
    }
    try {
      const stat = await fs.stat(filePath);
      if (!stat.isFile()) throw new Error("not a file");
    } catch {
      notFound(response, request.method === "HEAD");
      return;
    }
    response.setHeader("Content-Type", MIME[extname(filePath)] || "application/octet-stream");
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    createReadStream(filePath).on("error", () => {
      if (!response.headersSent) response.statusCode = 404;
      response.end("Not found");
    }).pipe(response);
  });

  if (options.devAssets) {
    const { createServer: createViteServer } = await import("vite");
    vite = await createViteServer({
      configFile: join(process.cwd(), "vite.config.ts"),
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa"
    });
  }

  const sockets = new WebSocketServer({ noServer: true, maxPayload: config.maxWsMessageBytes, perMessageDeflate: false });
  sockets.on("connection", (socket) => manager.acceptSocket(socket));
  const groupSockets = new WebSocketServer({
    noServer: true,
    maxPayload: config.maxGroupWsMessageBytes,
    perMessageDeflate: false
  });
  groupSockets.on("connection", (socket) => groupManager.acceptSocket(socket));
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", `http://${request.headers.host || "localhost"}`);
    if (url.pathname !== "/ws" && url.pathname !== "/group-ws") return;
    if (url.pathname === "/group-ws" && !config.groupRoomsEnabled) {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!originAllowed(request, config.allowedOrigins) || !connectionLimiter.take(clientIp(request, config.trustProxy))) {
      socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    const target = url.pathname === "/group-ws" ? groupSockets : sockets;
    target.handleUpgrade(request, socket, head, (webSocket) => target.emit("connection", webSocket, request));
  });

  const pruneTimer = setInterval(() => {
    createLimiter.prune();
    connectionLimiter.prune();
  }, 60_000);
  pruneTimer.unref();

  return {
    manager,
    groupManager,
    metrics,
    listen: () => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(config.port, config.host, () => {
        server.off("error", reject);
        const address = server.address();
        const port = typeof address === "object" && address ? address.port : config.port;
        resolve({ host: config.host, port, url: `http://${config.host}:${port}` });
      });
    }),
    close: async () => {
      try {
        clearInterval(pruneTimer);
        manager.shutdown();
        groupManager.shutdown();
        for (const socket of sockets.clients) socket.terminate();
        for (const socket of groupSockets.clients) socket.terminate();
        await new Promise<void>((resolve) => sockets.close(() => resolve()));
        await new Promise<void>((resolve) => groupSockets.close(() => resolve()));
        await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
        await vite?.close();
      } finally {
        await metrics.close();
      }
    }
  };
}

import WebSocket from "ws";
import type { ServerEvent } from "../shared/protocol.js";
import { CryptoSession, sodiumReady, type DecryptedMessage } from "../client/src/crypto-session.js";

export class EventQueue {
  private events: ServerEvent[] = [];
  private waiters: Array<{
    predicate: (event: ServerEvent) => boolean;
    resolve: (event: ServerEvent) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  push(event: ServerEvent): void {
    const index = this.waiters.findIndex((waiter) => waiter.predicate(event));
    if (index >= 0) {
      const [waiter] = this.waiters.splice(index, 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.events.push(event);
  }

  waitFor<T extends ServerEvent["type"]>(type: T, timeoutMs = 3000): Promise<Extract<ServerEvent, { type: T }>> {
    const existing = this.events.findIndex((event) => event.type === type);
    if (existing >= 0) return Promise.resolve(this.events.splice(existing, 1)[0] as Extract<ServerEvent, { type: T }>);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), timeoutMs);
      this.waiters.push({
        predicate: (event) => event.type === type,
        resolve: (event) => resolve(event as Extract<ServerEvent, { type: T }>),
        reject,
        timer
      });
    });
  }
}

export class WsClient {
  readonly events = new EventQueue();
  readonly messages: DecryptedMessage[] = [];
  readonly socket: WebSocket;
  crypto?: CryptoSession;
  fingerprint = "";
  private establishedResolve?: () => void;
  private establishedReject?: (error: Error) => void;
  established: Promise<void> = Promise.resolve();

  private constructor(socket: WebSocket) {
    this.socket = socket;
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString()) as ServerEvent;
      if (event.type === "relay" && this.crypto) this.crypto.handleRelay(event.data);
      this.events.push(event);
    });
  }

  static async connect(url: string, auth: object): Promise<WsClient> {
    const socket = new WebSocket(url, { origin: url.replace(/^ws/, "http").replace(/\/ws$/, "") });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const client = new WsClient(socket);
    socket.send(JSON.stringify(auth));
    return client;
  }

  async setupCrypto(role: "creator" | "joiner", roomId: string, linkSecret: string): Promise<void> {
    await sodiumReady();
    this.established = new Promise<void>((resolve, reject) => {
      this.establishedResolve = resolve;
      this.establishedReject = reject;
    });
    this.crypto = new CryptoSession(role, roomId, linkSecret, {
      sendRelay: (data) => this.socket.send(JSON.stringify({ type: "relay", data })),
      onEstablished: (fingerprint) => {
        this.fingerprint = fingerprint;
        this.establishedResolve?.();
      },
      onMessage: (message) => this.messages.push(message),
      onFatal: () => this.establishedReject?.(new Error("cryptographic protocol failed"))
    });
  }

  sendEncrypted(message: DecryptedMessage): void {
    if (!this.crypto) throw new Error("crypto not initialized");
    this.socket.send(JSON.stringify({ type: "relay", data: this.crypto.encryptMessage(message) }));
  }

  close(): void {
    this.socket.close();
  }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

import sodium from "libsodium-wrappers";
import type { Role } from "../../shared/protocol.js";

type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

type HandshakePacket =
  | { v: 1; kind: "offer"; id: string; publicKey: string; tag: string }
  | { v: 1; kind: "answer"; id: string; publicKey: string; tag: string }
  | { v: 1; kind: "confirm"; id: string; role: Role; tag: string }
  | { v: 1; kind: "ciphertext"; id: string; sequence: number; nonce: string; ciphertext: string };

export interface DecryptedMessage {
  id: string;
  text: string;
  sentAt: number;
}

export interface CryptoSessionCallbacks {
  sendRelay(data: string): void;
  onEstablished(fingerprint: string): void;
  onMessage(message: DecryptedMessage): void;
  onFatal(): void;
}

const WORDS = [
  "AMBER", "ASH", "BAY", "BIRCH", "BLOOM", "CEDAR", "CINDER", "CLOUD",
  "CORAL", "COVE", "DAWN", "DEW", "DUNE", "EMBER", "FERN", "FIELD",
  "FLINT", "FOG", "FOREST", "FROST", "GLOW", "GROVE", "HARBOR", "HAZE",
  "HEATH", "IRIS", "JADE", "LAKE", "LEAF", "LIGHT", "LILAC", "LOAM",
  "MAPLE", "MARSH", "MEADOW", "MIST", "MOON", "MOSS", "NORTH", "OAK",
  "OCEAN", "ORBIT", "PINE", "POND", "RAIN", "REED", "RIDGE", "RIVER",
  "ROSE", "SAGE", "SAND", "SHORE", "SKY", "SNOW", "SOLAR", "STONE",
  "TIDE", "TIMBER", "VALE", "WAVE", "WEST", "WILLOW", "WIND", "WREN"
] as const;

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

function b64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function fromB64(value: string): Uint8Array {
  return sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function encodePacket(packet: HandshakePacket): string {
  return b64(textEncoder.encode(JSON.stringify(packet)));
}

function decodePacket(data: string): HandshakePacket {
  return JSON.parse(textDecoder.decode(fromB64(data))) as HandshakePacket;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const size = values.reduce((sum, value) => sum + value.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function canonicalOffer(roomId: string, handshakeId: string, creatorPublic: string): string {
  return `burnroom-v1|offer|${roomId}|${handshakeId}|${creatorPublic}`;
}

function canonicalAnswer(roomId: string, handshakeId: string, creatorPublic: string, joinerPublic: string): string {
  return `burnroom-v1|answer|${roomId}|${handshakeId}|${creatorPublic}|${joinerPublic}`;
}

export async function sodiumReady(): Promise<void> {
  await sodium.ready;
}

export function createLinkSecret(): string {
  return b64(sodium.randombytes_buf(32));
}

export class CryptoSession {
  private keyPair?: KeyPair;
  private handshakeId = "";
  private creatorPublic = "";
  private joinerPublic = "";
  private sendKey?: Uint8Array;
  private receiveKey?: Uint8Array;
  private confirmKey?: Uint8Array;
  private established = false;
  private sendSequence = 0;
  private receiveSequence = 0;
  private readonly linkSecret: Uint8Array;

  constructor(
    private readonly role: Role,
    private readonly roomId: string,
    linkSecret: string,
    private readonly callbacks: CryptoSessionCallbacks
  ) {
    this.linkSecret = fromB64(linkSecret);
    if (this.linkSecret.length !== 32) throw new Error("Invalid link secret");
  }

  reset(): void {
    this.eraseKeys();
    this.keyPair = undefined;
    this.handshakeId = "";
    this.creatorPublic = "";
    this.joinerPublic = "";
    this.established = false;
    this.sendSequence = 0;
    this.receiveSequence = 0;
  }

  startAsCreator(): void {
    if (this.role !== "creator") return;
    this.reset();
    this.keyPair = sodium.crypto_kx_keypair();
    this.handshakeId = b64(sodium.randombytes_buf(12));
    this.creatorPublic = b64(this.keyPair.publicKey);
    const message = canonicalOffer(this.roomId, this.handshakeId, this.creatorPublic);
    const tag = b64(sodium.crypto_auth(message, this.linkSecret));
    this.callbacks.sendRelay(encodePacket({
      v: 1,
      kind: "offer",
      id: this.handshakeId,
      publicKey: this.creatorPublic,
      tag
    }));
  }

  handleRelay(data: string): void {
    try {
      const packet = decodePacket(data);
      if (!packet || packet.v !== 1) throw new Error("Invalid protocol version");
      if (packet.kind === "offer") this.handleOffer(packet);
      else if (packet.kind === "answer") this.handleAnswer(packet);
      else if (packet.kind === "confirm") this.handleConfirm(packet);
      else if (packet.kind === "ciphertext") this.handleCiphertext(packet);
      else throw new Error("Unknown packet");
    } catch {
      this.callbacks.onFatal();
    }
  }

  encryptMessage(message: DecryptedMessage): string {
    if (!this.established || !this.sendKey || !this.handshakeId) throw new Error("Secure session is not ready");
    const sequence = ++this.sendSequence;
    const nonce = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
    const additionalData = this.additionalData(this.role, sequence);
    const plaintext = textEncoder.encode(JSON.stringify(message));
    const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
      plaintext,
      additionalData,
      null,
      nonce,
      this.sendKey
    );
    return encodePacket({
      v: 1,
      kind: "ciphertext",
      id: this.handshakeId,
      sequence,
      nonce: b64(nonce),
      ciphertext: b64(ciphertext)
    });
  }

  destroy(): void {
    this.eraseKeys();
    sodium.memzero(this.linkSecret);
    this.reset();
  }

  private handleOffer(packet: Extract<HandshakePacket, { kind: "offer" }>): void {
    if (this.role !== "joiner" || !packet.id || !packet.publicKey || !packet.tag) throw new Error("Unexpected offer");
    const creatorPublic = fromB64(packet.publicKey);
    if (creatorPublic.length !== sodium.crypto_kx_PUBLICKEYBYTES) throw new Error("Invalid key");
    const message = canonicalOffer(this.roomId, packet.id, packet.publicKey);
    if (!sodium.crypto_auth_verify(fromB64(packet.tag), message, this.linkSecret)) throw new Error("Unauthenticated offer");
    this.reset();
    this.handshakeId = packet.id;
    this.creatorPublic = packet.publicKey;
    this.keyPair = sodium.crypto_kx_keypair();
    this.joinerPublic = b64(this.keyPair.publicKey);
    const answer = canonicalAnswer(this.roomId, this.handshakeId, this.creatorPublic, this.joinerPublic);
    const tag = b64(sodium.crypto_auth(answer, this.linkSecret));
    this.deriveKeys(creatorPublic, this.keyPair.publicKey);
    this.callbacks.sendRelay(encodePacket({
      v: 1,
      kind: "answer",
      id: this.handshakeId,
      publicKey: this.joinerPublic,
      tag
    }));
  }

  private handleAnswer(packet: Extract<HandshakePacket, { kind: "answer" }>): void {
    if (this.role !== "creator" || !this.keyPair || packet.id !== this.handshakeId) throw new Error("Unexpected answer");
    const joinerPublic = fromB64(packet.publicKey);
    if (joinerPublic.length !== sodium.crypto_kx_PUBLICKEYBYTES) throw new Error("Invalid key");
    const answer = canonicalAnswer(this.roomId, this.handshakeId, this.creatorPublic, packet.publicKey);
    if (!sodium.crypto_auth_verify(fromB64(packet.tag), answer, this.linkSecret)) throw new Error("Unauthenticated answer");
    this.joinerPublic = packet.publicKey;
    this.deriveKeys(this.keyPair.publicKey, joinerPublic);
    this.sendConfirmation("creator");
  }

  private handleConfirm(packet: Extract<HandshakePacket, { kind: "confirm" }>): void {
    if (!this.confirmKey || packet.id !== this.handshakeId || packet.role === this.role) throw new Error("Unexpected confirmation");
    const message = `burnroom-v1|confirm|${packet.role}|${this.transcript()}`;
    if (!sodium.crypto_auth_verify(fromB64(packet.tag), message, this.confirmKey)) throw new Error("Key confirmation failed");
    if (this.role === "joiner") this.sendConfirmation("joiner");
    this.established = true;
    this.callbacks.onEstablished(this.fingerprint());
  }

  private handleCiphertext(packet: Extract<HandshakePacket, { kind: "ciphertext" }>): void {
    if (!this.established || !this.receiveKey || packet.id !== this.handshakeId) throw new Error("Ciphertext before handshake");
    if (!Number.isSafeInteger(packet.sequence) || packet.sequence !== this.receiveSequence + 1) throw new Error("Replay or reordered message");
    const senderRole: Role = this.role === "creator" ? "joiner" : "creator";
    const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
      null,
      fromB64(packet.ciphertext),
      this.additionalData(senderRole, packet.sequence),
      fromB64(packet.nonce),
      this.receiveKey
    );
    const value = JSON.parse(textDecoder.decode(plaintext)) as Record<string, unknown>;
    if (
      typeof value.id !== "string" || value.id.length > 80 ||
      typeof value.text !== "string" || value.text.length < 1 || value.text.length > 2000 ||
      typeof value.sentAt !== "number" || !Number.isFinite(value.sentAt)
    ) throw new Error("Invalid plaintext envelope");
    this.receiveSequence = packet.sequence;
    this.callbacks.onMessage({ id: value.id, text: value.text, sentAt: value.sentAt });
  }

  private deriveKeys(creatorPublic: Uint8Array, joinerPublic: Uint8Array): void {
    if (!this.keyPair) throw new Error("Missing local keypair");
    const keys = this.role === "creator"
      ? sodium.crypto_kx_server_session_keys(this.keyPair.publicKey, this.keyPair.privateKey, joinerPublic)
      : sodium.crypto_kx_client_session_keys(this.keyPair.publicKey, this.keyPair.privateKey, creatorPublic);
    this.receiveKey = keys.sharedRx;
    this.sendKey = keys.sharedTx;
    const creatorToJoiner = this.role === "creator" ? keys.sharedTx : keys.sharedRx;
    const joinerToCreator = this.role === "creator" ? keys.sharedRx : keys.sharedTx;
    this.confirmKey = sodium.crypto_generichash(
      32,
      concat(creatorToJoiner, joinerToCreator, textEncoder.encode(this.transcript())),
      this.linkSecret
    );
    sodium.memzero(this.keyPair.privateKey);
  }

  private sendConfirmation(role: Role): void {
    if (!this.confirmKey) throw new Error("Missing confirmation key");
    const tag = b64(sodium.crypto_auth(`burnroom-v1|confirm|${role}|${this.transcript()}`, this.confirmKey));
    this.callbacks.sendRelay(encodePacket({ v: 1, kind: "confirm", id: this.handshakeId, role, tag }));
  }

  private transcript(): string {
    return `${this.roomId}|${this.handshakeId}|${this.creatorPublic}|${this.joinerPublic}`;
  }

  private additionalData(senderRole: Role, sequence: number): Uint8Array {
    return textEncoder.encode(`burnroom-message-v1|${this.roomId}|${this.handshakeId}|${senderRole}|${sequence}`);
  }

  private fingerprint(): string {
    if (!this.confirmKey) throw new Error("Missing fingerprint context");
    const digest = sodium.crypto_generichash(16, textEncoder.encode("burnroom-fingerprint-v1"), this.confirmKey);
    const number = (((digest[1] << 8) | digest[2]) % 100).toString().padStart(2, "0");
    return `${WORDS[digest[0] % WORDS.length]} — ${number} — ${WORDS[digest[3] % WORDS.length]}`;
  }

  private eraseKeys(): void {
    for (const key of [this.sendKey, this.receiveKey, this.confirmKey, this.keyPair?.privateKey]) {
      if (key) sodium.memzero(key);
    }
    this.sendKey = undefined;
    this.receiveKey = undefined;
    this.confirmKey = undefined;
  }
}

import sodium from "libsodium-wrappers";
import { encodeCanonicalGroupRoster, type GroupEpochDescriptor } from "../../shared/group-protocol.js";

const PROTOCOL_VERSION = 1;
const PROTOCOL_LABEL = "410-group-e2ee-v1";
const MAX_MEMBERS = 10;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const B64_PATTERN = /^[A-Za-z0-9_-]+$/;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder("utf-8", { fatal: true });

type KeyPair = { publicKey: Uint8Array; privateKey: Uint8Array };

interface KeyAnnouncementPacket {
  v: 1;
  kind: "key_announcement";
  publicKey: string;
  authTag: string;
}

interface KeyConfirmationPacket {
  v: 1;
  kind: "key_confirmation";
  epochDigest: string;
  tag: string;
}

type GroupControlPacket = KeyAnnouncementPacket | KeyConfirmationPacket;

interface WrappedContentKey {
  recipientMemberId: string;
  sequence: number;
  nonce: string;
  ciphertext: string;
}

interface GroupCiphertextPacket {
  v: 1;
  kind: "group_ciphertext";
  contentId: string;
  contentNonce: string;
  contentCiphertext: string;
  contentDigest: string;
  wraps: WrappedContentKey[];
}

export interface GroupDecryptedMessage {
  id: string;
  text: string;
  sentAt: number;
}

export interface GroupOutboundControl {
  epoch: number;
  rosterDigest: string;
  to?: string;
  data: string;
}

export interface GroupOutboundReady {
  epoch: number;
  rosterDigest: string;
  epochDigest: string;
}

export interface GroupInboundControl {
  epoch: number;
  rosterDigest: string;
  from: string;
  data: string;
}

export interface GroupEpochReady {
  epoch: number;
  rosterDigest: string;
  epochDigest: string;
}

export interface GroupEncryptedApplication {
  epoch: number;
  epochDigest: string;
  data: string;
}

export interface GroupInboundApplication extends GroupEncryptedApplication {
  from: string;
}

export type GroupCryptoState = "IDLE" | "REKEYING" | "ACTIVE" | "DESTROYED";

export interface GroupCryptoCallbacks {
  sendControl(command: GroupOutboundControl): void;
  sendReady(command: GroupOutboundReady): void;
  onActive(context: { epoch: number; epochDigest: string }): void;
  onMessage(message: GroupDecryptedMessage, senderMemberId: string): void;
}

export interface GroupCryptoSessionOptions {
  roomId: string;
  selfMemberId: string;
  linkSecret: string;
  callbacks: GroupCryptoCallbacks;
}

interface PairState {
  sendWrapKey: Uint8Array;
  receiveWrapKey: Uint8Array;
  confirmKey?: Uint8Array;
  sendSequence: number;
  receiveSequence: number;
}

interface EpochContext {
  descriptor: GroupEpochDescriptor;
  epochDigest: string;
  pairs: Map<string, PairState>;
}

interface PendingOutbound {
  epoch: number;
  sequences: Map<string, number>;
}

interface CandidateContext {
  descriptor: GroupEpochDescriptor;
  keyPair: KeyPair;
  announcements: Map<string, KeyAnnouncementPacket>;
  pairs: Map<string, PairState>;
  confirmations: Set<string>;
  epochDigest?: string;
  readySent: boolean;
}

export class GroupCryptoError extends Error {
  constructor(message: string, readonly recoverable = false) {
    super(message);
    this.name = "GroupCryptoError";
  }
}

export function isRecoverableGroupCryptoError(error: unknown): error is GroupCryptoError {
  return error instanceof GroupCryptoError && error.recoverable;
}

function concat(...values: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(values.reduce((total, value) => total + value.length, 0));
  let offset = 0;
  for (const value of values) {
    output.set(value, offset);
    offset += value.length;
  }
  return output;
}

function u32(value: number): Uint8Array {
  const output = new Uint8Array(4);
  new DataView(output.buffer).setUint32(0, value, false);
  return output;
}

function u64(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0) throw new GroupCryptoError("Invalid unsigned integer");
  const output = new Uint8Array(8);
  new DataView(output.buffer).setBigUint64(0, BigInt(value), false);
  return output;
}

function lp(value: string | Uint8Array): Uint8Array {
  const bytes = typeof value === "string" ? textEncoder.encode(value) : value;
  return concat(u32(bytes.length), bytes);
}

function transcript(domain: string, ...fields: Uint8Array[]): Uint8Array {
  return concat(lp(PROTOCOL_LABEL), u32(PROTOCOL_VERSION), lp(domain), ...fields);
}

function b64(bytes: Uint8Array): string {
  return sodium.to_base64(bytes, sodium.base64_variants.URLSAFE_NO_PADDING);
}

function fromB64(value: string, expectedLength?: number): Uint8Array {
  if (!B64_PATTERN.test(value)) throw new GroupCryptoError("Invalid base64url value");
  let bytes: Uint8Array;
  try {
    bytes = sodium.from_base64(value, sodium.base64_variants.URLSAFE_NO_PADDING);
  } catch {
    throw new GroupCryptoError("Invalid base64url value");
  }
  if (b64(bytes) !== value) throw new GroupCryptoError("Non-canonical base64url value");
  if (expectedLength !== undefined && bytes.length !== expectedLength) {
    throw new GroupCryptoError("Invalid encoded length");
  }
  return bytes;
}

function encodeWire(packet: GroupControlPacket | GroupCiphertextPacket): string {
  return b64(textEncoder.encode(JSON.stringify(packet)));
}

function decodeWire(data: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(textDecoder.decode(fromB64(data))) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof GroupCryptoError) throw error;
    throw new GroupCryptoError("Invalid group crypto packet");
  }
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

function parseControl(data: string): GroupControlPacket {
  const value = decodeWire(data);
  if (value.v !== 1) throw new GroupCryptoError("Unsupported group crypto version");
  if (
    hasExactKeys(value, ["v", "kind", "publicKey", "authTag"]) &&
    value.kind === "key_announcement" &&
    typeof value.publicKey === "string" &&
    typeof value.authTag === "string"
  ) return { v: 1, kind: "key_announcement", publicKey: value.publicKey, authTag: value.authTag };
  if (
    hasExactKeys(value, ["v", "kind", "epochDigest", "tag"]) &&
    value.kind === "key_confirmation" &&
    typeof value.epochDigest === "string" &&
    typeof value.tag === "string"
  ) return { v: 1, kind: "key_confirmation", epochDigest: value.epochDigest, tag: value.tag };
  throw new GroupCryptoError("Unknown group control packet");
}

function parseApplication(data: string): GroupCiphertextPacket {
  const value = decodeWire(data);
  if (
    !hasExactKeys(value, ["v", "kind", "contentId", "contentNonce", "contentCiphertext", "contentDigest", "wraps"]) ||
    value.v !== 1 || value.kind !== "group_ciphertext" ||
    typeof value.contentId !== "string" || typeof value.contentNonce !== "string" ||
    typeof value.contentCiphertext !== "string" || typeof value.contentDigest !== "string" ||
    !Array.isArray(value.wraps)
  ) throw new GroupCryptoError("Invalid group application packet");
  const wraps = value.wraps.map((item): WrappedContentKey => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new GroupCryptoError("Invalid key wrap");
    const wrap = item as Record<string, unknown>;
    if (
      !hasExactKeys(wrap, ["recipientMemberId", "sequence", "nonce", "ciphertext"]) ||
      typeof wrap.recipientMemberId !== "string" ||
      !Number.isSafeInteger(wrap.sequence) || (wrap.sequence as number) < 1 ||
      typeof wrap.nonce !== "string" || typeof wrap.ciphertext !== "string"
    ) throw new GroupCryptoError("Invalid key wrap");
    return {
      recipientMemberId: wrap.recipientMemberId,
      sequence: wrap.sequence as number,
      nonce: wrap.nonce,
      ciphertext: wrap.ciphertext
    };
  });
  return {
    v: 1,
    kind: "group_ciphertext",
    contentId: value.contentId,
    contentNonce: value.contentNonce,
    contentCiphertext: value.contentCiphertext,
    contentDigest: value.contentDigest,
    wraps
  };
}

function validateMemberId(value: string): void {
  if (!MEMBER_ID_PATTERN.test(value)) throw new GroupCryptoError("Invalid member id");
}

function normalizedDescriptor(roomId: string, value: GroupEpochDescriptor): GroupEpochDescriptor {
  if (!Number.isSafeInteger(value.epoch) || value.epoch < 1) throw new GroupCryptoError("Invalid epoch");
  fromB64(value.epochNonce, 32);
  fromB64(value.rosterDigest, 32);
  if (value.members.length < 1 || value.members.length > MAX_MEMBERS) throw new GroupCryptoError("Invalid roster size");
  value.members.forEach(validateMemberId);
  const sorted = [...value.members].sort();
  if (new Set(sorted).size !== sorted.length || sorted.some((member, index) => member !== value.members[index])) {
    throw new GroupCryptoError("Roster is not canonical");
  }
  return { epoch: value.epoch, epochNonce: value.epochNonce, rosterDigest: value.rosterDigest, members: sorted };
}

async function computeRosterDigest(roomId: string, descriptor: GroupEpochDescriptor): Promise<string> {
  const encoded = encodeCanonicalGroupRoster(roomId, descriptor.epoch, descriptor.epochNonce, descriptor.members);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded as BufferSource);
  return b64(new Uint8Array(digest));
}

function epochBase(roomId: string, descriptor: GroupEpochDescriptor): Uint8Array {
  return concat(
    lp(roomId),
    u64(descriptor.epoch),
    lp(descriptor.epochNonce),
    lp(descriptor.rosterDigest),
    u32(descriptor.members.length),
    ...descriptor.members.map(lp)
  );
}

function announcementTranscript(
  roomId: string,
  descriptor: GroupEpochDescriptor,
  memberId: string,
  publicKey: string
): Uint8Array {
  return transcript("key-announcement", epochBase(roomId, descriptor), lp(memberId), lp(publicKey));
}

function computeEpochDigest(
  roomId: string,
  descriptor: GroupEpochDescriptor,
  announcements: Map<string, KeyAnnouncementPacket>
): string {
  const fields: Uint8Array[] = [epochBase(roomId, descriptor), u32(descriptor.members.length)];
  for (const memberId of descriptor.members) {
    const announcement = announcements.get(memberId);
    if (!announcement) throw new GroupCryptoError("Incomplete key announcements");
    fields.push(lp(memberId), lp(announcement.publicKey), lp(announcement.authTag));
  }
  return b64(sodium.crypto_generichash(32, transcript("epoch-digest", ...fields)));
}

function pairContext(
  domain: string,
  roomId: string,
  descriptor: GroupEpochDescriptor,
  epochDigest: string,
  from: string,
  to: string
): Uint8Array {
  return transcript(domain, epochBase(roomId, descriptor), lp(epochDigest), lp(from), lp(to));
}

function confirmationTranscript(
  roomId: string,
  descriptor: GroupEpochDescriptor,
  epochDigest: string,
  from: string,
  to: string
): Uint8Array {
  return pairContext("key-confirmation", roomId, descriptor, epochDigest, from, to);
}

function contentAad(
  roomId: string,
  context: EpochContext,
  senderMemberId: string,
  contentId: string
): Uint8Array {
  return transcript(
    "content-aead",
    epochBase(roomId, context.descriptor),
    lp(context.epochDigest),
    lp(senderMemberId),
    lp(contentId)
  );
}

function contentDigestTranscript(
  roomId: string,
  context: EpochContext,
  senderMemberId: string,
  contentId: string,
  contentNonce: string,
  contentCiphertext: string
): Uint8Array {
  return transcript(
    "content-digest",
    epochBase(roomId, context.descriptor),
    lp(context.epochDigest),
    lp(senderMemberId),
    lp(contentId),
    lp(contentNonce),
    lp(contentCiphertext)
  );
}

function wrapAad(
  roomId: string,
  context: EpochContext,
  senderMemberId: string,
  recipientMemberId: string,
  sequence: number,
  contentDigest: string
): Uint8Array {
  return transcript(
    "content-key-wrap",
    epochBase(roomId, context.descriptor),
    lp(context.epochDigest),
    lp(senderMemberId),
    lp(recipientMemberId),
    u64(sequence),
    lp(contentDigest)
  );
}

function safeZero(value: Uint8Array | undefined): void {
  if (value) sodium.memzero(value);
}

function zeroPairs(pairs: Map<string, PairState>): void {
  for (const pair of pairs.values()) {
    safeZero(pair.sendWrapKey);
    safeZero(pair.receiveWrapKey);
    safeZero(pair.confirmKey);
  }
  pairs.clear();
}

export async function groupSodiumReady(): Promise<void> {
  await sodium.ready;
}

export class GroupCryptoSession {
  private readonly roomId: string;
  private readonly selfMemberId: string;
  private readonly linkSecret: Uint8Array;
  private readonly callbacks: GroupCryptoCallbacks;
  private candidate?: CandidateContext;
  private active?: EpochContext;
  private pendingOutbound?: PendingOutbound;
  private lastEpoch = 0;
  private cryptoState: GroupCryptoState = "IDLE";

  constructor(options: GroupCryptoSessionOptions) {
    validateMemberId(options.selfMemberId);
    this.roomId = options.roomId;
    this.selfMemberId = options.selfMemberId;
    this.linkSecret = fromB64(options.linkSecret, sodium.crypto_auth_KEYBYTES);
    this.callbacks = options.callbacks;
  }

  get state(): GroupCryptoState {
    return this.cryptoState;
  }

  get epoch(): number {
    return this.active?.descriptor.epoch ?? this.candidate?.descriptor.epoch ?? 0;
  }

  get epochDigest(): string | undefined {
    return this.active?.epochDigest ?? this.candidate?.epochDigest;
  }

  async beginEpoch(rawDescriptor: GroupEpochDescriptor): Promise<void> {
    this.assertUsable();
    const descriptor = normalizedDescriptor(this.roomId, rawDescriptor);
    if (!descriptor.members.includes(this.selfMemberId)) throw new GroupCryptoError("Local member missing from roster");
    if (descriptor.epoch < this.lastEpoch) return;
    if (descriptor.epoch === this.lastEpoch) {
      const current = this.candidate?.descriptor ?? this.active?.descriptor;
      if (
        current && current.epochNonce === descriptor.epochNonce &&
        current.rosterDigest === descriptor.rosterDigest &&
        current.members.length === descriptor.members.length &&
        current.members.every((member, index) => member === descriptor.members[index])
      ) return;
      throw new GroupCryptoError("Conflicting epoch descriptor");
    }
    this.clearCandidate();
    this.clearActive();
    this.pendingOutbound = undefined;
    this.cryptoState = "REKEYING";
    const expectedRosterDigest = await computeRosterDigest(this.roomId, descriptor);
    if (!sodium.memcmp(fromB64(descriptor.rosterDigest, 32), fromB64(expectedRosterDigest, 32))) {
      throw new GroupCryptoError("Roster digest mismatch");
    }

    this.lastEpoch = descriptor.epoch;
    const keyPair = sodium.crypto_kx_keypair();
    const publicKey = b64(keyPair.publicKey);
    const authTag = b64(sodium.crypto_auth(
      announcementTranscript(this.roomId, descriptor, this.selfMemberId, publicKey),
      this.linkSecret
    ));
    const own: KeyAnnouncementPacket = { v: 1, kind: "key_announcement", publicKey, authTag };
    this.candidate = {
      descriptor,
      keyPair,
      announcements: new Map([[this.selfMemberId, own]]),
      pairs: new Map(),
      confirmations: new Set(),
      readySent: false
    };
    this.callbacks.sendControl({
      epoch: descriptor.epoch,
      rosterDigest: descriptor.rosterDigest,
      data: encodeWire(own)
    });
    if (descriptor.members.length === 1) this.finishAnnouncements();
  }

  handleControl(event: GroupInboundControl): void {
    try {
      this.assertUsable();
      const candidate = this.requireCandidate(event.epoch, event.rosterDigest);
      validateMemberId(event.from);
      if (!candidate.descriptor.members.includes(event.from)) throw new GroupCryptoError("Control sender is outside roster");
      const packet = parseControl(event.data);
      if (packet.kind === "key_announcement") {
        this.handleAnnouncement(candidate, event.from, packet);
        return;
      }
      this.handleConfirmation(candidate, event.from, packet);
    } catch (error) {
      if (error instanceof GroupCryptoError && this.cryptoState !== "DESTROYED") {
        throw new GroupCryptoError(error.message, true);
      }
      throw error;
    }
  }

  handleEpochReady(event: GroupEpochReady): void {
    this.assertUsable();
    if (
      this.active?.descriptor.epoch === event.epoch &&
      this.active.descriptor.rosterDigest === event.rosterDigest &&
      this.active.epochDigest === event.epochDigest
    ) return;
    if (
      !this.candidate || event.epoch !== this.candidate.descriptor.epoch ||
      event.rosterDigest !== this.candidate.descriptor.rosterDigest
    ) throw new GroupCryptoError("Stale epoch-ready event", true);
    const candidate = this.candidate;
    if (!candidate.readySent || !candidate.epochDigest) throw new GroupCryptoError("Local epoch is not ready");
    if (event.epochDigest !== candidate.epochDigest) throw new GroupCryptoError("Epoch digest mismatch", true);
    this.active = {
      descriptor: candidate.descriptor,
      epochDigest: candidate.epochDigest,
      pairs: candidate.pairs
    };
    safeZero(candidate.keyPair.privateKey);
    candidate.announcements.clear();
    candidate.confirmations.clear();
    this.candidate = undefined;
    this.cryptoState = "ACTIVE";
    this.callbacks.onActive({ epoch: event.epoch, epochDigest: event.epochDigest });
  }

  encryptMessage(message: GroupDecryptedMessage): GroupEncryptedApplication {
    const context = this.requireActive();
    if (this.pendingOutbound) throw new GroupCryptoError("An outbound message is awaiting relay acknowledgement");
    validatePlaintext(message);
    if (context.descriptor.members.length < 2) throw new GroupCryptoError("No recipients in active epoch");
    const contentKey = sodium.randombytes_buf(sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES);
    try {
      const contentId = b64(sodium.randombytes_buf(16));
      const contentAadBytes = contentAad(this.roomId, context, this.selfMemberId, contentId);
      const contentNonce = sodium.randombytes_buf(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
      );
      const contentCiphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
        textEncoder.encode(JSON.stringify(message)),
        contentAadBytes,
        null,
        contentNonce,
        contentKey
      );
      const encodedNonce = b64(contentNonce);
      const encodedCiphertext = b64(contentCiphertext);
      const contentDigest = b64(sodium.crypto_generichash(32, contentDigestTranscript(
        this.roomId,
        context,
        this.selfMemberId,
        contentId,
        encodedNonce,
        encodedCiphertext
      )));
      const wraps: WrappedContentKey[] = [];
      const sequences = new Map<string, number>();
      for (const recipientMemberId of context.descriptor.members) {
        if (recipientMemberId === this.selfMemberId) continue;
        const pair = context.pairs.get(recipientMemberId);
        if (!pair) throw new GroupCryptoError("Missing recipient pair state");
        const sequence = pair.sendSequence + 1;
        const aad = wrapAad(
          this.roomId,
          context,
          this.selfMemberId,
          recipientMemberId,
          sequence,
          contentDigest
        );
        const nonce = sodium.crypto_generichash(
          sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
          transcript("wrap-nonce", aad),
          pair.sendWrapKey
        );
        const ciphertext = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(
          contentKey,
          aad,
          null,
          nonce,
          pair.sendWrapKey
        );
        sequences.set(recipientMemberId, sequence);
        wraps.push({
          recipientMemberId,
          sequence,
          nonce: b64(nonce),
          ciphertext: b64(ciphertext)
        });
      }
      const packet: GroupCiphertextPacket = {
        v: 1,
        kind: "group_ciphertext",
        contentId,
        contentNonce: encodedNonce,
        contentCiphertext: encodedCiphertext,
        contentDigest,
        wraps
      };
      this.pendingOutbound = { epoch: context.descriptor.epoch, sequences };
      return { epoch: context.descriptor.epoch, epochDigest: context.epochDigest, data: encodeWire(packet) };
    } finally {
      sodium.memzero(contentKey);
    }
  }

  commitOutbound(): void {
    const context = this.requireActive();
    const pending = this.pendingOutbound;
    if (!pending || pending.epoch !== context.descriptor.epoch) {
      throw new GroupCryptoError("No matching outbound message is pending");
    }
    for (const [memberId, sequence] of pending.sequences) {
      const pair = context.pairs.get(memberId);
      if (!pair || sequence !== pair.sendSequence + 1) {
        throw new GroupCryptoError("Outbound sequence state changed");
      }
    }
    for (const [memberId, sequence] of pending.sequences) context.pairs.get(memberId)!.sendSequence = sequence;
    this.pendingOutbound = undefined;
  }

  rejectOutbound(): void {
    this.pendingOutbound = undefined;
  }

  handleApplication(event: GroupInboundApplication): void {
    try {
      const context = this.requireActive();
      validateMemberId(event.from);
      if (
        event.from === this.selfMemberId || !context.descriptor.members.includes(event.from) ||
        event.epoch !== context.descriptor.epoch || event.epochDigest !== context.epochDigest
      ) throw new GroupCryptoError("Stale or invalid application epoch");
      const packet = parseApplication(event.data);
      const expectedRecipients = context.descriptor.members.filter((member) => member !== event.from);
      if (
        packet.wraps.length !== expectedRecipients.length ||
        packet.wraps.some((wrap, index) => wrap.recipientMemberId !== expectedRecipients[index])
      ) throw new GroupCryptoError("Application recipient set mismatch");
      fromB64(packet.contentId, 16);
      fromB64(packet.contentNonce, sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES);
      fromB64(packet.contentDigest, 32);
      const expectedDigest = b64(sodium.crypto_generichash(32, contentDigestTranscript(
        this.roomId,
        context,
        event.from,
        packet.contentId,
        packet.contentNonce,
        packet.contentCiphertext
      )));
      if (!sodium.memcmp(fromB64(packet.contentDigest, 32), fromB64(expectedDigest, 32))) {
        throw new GroupCryptoError("Content digest mismatch");
      }
      const wrap = packet.wraps.find((candidate) => candidate.recipientMemberId === this.selfMemberId);
      if (!wrap) throw new GroupCryptoError("Missing local content-key wrap");
      const pair = context.pairs.get(event.from);
      if (!pair) throw new GroupCryptoError("Missing sender pair state");
      if (wrap.sequence !== pair.receiveSequence + 1) throw new GroupCryptoError("Replayed or reordered group message");
      const aad = wrapAad(
        this.roomId,
        context,
        event.from,
        this.selfMemberId,
        wrap.sequence,
        packet.contentDigest
      );
      const expectedNonce = sodium.crypto_generichash(
        sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES,
        transcript("wrap-nonce", aad),
        pair.receiveWrapKey
      );
      if (!sodium.memcmp(fromB64(wrap.nonce, expectedNonce.length), expectedNonce)) {
        throw new GroupCryptoError("Invalid wrap nonce");
      }
      let contentKey: Uint8Array | undefined;
      try {
        contentKey = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          fromB64(wrap.ciphertext),
          aad,
          expectedNonce,
          pair.receiveWrapKey
        );
        if (contentKey.length !== sodium.crypto_aead_xchacha20poly1305_ietf_KEYBYTES) {
          throw new GroupCryptoError("Invalid content key");
        }
        const contentAadBytes = contentAad(this.roomId, context, event.from, packet.contentId);
        const contentNonce = fromB64(
          packet.contentNonce,
          sodium.crypto_aead_xchacha20poly1305_ietf_NPUBBYTES
        );
        const plaintext = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(
          null,
          fromB64(packet.contentCiphertext),
          contentAadBytes,
          contentNonce,
          contentKey
        );
        const message = parsePlaintext(plaintext);
        pair.receiveSequence = wrap.sequence;
        this.callbacks.onMessage(message, event.from);
      } finally {
        safeZero(contentKey);
      }
    } catch (error) {
      if (error instanceof GroupCryptoError) throw new GroupCryptoError(error.message, true);
      throw new GroupCryptoError("Group message authentication failed", true);
    }
  }

  destroy(): void {
    if (this.cryptoState === "DESTROYED") return;
    this.clearCandidate();
    this.clearActive();
    sodium.memzero(this.linkSecret);
    this.cryptoState = "DESTROYED";
  }

  private handleAnnouncement(
    candidate: CandidateContext,
    from: string,
    packet: KeyAnnouncementPacket
  ): void {
    const existing = candidate.announcements.get(from);
    if (existing) {
      if (existing.publicKey === packet.publicKey && existing.authTag === packet.authTag) return;
      throw new GroupCryptoError("Conflicting key announcement");
    }
    if (candidate.epochDigest) throw new GroupCryptoError("Stale key announcement");
    fromB64(packet.publicKey, sodium.crypto_kx_PUBLICKEYBYTES);
    const tag = fromB64(packet.authTag, sodium.crypto_auth_BYTES);
    if (!sodium.crypto_auth_verify(
      tag,
      announcementTranscript(this.roomId, candidate.descriptor, from, packet.publicKey),
      this.linkSecret
    )) throw new GroupCryptoError("Unauthenticated key announcement");
    candidate.announcements.set(from, packet);
    if (candidate.announcements.size === candidate.descriptor.members.length) this.finishAnnouncements();
  }

  private finishAnnouncements(): void {
    const candidate = this.candidate;
    if (!candidate || candidate.epochDigest) throw new GroupCryptoError("Unexpected announcement completion");
    candidate.epochDigest = computeEpochDigest(this.roomId, candidate.descriptor, candidate.announcements);
    for (const peerId of candidate.descriptor.members) {
      if (peerId === this.selfMemberId) continue;
      const peerAnnouncement = candidate.announcements.get(peerId);
      if (!peerAnnouncement) throw new GroupCryptoError("Missing peer announcement");
      const peerPublicKey = fromB64(peerAnnouncement.publicKey, sodium.crypto_kx_PUBLICKEYBYTES);
      const lowerIsSelf = this.selfMemberId < peerId;
      const raw = lowerIsSelf
        ? sodium.crypto_kx_client_session_keys(candidate.keyPair.publicKey, candidate.keyPair.privateKey, peerPublicKey)
        : sodium.crypto_kx_server_session_keys(candidate.keyPair.publicKey, candidate.keyPair.privateKey, peerPublicKey);
      const sendWrapKey = sodium.crypto_generichash(
        32,
        pairContext("wrap-key", this.roomId, candidate.descriptor, candidate.epochDigest, this.selfMemberId, peerId),
        raw.sharedTx
      );
      const receiveWrapKey = sodium.crypto_generichash(
        32,
        pairContext("wrap-key", this.roomId, candidate.descriptor, candidate.epochDigest, peerId, this.selfMemberId),
        raw.sharedRx
      );
      const lowToHigh = lowerIsSelf ? raw.sharedTx : raw.sharedRx;
      const highToLow = lowerIsSelf ? raw.sharedRx : raw.sharedTx;
      const confirmSecret = concat(lowToHigh, highToLow);
      const confirmKey = sodium.crypto_generichash(
        32,
        pairContext(
          "confirm-key",
          this.roomId,
          candidate.descriptor,
          candidate.epochDigest,
          lowerIsSelf ? this.selfMemberId : peerId,
          lowerIsSelf ? peerId : this.selfMemberId
        ),
        confirmSecret
      );
      sodium.memzero(confirmSecret);
      sodium.memzero(raw.sharedRx);
      sodium.memzero(raw.sharedTx);
      candidate.pairs.set(peerId, {
        sendWrapKey,
        receiveWrapKey,
        confirmKey,
        sendSequence: 0,
        receiveSequence: 0
      });
    }
    sodium.memzero(candidate.keyPair.privateKey);
    for (const [peerId, pair] of candidate.pairs) {
      if (!pair.confirmKey) throw new GroupCryptoError("Missing confirmation key");
      const confirmation: KeyConfirmationPacket = {
        v: 1,
        kind: "key_confirmation",
        epochDigest: candidate.epochDigest,
        tag: b64(sodium.crypto_auth(
          confirmationTranscript(
            this.roomId,
            candidate.descriptor,
            candidate.epochDigest,
            this.selfMemberId,
            peerId
          ),
          pair.confirmKey
        ))
      };
      this.callbacks.sendControl({
        epoch: candidate.descriptor.epoch,
        rosterDigest: candidate.descriptor.rosterDigest,
        to: peerId,
        data: encodeWire(confirmation)
      });
    }
    if (candidate.pairs.size === 0) this.emitReady(candidate);
  }

  private handleConfirmation(
    candidate: CandidateContext,
    from: string,
    packet: KeyConfirmationPacket
  ): void {
    if (!candidate.epochDigest || packet.epochDigest !== candidate.epochDigest) {
      throw new GroupCryptoError("Stale key confirmation");
    }
    if (from === this.selfMemberId) throw new GroupCryptoError("Invalid key confirmation sender");
    if (candidate.confirmations.has(from)) return;
    const pair = candidate.pairs.get(from);
    if (!pair?.confirmKey) throw new GroupCryptoError("Missing confirmation state");
    if (!sodium.crypto_auth_verify(
      fromB64(packet.tag, sodium.crypto_auth_BYTES),
      confirmationTranscript(
        this.roomId,
        candidate.descriptor,
        candidate.epochDigest,
        from,
        this.selfMemberId
      ),
      pair.confirmKey
    )) throw new GroupCryptoError("Pairwise key confirmation failed");
    candidate.confirmations.add(from);
    if (candidate.confirmations.size === candidate.pairs.size) this.emitReady(candidate);
  }

  private emitReady(candidate: CandidateContext): void {
    if (!candidate.epochDigest || candidate.readySent) return;
    candidate.readySent = true;
    for (const pair of candidate.pairs.values()) {
      safeZero(pair.confirmKey);
      pair.confirmKey = undefined;
    }
    this.callbacks.sendReady({
      epoch: candidate.descriptor.epoch,
      rosterDigest: candidate.descriptor.rosterDigest,
      epochDigest: candidate.epochDigest
    });
  }

  private requireCandidate(epoch: number, rosterDigest: string): CandidateContext {
    const candidate = this.candidate;
    if (
      this.cryptoState !== "REKEYING" || !candidate ||
      candidate.descriptor.epoch !== epoch || candidate.descriptor.rosterDigest !== rosterDigest
    ) throw new GroupCryptoError("Stale group control packet");
    return candidate;
  }

  private requireActive(): EpochContext {
    if (this.cryptoState !== "ACTIVE" || !this.active) throw new GroupCryptoError("Group epoch is not active");
    return this.active;
  }

  private assertUsable(): void {
    if (this.cryptoState === "DESTROYED") throw new GroupCryptoError("Group crypto session is destroyed");
  }

  private clearCandidate(): void {
    if (!this.candidate) return;
    safeZero(this.candidate.keyPair.privateKey);
    zeroPairs(this.candidate.pairs);
    this.candidate.announcements.clear();
    this.candidate.confirmations.clear();
    this.candidate = undefined;
  }

  private clearActive(): void {
    this.pendingOutbound = undefined;
    if (!this.active) return;
    zeroPairs(this.active.pairs);
    this.active = undefined;
  }
}

function validatePlaintext(message: GroupDecryptedMessage): void {
  if (
    typeof message.id !== "string" || message.id.length < 1 || message.id.length > 80 ||
    typeof message.text !== "string" || message.text.length < 1 || message.text.length > 2000 ||
    typeof message.sentAt !== "number" || !Number.isSafeInteger(message.sentAt) ||
    message.sentAt < 0 || message.sentAt > 8_640_000_000_000_000
  ) throw new GroupCryptoError("Invalid plaintext envelope");
}

function parsePlaintext(plaintext: Uint8Array): GroupDecryptedMessage {
  try {
    const value = JSON.parse(textDecoder.decode(plaintext)) as Record<string, unknown>;
    const message = { id: value.id, text: value.text, sentAt: value.sentAt } as GroupDecryptedMessage;
    validatePlaintext(message);
    return message;
  } catch (error) {
    if (error instanceof GroupCryptoError) throw error;
    throw new GroupCryptoError("Invalid plaintext envelope");
  }
}

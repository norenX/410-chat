# 410 Group E2EE v1

Status: **experimental, DEV-only, custom and unaudited**.

This document specifies the protocol implemented by `GroupCryptoSession` and
the membership rules enforced by `GroupRoomManager`. It does not modify or
replace the existing two-browser protocol.

## Scope and security goals

Group E2EE v1 is designed for live, temporary rooms with at most ten active
participants. It aims to provide:

- message confidentiality and integrity between current room participants;
- no plaintext, usable message key, or message history at the relay;
- join confidentiality: a new participant receives no key for an older epoch;
- leave confidentiality: after grace expires and a removal epoch completes,
  the removed participant receives no key for that new epoch;
- authenticated admission based on possession of the invite fragment secret;
- one canonical roster and authenticated ephemeral-key transcript per epoch;
- rejection of stale epochs, modified envelopes, replay and duplicate sequence
  numbers.

It is not MLS, Signal Sender Keys, Noise, or another standardized group
protocol. It has not received an independent cryptographic review. The feature
is disabled by default with `GROUP_ROOMS_ENABLED=false`.

## Threat model

The relay is not trusted with message plaintext or key material. It is trusted
to assign live member IDs and to report one serialized membership revision to
the clients. Cryptographic transcripts make an undetected key substitution by
a relay that does not know the link secret fail authentication.

The relay can still drop, delay, reorder, partition, or deny traffic; omit a
physical disconnect; present different membership progress to different
clients; and prevent an epoch from becoming ready. The protocol does not make
the service available under a malicious relay. Clients accept application
traffic only after every member of their advertised roster confirms the same
epoch digest, limiting accidental or partial-roster activation.

Every invite holder knows the same admission secret. A malicious invite holder
is therefore an authenticated room participant, can rejoin, can create up to
the room capacity, can send disruptive control traffic, and can cause denial
of service. The protocol provides no persistent participant identity and no
out-of-band identity authentication. Any participant can copy plaintext after
it is displayed.

Endpoint compromise, browser extensions, screenshots, clipboard capture,
traffic analysis, and operating-system compromise are out of scope.

## Credentials and server-visible state

Creation produces independent random values:

- a 192-bit room ID known to the relay;
- a 256-bit reusable invite token, whose SHA-256 hash indexes the room;
- a browser-generated 256-bit link secret in the URL fragment, never sent in
  HTTP requests or WebSocket commands;
- a browser-generated 256-bit owner capability. Creation sends only
  `SHA-256(ownerCapability)` to the relay;
- a random resume token per admitted live member. The relay stores only its
  SHA-256 hash.

The owner capability is not derived from the invite or link secret and is not
included in Copy, QR, Web Share, or the participant URL. The browser keeps it
in `sessionStorage`; losing it has no recovery path.

The relay assigns each opaque member ID and binds it to one authenticated
WebSocket context. A client command cannot choose its member ID. Relay events
add `from` from that server-side context.

## Room and membership lifecycle

The room is `OPEN` until manual destruction or its absolute 24-hour TTL. The
TTL begins at creation and is never extended. The relay stores no messages,
backlog or replay buffer.

Membership change handling is:

1. Join allocates a fresh server member ID and resume token.
2. A socket disconnect retains its member and capacity slot for 15 seconds.
   The existing epoch remains usable by connected members during this grace.
   If another membership revision begins during grace, the disconnected member
   remains in the canonical roster, so the new ready barrier waits for either
   its resume or its grace expiry rather than silently committing a partial
   roster.
3. Resume during grace keeps the server member ID, rotates the resume token,
   and starts a fresh full-group epoch. A valid overlapping resume replaces
   the older socket, which is prevented from automatically resuming again.
4. Grace expiry removes the member, erases its resume state, and starts a fresh
   full-group epoch for the remaining connected members.
5. Opening the reusable invite after removal creates a new live member with
   fresh credentials and a fresh full-group epoch.

Application sending is disabled during `REKEYING`. If the bounded rekey timer
expires, the room remains fail-closed in `REKEYING`; the relay does not infer
blame from self-asserted READY values, evict a member, or rotate into a retry
storm. Late valid control/READY traffic may still complete that epoch; a later
real membership change instead starts a fresh epoch. A disconnected grace
member is removed only by its independent grace timer. A malicious live
participant can therefore stall the room, which is an explicit availability
limitation.

An epoch transition erases the prior ephemeral private key, pairwise session
keys, confirmation keys and replay state best-effort with `sodium.memzero`.
JavaScript garbage collection prevents a guarantee that every historical copy
has been physically overwritten.

## Canonical encoding

Cryptographic transcript values are byte strings, never ad-hoc serialized JSON.
Integers are unsigned big-endian. `u32(x)` is four bytes, `u64(x)` is eight
bytes, and `lp(x)` is `u32(byteLength(x)) || x`. Text is UTF-8. Member lists are
strictly lexicographically sorted and contain no duplicates.

The common transcript wrapper is:

```text
lp("410-group-e2ee-v1") ||
u32(1) ||
lp(domain) ||
field_1 || ... || field_n
```

The relay-computed roster digest uses:

```text
lp("410-group-roster-v1") ||
lp(roomId) ||
u64(epoch) ||
lp(epochNonce) ||
u32(memberCount) ||
for each sorted member: lp(memberId)
```

`epochNonce` is a fresh random 256-bit base64url value. `rosterDigest` is
SHA-256 of the encoding above. Every client recomputes it before accepting the
descriptor.

Within client transcripts, `epochBase` is:

```text
lp(roomId) ||
u64(epoch) ||
lp(epochNonce) ||
lp(rosterDigest) ||
u32(memberCount) ||
for each sorted member: lp(memberId)
```

## Full-group epoch establishment

Every member generates a fresh ephemeral X25519 `crypto_kx` key pair for every
epoch. It broadcasts this packet through the relay:

```text
{
  v: 1,
  kind: "key_announcement",
  publicKey: base64url(X25519 public key),
  authTag: base64url(crypto_auth(announcementTranscript, linkSecret))
}
```

The authenticated `announcementTranscript` is:

```text
transcript("key-announcement", epochBase, lp(memberId), lp(publicKey))
```

The member ID comes only from the relay event. Packets with a client-claimed
foreign member ID are rejected by the relay. Clients authenticate every
announcement and reject conflicting duplicates, members outside the exact
roster, stale epochs, invalid key lengths, and non-canonical rosters. Exact
duplicates are idempotent. The relay also admits at most one exact
announcement per server-bound member and one exact confirmation per ordered
pair in an epoch.

After all announcements arrive, every client computes:

```text
epochDigest = BLAKE2b-256(
  transcript(
    "epoch-digest",
    epochBase,
    u32(memberCount),
    for each sorted member:
      lp(memberId) || lp(publicKey) || lp(authTag)
  )
)
```

Thus the digest covers the room, epoch, nonce, exact roster, and complete set
of authenticated ephemeral keys.

## Pairwise directional keys and confirmation

For each pair, the lexicographically lower member ID uses the libsodium
`crypto_kx_client_session_keys` role and the higher ID uses
`crypto_kx_server_session_keys`. This assigns compatible directional keys
without negotiation.

Each raw transmit/receive key is domain-separated with keyed BLAKE2b-256 over:

```text
transcript(
  "wrap-key",
  epochBase,
  lp(epochDigest),
  lp(senderMemberId),
  lp(recipientMemberId)
)
```

Both directions are combined in canonical low-to-high/high-to-low order to
derive a temporary pair confirmation key. Each side sends a targeted
`key_confirmation` containing `epochDigest` and:

```text
crypto_auth(
  transcript(
    "key-confirmation",
    epochBase,
    lp(epochDigest),
    lp(fromMemberId),
    lp(toMemberId)
  ),
  confirmationKey
)
```

The confirmation key is erased after every peer confirms. A member then sends
`group_ready(epoch, rosterDigest, epochDigest)`. The relay records READY as a
per-member assertion only after it has received the complete, strictly
validated announcement set and that sender's confirmation for every other
roster member. A member may correct its assertion while the epoch is still
`REKEYING`. The relay changes the room to `ACTIVE` only when every current
member asserts one identical digest. The first submitted READY never defines
canonical state. A stale ready, a ready for another roster, a non-unanimous
digest set, or a ready before the sender's complete confirmation set cannot
activate the epoch. Clients remain responsible for computing that digest and
authenticating every announcement and confirmation; the relay never receives
the link secret.

## Application-message envelope

For every message, the sender generates an independent random 256-bit content
key and random 192-bit XChaCha20 nonce. The UTF-8 JSON plaintext envelope
contains only `id`, `text`, and `sentAt`. It is encrypted once with
XChaCha20-Poly1305 using AAD:

```text
transcript(
  "content-aead",
  epochBase,
  lp(epochDigest),
  lp(senderMemberId),
  lp(contentId)
)
```

`contentDigest` is BLAKE2b-256 over a domain-separated transcript containing
the epoch context, sender, random content ID, content nonce and content
ciphertext.

The content key is then wrapped separately for every other member in the exact
canonical roster. Each `sender -> recipient -> epoch` pair has its own strictly
monotonic sequence. Wrap AAD is:

```text
transcript(
  "content-key-wrap",
  epochBase,
  lp(epochDigest),
  lp(senderMemberId),
  lp(recipientMemberId),
  u64(sequence),
  lp(contentDigest)
)
```

The XChaCha20 wrap nonce is deterministically derived with keyed BLAKE2b from
the pair key and the unique AAD/sequence. A new full-group epoch installs a
fresh pair key and resets sequence state, so nonce reuse with one key is not
allowed. Receivers require exactly the next sequence, the exact current
recipient set, the current epoch/digest, a matching content digest and valid
AEAD tags. Duplicate, replayed, skipped, modified, old-epoch and partial-roster
envelopes are rejected.

The relay parses only enough of the opaque base64url JSON packet to enforce the
exact known protocol schema and count one accepted logical
`group_ciphertext`. It does not retain the packet or its length as analytics.
One accepted broadcast counts once when it is queued to at least one current
peer, not once per recipient.

Application sequence allocation is transactional. The sender prepares one
pending envelope without advancing pair sequence state and assigns a random
transient `relayId`. The relay returns `group_relay_accepted` only after the
frame is queued to at least one peer, or `group_relay_rejected` before delivery
when the application quota, state, or schema rejects it. The client commits
all pair sequences only on acceptance and rolls them back on rejection. Only
one application relay may be pending per client. Reusing the uncommitted
sequence after a rejection does not reuse an AEAD nonce: each retry has a new
random content key, content ID and content nonce, and the deterministic wrap
nonce is additionally bound to the new content digest.

Control traffic is structurally bounded per epoch and does not consume the
application message quota. A separate per-socket all-frame count/byte ceiling
applies before parsing. Every server send checks WebSocket `bufferedAmount`;
a slow consumer is disconnected before another event is queued beyond the
configured threshold. Application traffic therefore cannot exhaust the
membership handshake allowance.

## Join and leave guarantees

A newly admitted member participates only in a fresh epoch and never receives
old epoch keys or old relay frames. Captured older ciphertext is bound to its
older epoch and cannot be accepted with the new pairwise keys.

A disconnected member remains part of the current epoch during the 15-second
grace. Therefore leave confidentiality begins only after grace expiry and the
remaining members successfully activate the removal epoch. The removed member
does not receive the fresh X25519 announcements/pairwise keys as a current
member and cannot unwrap new content keys.

An invite holder can immediately rejoin as a new member. That new member may
read messages sent after its new join epoch is active, but still receives no
prior message history.

## Destruction and cleanup

Manual owner destruction and TTL destruction synchronously remove the room,
invite index, resume indexes and socket contexts before best-effort network
notification. Timers and rate-limit arrays are cleared; verifier and resume
hash buffers are zeroed; sockets are closed. The old `/g/<invite>` then returns
the same real HTTP 410 response as any other unavailable well-formed group
invite. No tombstone database is created.

## Known limitations

- This is a custom, unaudited protocol and is not MLS.
- There is no per-message forward secrecy ratchet. Compromise of an active
  epoch pairwise key can expose content keys wrapped for that pair in the same
  epoch if the attacker has captured the envelopes.
- PCS-like recovery occurs only after a fresh successful full-group epoch whose
  new ephemeral private keys are not compromised.
- A compromised current participant can read and retain current plaintext,
  leak keys, forge its own messages, or deliberately stall/restart epochs.
- A malicious relay can cause DoS, delay and partition. When it is the sole
  membership oracle, cryptography cannot prove the instant of a physical
  disconnect; leave protection starts at committed removal.
- All invite holders share the admission secret. There is no participant
  identity, Sybil resistance, kick, ban, invite rotation or revocation.
- The reusable invite holder can re-enter as a new participant.
- Exact next-sequence enforcement intentionally fails closed if a malicious
  relay selectively drops a frame after acknowledging it. Ordinary
  server-side rejection cannot create this gap because sequences are committed
  only after relay acceptance. Reconnect establishes a fresh epoch rather than
  replaying history.
- A malicious membership relay can present disjoint honest subsets with
  different canonical rosters at the same numeric epoch. Each fork has a
  different authenticated `rosterDigest`/`epochDigest`, so packets cannot cross
  forks undetected, but participants have no external consistency witness with
  which to discover the partition. Preventing this requires a stronger
  membership-consistency mechanism and is outside v1.
- Metadata remains visible to the relay: room existence and source category,
  membership count and changes, opaque server member IDs, connection timing,
  IP addresses at the transport/rate-limit layer, epoch/control packet kinds,
  ciphertext sizes and timing, and a transient random relay acknowledgement
  ID while an application frame is processed. These values are not persisted
  as per-room analytics.
- Browser memory erasure is best-effort, and owner/session credentials kept in
  `sessionStorage` are accessible to script running in the same origin.

An independent protocol and implementation audit is required before any
production rollout.

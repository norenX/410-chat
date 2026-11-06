# 410

**One link → an end-to-end encrypted conversation → gone.**

410 is a minimal disposable chat. Its primary mode remains a one-time
conversation for exactly two browsers. An experimental, feature-flagged group
room mode is available for DEV evaluation.

There are no accounts, usernames, contact lists, public rooms, message history, file uploads, or conversation database.

Live service: **https://410.chat**

## Why

Sometimes two people need a private conversation without exchanging a permanent contact method.

410 is built around that narrow case:

1. Open the site.
2. Create a one-time link.
3. Copy the link or show its locally generated QR code to one person.
4. Talk.
5. Destroy the conversation, disconnect, or let it expire.
6. The conversation URL becomes HTTP `410 Gone`.

It is intentionally not a general-purpose messenger.

## Experimental group rooms

Group rooms are disabled by default and must be enabled explicitly:

```text
GROUP_ROOMS_ENABLED=true
```

They are a DEV-only feature until the separate Group E2EE v1 protocol and its
implementation receive an independent security review. Enabling the flag does
not imply that the protocol has been audited or is ready for production.

The current group-room limits are:

- reusable invite while the room is alive;
- up to 10 simultaneous participants;
- 15-second disconnect grace;
- rekey on join, final leave, and reconnect;
- absolute 24-hour TTL from creation;
- no server-side message history or replay;
- a tab-scoped creator capability for early destruction, with a separate
  room-scoped browser recovery secret for reclaiming creator control;
- temporary server-assigned nicknames/colors, with one room-scoped primary
  persona per browser and ephemeral personas for additional tabs;
- at most three simultaneous live/grace tabs per browser token.

See [docs/group-e2ee-v1.md](docs/group-e2ee-v1.md) for the exact experimental
protocol, threat model, transcript encoding, and known limitations.

## Quick start

Requires Node.js 22+.

```bash
npm ci
npm run build
METRICS_FILE=./metrics.json HOST=0.0.0.0 PORT=8080 npm start
```

Then open:

```text
http://localhost:8080
```

Health check:

```text
GET /healthz
```

### Docker

```bash
docker compose up --build -d
```

The default host port is `8080`.

To use another port:

```bash
HOST_PORT=9000 docker compose up --build -d
```

## Production deployment

Production use requires HTTPS/WSS.

410 can run behind a reverse proxy such as Caddy or nginx.

By default the application does **not** trust `X-Forwarded-For`:

```text
TRUST_PROXY=false
```

Only set:

```text
TRUST_PROXY=true
```

when the Node.js service is reachable exclusively through a reverse proxy you control.

Otherwise a direct client could spoof forwarded IP headers and interfere with IP-based rate limiting.

`ALLOWED_ORIGINS` can optionally contain a comma-separated list of exact additional origins. Same-origin requests based on the current `Host` are always accepted.

## Architecture

- React + TypeScript frontend built with Vite.
- One Node.js HTTP/WebSocket process using `ws`.
- Direct and group room state exists only in application memory.
- No Redis.
- No conversation database.
- No server-side message history.
- The relay forwards encrypted frames directly to the peer.
- Aggregate service counters may optionally persist to a JSON file.

Room lifecycle:

```text
CREATED → WAITING → ACTIVE → DESTROYED
```

Invite lifecycle:

```text
ACTIVE → CONSUMED
```

Room ID, invite token and resume credentials are separate cryptographically random identifiers.

When a room is destroyed, its room state, invite index, resume hashes, connection context and timers are removed from the application's in-memory store.

A process restart destroys all active rooms.

Group rooms use a separate manager, WebSocket protocol, invite namespace and
crypto session. The existing two-browser lifecycle and crypto implementation
are not generalized or replaced by the group feature.

## Conversation lifetime

- An unused invite expires after 30 minutes.
- The invite can admit exactly one second participant.
- Once consumed, the invite cannot be reused.
- The active conversation hard TTL is 30 minutes.
- The active TTL begins when the second participant successfully joins.
- Heartbeat interval: 5 seconds.
- Stale connection detection: 12 seconds.
- Reconnect grace period: 15 seconds.
- A successful reconnect performs a fresh ephemeral handshake/rekey.
- Manual destroy, TTL expiry or disconnect-grace expiry destroys the room.

## HTTP 410

A valid unused invite URL returns the application with HTTP `200`.

A consumed, expired, destroyed, or otherwise unavailable correctly formed conversation URL returns:

```text
HTTP 410 Gone
```

The 410 response is a static dead end:

- no React;
- no JavaScript;
- no buttons;
- no links;
- `Cache-Control: no-store`;
- `X-Robots-Tag: noindex, nofollow`.

Unknown non-room routes return `404`.

410 does not keep tombstones for destroyed rooms.

## End-to-end encryption

The current protocol uses libsodium primitives.

High-level flow:

1. The creator generates a 256-bit link authentication secret in the browser.
2. The secret is placed in the URL fragment:

```text
/r/<invite-token>#secret=<link-secret>
```

3. URL fragments are not sent to the server as part of the HTTP request.
   The optional invite QR is generated locally in the browser from this same full URL. The fragment secret is not sent to a QR service, and QR generation requires no third-party network request.
4. Both browsers create ephemeral X25519 key pairs using `crypto_kx`.
5. Offer and answer messages are authenticated with the link secret.
6. The handshake transcript binds the room ID, handshake ID and both public keys.
7. Directional session keys are derived.
8. Both peers perform explicit key confirmation.
9. Chat messages are encrypted with XChaCha20-Poly1305.
10. Messages use fresh nonces, sequence numbers and authenticated additional data.
11. Reconnect performs a new ephemeral handshake and rekey.

The relay processes ciphertext and protocol metadata but is not intended to receive message plaintext or session encryption keys.

This is a custom PSK-authenticated protocol built from standard primitives. It is **not** Noise and has **not undergone an independent cryptographic audit**.

See [SECURITY.md](SECURITY.md).

### Experimental Group E2EE v1

Group rooms use membership epochs. Each epoch has fresh ephemeral X25519
contributions and pairwise directional keys. A random content key encrypts each
message once; that content key is wrapped separately for every current
recipient. XChaCha20-Poly1305, authenticated metadata, monotonically increasing
per-pair sequences, mutual confirmation, and a common epoch-digest ready
barrier are used before application messages are enabled.

The shared invite fragment secret authenticates admission to a room. It is not
a persistent participant identity. Membership metadata and encrypted frames
are relayed by the server, but usable message keys and plaintext are not part
of server room state.

This is a custom experimental protocol. It has not undergone an independent
security audit and must not be represented as production-audited cryptography.

## What the relay can see

While a connection exists, the server necessarily processes operational metadata including:

- client IP address;
- connection timing;
- room ID;
- invite or resume credentials presented to the server;
- participant role and lifecycle state;
- public handshake keys and authentication tags;
- encrypted frame sizes, timing and frequency;
- ciphertext, nonce and sequence metadata.

IP addresses are used transiently by in-memory abuse controls.

They are not written into the aggregate metrics file by 410.

## What the relay does not intentionally retain

410 does not create a conversation archive.

The application does not intentionally persist:

- message plaintext;
- message ciphertext;
- conversation history;
- accounts;
- contact lists;
- room IDs in analytics;
- invite tokens in analytics;
- resume credentials in analytics;
- IP addresses in analytics;
- User-Agent values in analytics;
- full referrer URLs.

Relay frames are forwarded to the peer and are not stored as message history.

## Privacy-preserving metrics

`GET /__stats` exposes aggregate service counters.

The current metrics schema is version 3. Version 1 and version 2 files are
migrated without changing their existing direct-conversation counters.

It contains:

- process start time and uptime;
- current aggregate `WAITING` and `ACTIVE` room counts;
- UTC daily counters;
- lifetime counters;
- aggregate counters grouped by a small whitelist of coarse traffic-source labels.

Examples of coarse source labels include:

```text
direct
google
yandex
producthunt
reddit
hn
pikabu
habr
vc
dev
telegram
other
unattributed
```

Only aggregate funnel counters are attributed by source:

```text
homepage_views
rooms_created
conversations_started
messages_relayed
```

The application may use an explicit known `from` value or infer a coarse known source from the HTTP referrer hostname.

The complete referrer URL is not persisted.

Unknown values are normalized rather than creating arbitrary metric keys.

`direct` means that no known external source was available. It does not necessarily mean that a person manually typed the address.

Other global counters include room destruction reasons and HTTP 410 responses.

Experimental group-room counters are stored in a separate `groups` section so
that historical one-to-one metrics keep their existing meaning. The compact
`scripts/stats.sh` output presents separate `DIRECT` and `GROUP` sections. Its
group `people` value follows the live Room roster: a disconnected grace slot
continues to count until its grace period expires, just as the presence count
shown to Room participants does.

`GET /admin/stats` serves a compact live view of the same aggregate snapshot.
The page polls `GET /admin/api/stats` every five seconds. The browser endpoint
is a minimal projection containing only the DIRECT/GROUP counters displayed by
`scripts/stats.sh`; it excludes process diagnostics, source attribution and all
conversation-level data. Loading or polling the admin page does not increment
`homepage_views` or any conversation counter.

The application does not implement admin credentials. In a production setup,
protect both the page and its JSON endpoint at the reverse proxy with one
`/admin/*` matcher. Do not store Basic Auth credentials in this repository.
The existing `GET /__stats`, `STATS_URL` override and `scripts/stats.sh` output
remain unchanged.

The metrics file contains no user-level or conversation-level analytics.

Docker Compose persists the metrics file in a named volume mounted at `/data`.

The application container otherwise runs with a read-only root filesystem.

## Abuse controls

The MVP includes:

- room-creation rate limiting;
- WebSocket admission rate limiting;
- relay-frequency rate limiting;
- WebSocket frame-size limits;
- relay-payload limits;
- a global cap on simultaneously existing group rooms;
- a lower cap on rooms that currently hold no participant slot;
- a hard 10-participant group-room cap;
- separate application-message and structurally bounded group-control budgets;
- per-socket all-frame count/byte ceilings and slow-consumer backpressure cutoff;
- plaintext message-size limits;
- input type and format validation;
- binary WebSocket frame rejection;
- same-origin WebSocket checks;
- optional exact allowed origins;
- explicit trusted-proxy handling;
- disabled WebSocket compression;
- CSP;
- anti-framing headers;
- `Referrer-Policy: no-referrer`;
- `X-Content-Type-Options: nosniff`;
- restrictive `Permissions-Policy`.

Docker runs the service:

- as a non-root user;
- with a read-only root filesystem;
- with all Linux capabilities dropped;
- with `no-new-privileges`;
- with a small tmpfs;
- with only the metrics volume writable and persistent.

These controls are not a substitute for external network-level DoS protection.

## Tests

Unit and integration tests:

```bash
npm run lint
npm run typecheck
npm run build
npm test
```

Browser tests:

```bash
npm run test:browser
```

For a reproducible Playwright environment:

```bash
PW_VERSION=$(npx playwright --version | awk '{print $2}')

docker run --rm \
  --ipc=host \
  -v "$PWD":/work \
  -w /work \
  "mcr.microsoft.com/playwright:v${PW_VERSION}-noble" \
  npm run test:browser
```

The suite covers, among other things:

- room lifecycle;
- invite consumption;
- HTTP 410 behavior and headers;
- absence of automatic room creation;
- two-browser encrypted message exchange;
- multi-browser group epoch establishment and encrypted message exchange;
- group join/leave/reconnect rekey and replay rejection;
- reconnect and rekey;
- disconnect grace;
- TTL behavior;
- rate limiting;
- trusted-proxy IP handling;
- server-history absence;
- aggregate metrics;
- source attribution;
- Chromium and Firefox user flows.

## Security limitations

410 should not be described as providing absolute security or guaranteed anonymity.

Important limitations include:

- The web server delivers the JavaScript client. A compromised server or frontend supply chain could serve modified code that steals future plaintext or keys.
- JavaScript key erasure is best effort.
- Browsers and operating systems may retain memory copies.
- A peer can copy, screenshot, photograph or record anything they receive.
- Browser extensions or a compromised endpoint can access content outside 410's threat model.
- Network metadata still exists.
- IP-based rate limits are local to one process and do not stop distributed attacks.
- A process restart destroys all active rooms.
- The protocol has not undergone an independent security audit.

See [SECURITY.md](SECURITY.md) for the threat model.

## Design principle

410 deliberately keeps the feature set narrow.

The primary product remains:

```text
one link → two people → conversation → gone
```

The optional group-room experiment follows the same ephemeral/no-history
principle without introducing accounts, member profiles, or persistent rooms.

Features that turn it into a persistent messenger are intentionally out of scope.

## License

GNU Affero General Public License v3.0.

See [LICENSE](LICENSE).

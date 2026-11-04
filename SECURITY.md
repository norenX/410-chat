# Security policy

410 is an unaudited open-source MVP for disposable conversations. The existing
two-person mode and the feature-flagged experimental group mode use separate
protocol implementations and security models.

It should not be represented as providing absolute security, guaranteed anonymity, endpoint protection, or protection against a malicious peer.

## Security model

410 aims to prevent the relay from needing message plaintext during normal operation.

The browser clients perform the cryptographic handshake and encrypt chat messages before relay.

The relay is still a trusted delivery point for the web application itself and an operational participant in the conversation lifecycle.

That distinction is important.

## Cryptographic design

The current implementation uses libsodium primitives including:

- ephemeral X25519 key exchange via `crypto_kx`;
- authentication derived from the link secret;
- transcript binding;
- explicit mutual key confirmation;
- XChaCha20-Poly1305 authenticated encryption;
- fresh nonces;
- sequence numbers;
- authenticated additional data;
- ephemeral rekey after reconnect.

The creator-generated link authentication secret is stored in the URL fragment.

A normal HTTP request does not transmit the fragment to the server.

The protocol is custom.

It is not a standardized Noise protocol and has not undergone an independent cryptographic audit.

## Experimental group protocol

Group E2EE v1 is disabled by default and intended only for DEV evaluation until
it receives a separate independent security review.

It uses membership epochs, fresh ephemeral X25519 contributions, directional
pairwise keys, per-message random content keys, per-recipient key wrapping,
XChaCha20-Poly1305, replay state, authenticated canonical transcripts, mutual
key confirmation, and an all-member epoch-digest ready barrier.

The group invite fragment contains a shared admission/authentication secret.
Possession proves access to the invite secret; it does not establish a stable
or unique participant identity.

Group nicknames and colors are presentation metadata only. A random token in
`localStorage` preserves a primary persona for one browser in one room; each
additional tab has a separate `sessionStorage` token and live member slot. The
server receives only token verifiers, stores only their hashes in room memory,
and does not place them in metrics. This permits same-room tab correlation and
does not authenticate the human behind a nickname. Reload/re-entry still uses
a fresh member ID and full cryptographic epoch and restores no messages.

Creator recovery uses a second, independent 256-bit room secret in
`localStorage`. The relay stores only its verifier and binds recovery to the
browser profile that first proves both the original owner capability and the
recovery secret as the room's primary persona. A later primary re-entry from
that profile can rotate to a fresh tab-scoped owner capability. The persona
token alone, an additional ephemeral tab, or an invite holder from another
profile cannot recover Destroy authority. Same-origin script compromise can
read both persistent browser secrets and is outside this boundary.
The raw recovery secret is presented transiently in the recovery join command;
the relay hashes it for comparison and does not retain it.

Join secrecy begins when a new epoch is committed: a new member receives no
keys for prior epochs. Leave secrecy begins only after disconnect grace expires
and the remaining members commit a new epoch. A former member that still has
the reusable invite may rejoin as a new live session and receive keys for the
new epoch.

The relay remains the membership and delivery coordinator. It can delay,
withhold, reorder, partition, or deny delivery and can misreport physical
presence. Authenticated key material is intended to prevent a relay without
the invite secret from silently substituting usable cryptographic keys, but it
does not make the service available under a malicious relay.

The complete design is documented in
[docs/group-e2ee-v1.md](docs/group-e2ee-v1.md).

## What the relay can observe

During normal operation the relay necessarily processes metadata required to provide the service, including:

- source IP addresses;
- connection timing;
- room identifiers;
- invite and resume credentials presented to the server;
- participant roles;
- lifecycle state;
- handshake identifiers;
- public ephemeral keys;
- authentication tags;
- encrypted frame sizes and frequency;
- ciphertext;
- nonce and sequence metadata.

IP addresses may be held temporarily in memory for rate limiting.

## What 410 does not intentionally persist

410 does not intentionally create or maintain:

- server-side message history;
- message plaintext;
- message ciphertext archives;
- user accounts;
- contact lists;
- destroyed-room archives;
- room identifiers in analytics;
- invite or resume credentials in analytics;
- IP addresses in analytics;
- User-Agent values in analytics;
- full referrer URLs.

Active rooms exist only in application memory.

When a room is destroyed, its in-memory room state is removed.

Aggregate service counters are stored separately and contain no user- or conversation-level identifiers.

## Web-delivered JavaScript limitation

End-to-end encryption does not remove the need to trust the JavaScript delivered to the browser.

A compromised application server, deployment pipeline, dependency, CDN, administrator account, or other frontend supply-chain component could serve modified JavaScript.

Such modified code could capture plaintext, link secrets, or cryptographic material from future sessions.

Open source allows source review and self-hosting, but source availability alone does not prove that a particular hosted instance is serving an identical build.

This is one of the most important limitations of the current architecture.

## Endpoint and peer limitations

410 cannot prevent:

- screenshots;
- screen recording;
- copy/paste;
- photography of the display;
- malicious browser extensions;
- malware on a participant device;
- compromised browsers or operating systems;
- a malicious participant retaining received content.

Once plaintext is displayed to a participant, 410 cannot control what that participant does with it.

## Network security

Production deployments must use HTTPS/WSS.

Plain HTTP/WS exposes transport metadata and application traffic to network observers and active attackers.

The included local HTTP mode is intended for development and controlled local evaluation.

## Reverse proxies

`TRUST_PROXY` is disabled by default.

Do not enable it unless the application is reachable exclusively through a reverse proxy you control.

When enabled, 410 uses forwarded client IP information for in-memory rate limiting.

Incorrectly trusting arbitrary forwarded headers can allow clients to spoof IP addresses and bypass or interfere with those controls.

## Metrics and attribution

410 may keep aggregate service counters and a small set of coarse traffic-source buckets.

It does not intentionally persist full referrer URLs.

Traffic-source attribution is not intended to identify individual people or conversations.

## Denial of service

The built-in rate limits are basic abuse controls.

They are:

- process-local;
- primarily IP-based;
- not a substitute for a reverse proxy, firewall, provider-level filtering, or distributed DoS protection.

Shared NAT, CGNAT, VPN exits, offices, or other common source IPs may also cause unrelated users to share the same rate-limit bucket.

## Key erasure

The implementation attempts to clear key arrays when they are no longer needed.

In JavaScript this is best effort only.

The runtime, garbage collector, browser, operating system, crash dumps, swap, or other system components may retain copies outside application control.

## Availability

All live rooms exist in one process's memory.

Restarting or terminating the process destroys active rooms.

This supports the data-minimization model but reduces availability.

## Areas requiring independent review

Before treating 410 as suitable for sensitive or high-risk use, commission an independent review of at least:

- PSK-authenticated handshake design;
- transcript construction and binding;
- X25519 key handling;
- key derivation;
- key confirmation;
- XChaCha20-Poly1305 nonce handling;
- sequence and replay behavior;
- reconnect and rekey behavior;
- invite-consumption races;
- destruction and reconnect races;
- frontend XSS exposure;
- Content Security Policy;
- dependency and supply-chain risk;
- reverse-proxy trust configuration;
- TLS termination;
- logging;
- aggregate metrics;
- rate limiting;
- multi-instance behavior;
- denial-of-service exposure.

Before enabling group rooms in production, independently review at least:

- the canonical length-prefixed transcript encoding;
- admission-MAC and server-bound member-ID handling;
- epoch-digest agreement and ready barrier;
- deterministic `crypto_kx` role assignment;
- pairwise key confirmation;
- content-key wrapping and nonce discipline;
- join/leave secrecy across concurrent membership changes;
- stale epoch, replay, and duplicate-sequence handling;
- JavaScript best-effort key erasure;
- owner-capability verification;
- room-scoped persona verifier isolation, three-tab admission races, and
  persona metadata spoofing boundaries;
- malicious relay and malicious invite-holder behavior.

## Reporting a vulnerability

Please do not publish exploit details in a public issue before coordinated disclosure.

Use GitHub's private security-reporting / Security Advisory mechanism for this repository when available.

Include:

- affected version or commit;
- reproduction steps;
- expected impact;
- relevant logs or traces with sensitive information removed.

No bounty program or response-time guarantee is currently offered.

## No security guarantee

410 is experimental software.

Use, deployment, and self-hosting require your own security assessment for the intended threat model.

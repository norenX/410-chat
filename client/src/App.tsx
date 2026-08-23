import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ClientCommand, Role, ServerEvent } from "../../shared/protocol.js";
import { CryptoSession, createLinkSecret, sodiumReady, type DecryptedMessage } from "./crypto-session";

type View = "loading" | "landing" | "security" | "creating" | "connecting" | "waiting" | "handshaking" | "active" | "reconnecting";
type CopyState = "copied" | "manual";
type InfoPanel = "how" | "security" | null;

interface LocalSession {
  roomId: string;
  role: Role;
  resumeToken: string;
  linkSecret: string;
  expiresAt: number;
  disconnectGraceMs: number;
  inviteUrl?: string;
}

interface ChatMessage extends DecryptedMessage {
  side: "self" | "peer";
}

const SESSION_KEY = "410.session.v1";
const LEGACY_SESSION_KEY = "burnroom.session.v1";
const INVITE_PATH = /^\/r\/([A-Za-z0-9_-]{43})$/;
const AUTO_SCROLL_THRESHOLD = 80;

function readLocalSession(): LocalSession | null {
  try {
    const parsed = JSON.parse(sessionStorage.getItem(SESSION_KEY) || "null") as LocalSession | null;
    if (
      !parsed || typeof parsed.roomId !== "string" || typeof parsed.resumeToken !== "string" ||
      typeof parsed.linkSecret !== "string" || (parsed.role !== "creator" && parsed.role !== "joiner") ||
      !Number.isFinite(parsed.expiresAt) || parsed.expiresAt <= Date.now() ||
      !Number.isFinite(parsed.disconnectGraceMs) || parsed.disconnectGraceMs <= 0
    ) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writeLocalSession(session: LocalSession): void {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function randomMessageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // A visible, selectable link remains available below.
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.append(area);
    area.select();
    const copied = document.execCommand("copy");
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

export function App() {
  const [view, setView] = useState<View>("loading");
  const [inviteUrl, setInviteUrl] = useState("");
  const [copyState, setCopyState] = useState<CopyState>("manual");
  const [peerConnected, setPeerConnected] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [graceEndsAt, setGraceEndsAt] = useState(0);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [destroyConfirm, setDestroyConfirm] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [infoPanel, setInfoPanel] = useState<InfoPanel>(null);

  const socketRef = useRef<WebSocket | undefined>(undefined);
  const cryptoRef = useRef<CryptoSession | undefined>(undefined);
  const sessionRef = useRef<LocalSession | null>(null);
  const heartbeatRef = useRef<number | undefined>(undefined);
  const retryRef = useRef<number | undefined>(undefined);
  const retryDeadlineRef = useRef(0);
  const stoppedRef = useRef(false);
  const mountedRef = useRef(true);
  const creatingRef = useRef(false);
  const messageListRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);

  function send(command: ClientCommand): void {
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.send(JSON.stringify(command));
  }

  function clearTimers(): void {
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    if (retryRef.current) window.clearTimeout(retryRef.current);
    heartbeatRef.current = undefined;
    retryRef.current = undefined;
  }

  function goToGone(): void {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    const roomId = sessionRef.current?.roomId || "gone";
    clearTimers();
    cryptoRef.current?.destroy();
    cryptoRef.current = undefined;
    sessionRef.current = null;
    sessionStorage.removeItem(SESSION_KEY);
    sessionStorage.removeItem(LEGACY_SESSION_KEY);
    setMessages([]);
    setDraft("");
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.close();
    window.location.replace(`/r/${encodeURIComponent(roomId)}`);
  }

  function installCrypto(session: LocalSession): CryptoSession {
    cryptoRef.current?.destroy();
    const secure = new CryptoSession(session.role, session.roomId, session.linkSecret, {
      sendRelay: (data) => send({ type: "relay", data }),
      onEstablished: () => {
        if (!mountedRef.current) return;
        setGraceEndsAt(0);
        setNotice("");
        setView("active");
      },
      onMessage: (message) => {
        if (mountedRef.current) setMessages((current) => [...current, { ...message, side: "peer" }]);
      },
      onFatal: () => {
        send({ type: "destroy" });
        window.setTimeout(goToGone, 50);
      }
    });
    cryptoRef.current = secure;
    return secure;
  }

  function handleServerEvent(event: ServerEvent, linkSecret: string): void {
    if (event.type === "room_gone" || event.type === "destroyed") {
      goToGone();
      return;
    }
    if (event.type === "rate_limited") {
      setNotice("Please wait before sending another message.");
      return;
    }
    if (event.type === "session") {
      const existing = sessionRef.current;
      const resumeToken = event.resumeToken || existing?.resumeToken;
      if (!resumeToken) {
        goToGone();
        return;
      }
      const session: LocalSession = {
        roomId: event.roomId,
        role: event.role,
        resumeToken,
        linkSecret,
        expiresAt: event.expiresAt,
        disconnectGraceMs: event.disconnectGraceMs,
        inviteUrl: existing?.inviteUrl
      };
      sessionRef.current = session;
      writeLocalSession(session);
      retryDeadlineRef.current = 0;
      setExpiresAt(event.expiresAt);
      setRemaining(event.expiresAt - Date.now());
      setInviteUrl(event.inviteState === "ACTIVE" ? session.inviteUrl || "" : "");
      setPeerConnected(event.peerConnected);
      setGraceEndsAt(0);
      setNotice("");
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = window.setInterval(() => send({ type: "heartbeat" }), event.heartbeatEveryMs);
      const secure = installCrypto(session);
      if (event.state === "WAITING") setView("waiting");
      else {
        setView("handshaking");
        if (event.role === "creator" && event.peerConnected) secure.startAsCreator();
      }
      return;
    }
    if (event.type === "peer_joined") {
      setInviteUrl("");
      setPeerConnected(true);
      setExpiresAt(event.expiresAt);
      setRemaining(event.expiresAt - Date.now());
      const local = sessionRef.current;
      if (local) {
        local.expiresAt = event.expiresAt;
        delete local.inviteUrl;
        writeLocalSession(local);
      }
      setView("handshaking");
      cryptoRef.current?.startAsCreator();
      return;
    }
    if (event.type === "peer_disconnected") {
      setPeerConnected(false);
      setGraceEndsAt(event.graceEndsAt);
      setNotice("");
      return;
    }
    if (event.type === "peer_resumed") {
      setPeerConnected(true);
      setGraceEndsAt(0);
      setNotice("");
      setView("handshaking");
      cryptoRef.current?.reset();
      if (sessionRef.current?.role === "creator") cryptoRef.current?.startAsCreator();
      return;
    }
    if (event.type === "relay") cryptoRef.current?.handleRelay(event.data);
  }

  function connect(auth: Extract<ClientCommand, { type: "resume" | "join" }>, linkSecret: string): void {
    stoppedRef.current = false;
    setView((current) => current === "waiting" || current === "active" ? current : "connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/ws`);
    socketRef.current = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify(auth)));
    socket.addEventListener("message", (message) => {
      let event: ServerEvent;
      try {
        event = JSON.parse(String(message.data)) as ServerEvent;
      } catch {
        send({ type: "destroy" });
        goToGone();
        return;
      }
      handleServerEvent(event, linkSecret);
    });
    socket.addEventListener("close", () => {
      if (socketRef.current !== socket || stoppedRef.current) return;
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = undefined;
      const local = sessionRef.current;
      if (!local) {
        goToGone();
        return;
      }
      const now = Date.now();
      if (!retryDeadlineRef.current) retryDeadlineRef.current = now + local.disconnectGraceMs - 250;
      if (now >= retryDeadlineRef.current) {
        goToGone();
        return;
      }
      setGraceEndsAt(retryDeadlineRef.current);
      setView("reconnecting");
      retryRef.current = window.setTimeout(() => {
        connect({ type: "resume", roomId: local.roomId, resumeToken: local.resumeToken }, local.linkSecret);
      }, 750);
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    void (async () => {
      if (window.location.pathname === "/security") {
        document.title = "Security — 410";
        setView("security");
        return;
      }
      await sodiumReady();
      sessionStorage.removeItem(LEGACY_SESSION_KEY);
      const match = window.location.pathname.match(INVITE_PATH);
      const linkSecret = new URLSearchParams(window.location.hash.slice(1)).get("secret");
      if (match) {
        if (!linkSecret) {
          goToGone();
          return;
        }
        window.history.replaceState(null, "", "/");
        setView("connecting");
        connect({ type: "join", inviteToken: match[1] }, linkSecret);
        return;
      }
      const existing = readLocalSession();
      if (existing) {
        sessionRef.current = existing;
        setInviteUrl(existing.inviteUrl || "");
        setView("connecting");
        connect({ type: "resume", roomId: existing.roomId, resumeToken: existing.resumeToken }, existing.linkSecret);
      } else {
        sessionStorage.removeItem(SESSION_KEY);
        setView("landing");
      }
    })().catch(goToGone);
    return () => {
      mountedRef.current = false;
      clearTimers();
      cryptoRef.current?.destroy();
      socketRef.current?.close();
    };
    // The document boot sequence intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (expiresAt) setRemaining(expiresAt - Date.now());
    }, 250);
    return () => window.clearInterval(timer);
  }, [expiresAt, graceEndsAt]);

  const isConversationView = view === "handshaking" || view === "active" || view === "reconnecting";

  useEffect(() => {
    document.documentElement.classList.toggle("conversation-active", isConversationView);
    return () => document.documentElement.classList.remove("conversation-active");
  }, [isConversationView]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (list && shouldAutoScrollRef.current) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  function updateScrollPreference(): void {
    const list = messageListRef.current;
    if (!list) return;
    const distanceFromBottom = list.scrollHeight - list.scrollTop - list.clientHeight;
    shouldAutoScrollRef.current = distanceFromBottom <= AUTO_SCROLL_THRESHOLD;
  }

  function currentTrafficSource(): string {
    const known = new Set([
      "direct",
      "pikabu",
      "habr",
      "vc",
      "dev",
      "producthunt",
      "reddit",
      "hn",
      "telegram",
      "google",
      "yandex",
      "other"
    ]);

    const explicit = new URLSearchParams(window.location.search)
      .get("from")
      ?.trim()
      .toLowerCase();

    if (explicit) return known.has(explicit) ? explicit : "other";
    if (!document.referrer) return "direct";

    try {
      const referrerUrl = new URL(document.referrer);
      const host = referrerUrl.hostname.toLowerCase();

      if (referrerUrl.hostname.toLowerCase() === window.location.hostname.toLowerCase()) return "direct";
      if (host === "pikabu.ru" || host.endsWith(".pikabu.ru")) return "pikabu";
      if (host === "habr.com" || host.endsWith(".habr.com")) return "habr";
      if (host === "vc.ru" || host.endsWith(".vc.ru")) return "vc";
      if (host === "dev.to" || host.endsWith(".dev.to")) return "dev";
      if (host === "producthunt.com" || host.endsWith(".producthunt.com")) return "producthunt";
      if (host === "reddit.com" || host.endsWith(".reddit.com")) return "reddit";
      if (host === "news.ycombinator.com") return "hn";
      if (
        host === "t.me" ||
        host.endsWith(".t.me") ||
        host === "telegram.me" ||
        host.endsWith(".telegram.me")
      ) return "telegram";

      if (
        host === "google.com" ||
        host.startsWith("google.") ||
        host.startsWith("www.google.")
      ) return "google";

      if (
        host === "yandex.ru" ||
        host.startsWith("yandex.") ||
        host.startsWith("www.yandex.")
      ) return "yandex";

      return "other";
    } catch {
      return "other";
    }
  }

  async function startConversation(): Promise<void> {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setView("creating");
    setNotice("");
    try {
      await sodiumReady();
      const linkSecret = createLinkSecret();
      const response = await fetch("/api/rooms", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-410-Source": currentTrafficSource()
        },
        body: "{}"
      });
      if (response.status === 429) {
        setNotice("Too many conversations were created from this connection. Please try again later.");
        setView("landing");
        creatingRef.current = false;
        return;
      }
      if (!response.ok) throw new Error("creation failed");
      const created = await response.json() as { roomId: string; inviteToken: string; resumeToken: string; expiresAt: number };
      const url = `${window.location.origin}/r/${encodeURIComponent(created.inviteToken)}#secret=${encodeURIComponent(linkSecret)}`;
      const local: LocalSession = {
        roomId: created.roomId,
        role: "creator",
        resumeToken: created.resumeToken,
        linkSecret,
        expiresAt: created.expiresAt,
        disconnectGraceMs: 15_000,
        inviteUrl: url
      };
      sessionRef.current = local;
      writeLocalSession(local);
      setInviteUrl(url);
      setCopyState(await copyText(url) ? "copied" : "manual");
      connect({ type: "resume", roomId: created.roomId, resumeToken: created.resumeToken }, linkSecret);
    } catch {
      creatingRef.current = false;
      setNotice("The conversation could not be created. Please try again.");
      setView("landing");
    }
  }

  function sendMessage(): void {
    const text = draft.trim();
    if (!text || text.length > 2000 || view !== "active" || !peerConnected) return;
    const message: ChatMessage = { id: randomMessageId(), text, sentAt: Date.now(), side: "self" };
    try {
      const data = cryptoRef.current?.encryptMessage(message);
      if (!data) return;
      send({ type: "relay", data });
      setMessages((current) => [...current, message]);
      setDraft("");
      setNotice("");
    } catch {
      setNotice("The secure session is unavailable.");
    }
  }

  async function copyInvite(): Promise<void> {
    setCopyState(await copyText(inviteUrl) ? "copied" : "manual");
  }

  function confirmDestroy(): void {
    setDestroying(true);
    setDestroyConfirm(false);
    send({ type: "destroy" });
    window.setTimeout(goToGone, 500);
  }

  if (view === "loading" || view === "creating" || view === "connecting") {
    return (
      <main className="simple-page" aria-live="polite">
        <div className="simple-content loading-content">
          <Logo />
          <p>{view === "creating" ? "Creating…" : view === "connecting" ? "Connecting…" : "Preparing…"}</p>
        </div>
      </main>
    );
  }

  if (view === "security") return <SecurityPage />;

  if (view === "landing") {
    return (
      <main className="simple-page start-page">
        <section className="start-content">
          <Logo />
          <h1 className="start-headline">
            <span>One link.</span>
            <span>Two people.</span>
            <span>Gone.</span>
          </h1>
          <p className="intro start-intro">A private conversation that exists once.<br />No account. No history.</p>
          <button className="primary-action" type="button" onClick={startConversation}>Start</button>
          {notice && <p className="error-text" role="status">{notice}</p>}
          <p className="start-technical">E2E encrypted · 2 people · 30 minutes</p>
          <SecurityLink onOpen={() => setInfoPanel("security")} />
        </section>
        <InfoDialog panel={infoPanel} onClose={() => setInfoPanel(null)} />
      </main>
    );
  }

  if (view === "waiting") {
    return (
      <main className="simple-page">
        <section className="waiting-content">
          <Logo />
          <p className="copy-result" role="status">{copyState === "copied" ? "Link copied." : "Link ready."}</p>
          <h1>Share this link with one person.</h1>
          <p className="intro">The conversation starts when they join.</p>
          <div className="invite-line">
            <input aria-label="One-time conversation link" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={copyInvite} aria-label="Copy invite link" title="Copy link"><span aria-hidden="true">⧉</span></button>
          </div>
          {copyState === "manual" && <p className="manual-copy">Clipboard access is unavailable. Copy the link manually.</p>}
          <p className="waiting-status"><span aria-hidden="true">●</span> Waiting for one person.</p>
          <p className="ttl-note">This room will be destroyed<br />30 minutes after the conversation starts.</p>
          <InfoLinks onOpen={setInfoPanel} />
        </section>
        <InfoDialog panel={infoPanel} onClose={() => setInfoPanel(null)} />
      </main>
    );
  }

  const graceRemaining = graceEndsAt > Date.now() ? graceEndsAt - Date.now() : 0;
  const isReady = view === "active" && peerConnected;

  return (
    <main className="conversation-page">
      <header className="session-header">
        <span>Session ends in {formatRemaining(remaining)}</span>
        <button type="button" onClick={() => setDestroyConfirm(true)}>Destroy</button>
      </header>

      {(graceRemaining > 0 || view === "handshaking" || view === "reconnecting" || notice) && (
        <section className="connection-state" role="status">
          {graceRemaining > 0 ? (
            <><strong>Connection lost.</strong><span>This conversation will be gone in {formatRemaining(graceRemaining)}</span></>
          ) : view === "handshaking" ? (
            <span>Securing connection…</span>
          ) : view === "reconnecting" ? (
            <span>Reconnecting…</span>
          ) : (
            <span>{notice}</span>
          )}
        </section>
      )}

      <section
        ref={messageListRef}
        className="message-list"
        aria-label="Conversation"
        aria-live="polite"
        onScroll={updateScrollPreference}
      >
        {messages.map((message, index) => (
          <article key={message.id} className={`message ${message.side}`} data-last-message={index === messages.length - 1 ? "true" : undefined}>
            <p>{message.text}</p>
            <time dateTime={new Date(message.sentAt).toISOString()}>
              {new Date(message.sentAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            </time>
          </article>
        ))}
      </section>

      <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
        <label className="sr-only" htmlFor="message">Message</label>
        <textarea
          id="message"
          value={draft}
          maxLength={2000}
          rows={1}
          placeholder={isReady ? "Message" : "Waiting for connection"}
          disabled={!isReady}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || !isReady}>Send</button>
      </form>

      {destroyConfirm && (
        <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setDestroyConfirm(false);
        }}>
          <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="destroy-title">
            <h2 id="destroy-title">Destroy this conversation?</h2>
            <p>This cannot be undone.</p>
            <div>
              <button type="button" onClick={() => setDestroyConfirm(false)}>Cancel</button>
              <button className="danger-action" type="button" onClick={confirmDestroy} disabled={destroying}>Destroy</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}

function Logo() {
  return <div className="logo" aria-label="410">410</div>;
}

function SecurityPage() {
  return (
    <main className="security-page">
      <article className="security-document">
        <header className="security-header">
          <a className="security-brand" href="/" aria-label="410">410</a>
        </header>

        <h1>Security</h1>
        <p className="security-introduction">410 is designed for one-time conversations between two browsers.</p>

        <section aria-labelledby="security-messages">
          <h2 id="security-messages">Messages</h2>
          <p>Messages are end-to-end encrypted in the browsers before they are relayed.</p>
          <p>The server does not receive message plaintext or the session encryption keys.</p>
        </section>

        <section aria-labelledby="security-server-visibility">
          <h2 id="security-server-visibility">What the server can see</h2>
          <p>The server necessarily sees network metadata required to operate the service, including IP addresses, connection timing and encrypted network traffic.</p>
          <p>The relay also processes the protocol metadata necessary to establish and operate a conversation.</p>
        </section>

        <section aria-labelledby="security-not-kept">
          <h2 id="security-not-kept">What is not kept</h2>
          <p>410 does not keep conversation history, message plaintext, accounts or contact lists.</p>
          <p>Active rooms exist in server memory and disappear when they are destroyed, expire, or when the service process restarts.</p>
        </section>

        <section aria-labelledby="security-lifetime">
          <h2 id="security-lifetime">Lifetime</h2>
          <p>A conversation has exactly two participants.</p>
          <p>An unused invite expires after 30 minutes.</p>
          <p>Once the second participant joins, the conversation can exist for up to 30 minutes.</p>
          <p>A consumed invite cannot be reused by another participant.</p>
          <p>If a participant disconnects, the conversation allows the existing reconnect grace period before it is destroyed.</p>
        </section>

        <section aria-labelledby="security-destruction">
          <h2 id="security-destruction">After destruction</h2>
          <p>When a conversation is gone, the room is no longer available.</p>
          <p>Requests to its conversation URL return HTTP 410 Gone.</p>
          <p>410 does not keep a conversation archive or a recoverable history of destroyed rooms.</p>
        </section>

        <section aria-labelledby="security-analytics">
          <h2 id="security-analytics">Analytics</h2>
          <p>410 keeps aggregate service counters such as the number of rooms created, conversations started and encrypted chat messages relayed.</p>
          <p>These aggregate metrics may include a coarse traffic source such as Google or Pikabu, but never the full referrer URL. They do not contain message contents, room identifiers, invite tokens, user identifiers, IP addresses or User-Agent values.</p>
          <p>They are used to understand whether the service is functioning and being used.</p>
        </section>

        <section aria-labelledby="security-limitations">
          <h2 id="security-limitations">Limitations</h2>
          <p>The other participant can copy, screenshot or record anything they receive.</p>
          <p>410 cannot prevent information from being saved outside the service.</p>
          <p>Because 410 is a web application, a compromised server could theoretically serve a modified client to a browser.</p>
          <p>The current cryptographic protocol has not undergone an independent security audit.</p>
          <p>410 should not be treated as a guarantee of anonymity.</p>
        </section>
      </article>
    </main>
  );
}

function SecurityLink({ onOpen }: { onOpen: () => void }) {
  return <a className="start-security" href="#security" onClick={(event) => { event.preventDefault(); onOpen(); }}>Security →</a>;
}

function InfoLinks({ onOpen }: { onOpen: (panel: Exclude<InfoPanel, null>) => void }) {
  return (
    <nav className="info-links" aria-label="Information">
      <button type="button" onClick={() => onOpen("how")}>How it works</button>
      <span aria-hidden="true">|</span>
      <button type="button" onClick={() => onOpen("security")}>Security</button>
    </nav>
  );
}

function InfoDialog({ panel, onClose }: { panel: InfoPanel; onClose: () => void }) {
  if (!panel) return null;
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="info-dialog" role="dialog" aria-modal="true" aria-labelledby="info-title">
        <h2 id="info-title">{panel === "how" ? "How it works" : "Security"}</h2>
        <p>{panel === "how"
          ? "One link admits one other browser. The link is consumed when they enter. When the session ends, its in-memory room state is removed."
          : <>Messages are encrypted in the browsers before being relayed.<br />The server does not receive message plaintext.<br />Your peer can still copy or record what they see.</>}</p>
        <div className="info-dialog-actions">
          {panel === "security" && <a href="/security">Details →</a>}
          <button type="button" onClick={onClose}>Close</button>
        </div>
      </section>
    </div>
  );
}

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { GroupClientCommand, GroupServerEvent } from "../../shared/group-protocol.js";
import {
  GroupCryptoError,
  GroupCryptoSession,
  groupSodiumReady,
  isRecoverableGroupCryptoError,
  type GroupDecryptedMessage
} from "./group-crypto-session";
import { QrInviteDialog } from "./QrInviteDialog";

type GroupView = "connecting" | "rekeying" | "active" | "reconnecting" | "full";
type CopyState = "idle" | "copied" | "manual";

interface StoredGroupSession {
  version: 1;
  roomId?: string;
  inviteToken: string;
  linkSecret: string;
  ownerCapability?: string;
  memberId?: string;
  resumeToken?: string;
  expiresAt: number;
  disconnectGraceMs?: number;
  showInviteOnLoad?: boolean;
}

export interface CreatedGroupSession {
  roomId: string;
  inviteToken: string;
  linkSecret: string;
  ownerCapability: string;
  expiresAt: number;
}

interface GroupMessage {
  id: string;
  text: string;
  sentAt: number;
  side: "self" | "peer";
}

interface PendingRelay {
  relayId: string;
  message: GroupMessage;
}

const GROUP_SESSION_KEY = "410.group.session.v1";
const GROUP_INVITE_PATH = /^\/g\/([A-Za-z0-9_-]{43})$/;
const AUTO_SCROLL_THRESHOLD = 80;
const MAX_RENDERED_MESSAGES = 500;
const MAX_DATE_MS = 8_640_000_000_000_000;

function appendBoundedMessage(messages: GroupMessage[], message: GroupMessage): GroupMessage[] {
  if (messages.length < MAX_RENDERED_MESSAGES) return [...messages, message];
  return [...messages.slice(-(MAX_RENDERED_MESSAGES - 1)), message];
}

export function storeCreatedGroup(created: CreatedGroupSession): void {
  const session: StoredGroupSession = {
    version: 1,
    ...created,
    showInviteOnLoad: true
  };
  sessionStorage.setItem(GROUP_SESSION_KEY, JSON.stringify(session));
}

function readStoredGroup(inviteToken: string): StoredGroupSession | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(GROUP_SESSION_KEY) || "null") as Partial<StoredGroupSession> | null;
    if (
      !value || value.version !== 1 || value.inviteToken !== inviteToken ||
      typeof value.linkSecret !== "string" || !Number.isFinite(value.expiresAt)
    ) return null;
    return value as StoredGroupSession;
  } catch {
    return null;
  }
}

function writeStoredGroup(session: StoredGroupSession): void {
  sessionStorage.setItem(GROUP_SESSION_KEY, JSON.stringify(session));
}

function clearStoredGroup(): void {
  sessionStorage.removeItem(GROUP_SESSION_KEY);
}

function formatRemaining(milliseconds: number): string {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60).toString().padStart(2, "0");
  const seconds = (totalSeconds % 60).toString().padStart(2, "0");
  return hours > 0 ? `${hours}:${minutes}:${seconds}` : `${minutes}:${seconds}`;
}

function randomMessageId(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function randomRelayId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function safeMessageTime(sentAt: number): { dateTime?: string; label: string } {
  if (!Number.isSafeInteger(sentAt) || sentAt < 0 || sentAt > MAX_DATE_MS) {
    return { label: "Time unavailable" };
  }
  try {
    const date = new Date(sentAt);
    return {
      dateTime: date.toISOString(),
      label: date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    };
  } catch {
    return { label: "Time unavailable" };
  }
}

async function copyText(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // The selectable input remains available.
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

export function GroupRoomApp() {
  const tokenMatch = window.location.pathname.match(GROUP_INVITE_PATH);
  const inviteToken = tokenMatch?.[1] || "";
  const [view, setView] = useState<GroupView>("connecting");
  const [presenceCount, setPresenceCount] = useState(0);
  const [maxParticipants, setMaxParticipants] = useState(10);
  const [ownerAuthorized, setOwnerAuthorized] = useState(false);
  const [expiresAt, setExpiresAt] = useState(0);
  const [remaining, setRemaining] = useState(0);
  const [messages, setMessages] = useState<GroupMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [qrOpen, setQrOpen] = useState(false);
  const [destroyConfirm, setDestroyConfirm] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [sendPending, setSendPending] = useState(false);

  const socketRef = useRef<WebSocket | undefined>(undefined);
  const cryptoRef = useRef<GroupCryptoSession | undefined>(undefined);
  const cryptoMemberIdRef = useRef("");
  const sessionRef = useRef<StoredGroupSession | null>(null);
  const heartbeatRef = useRef<number | undefined>(undefined);
  const retryRef = useRef<number | undefined>(undefined);
  const retryDeadlineRef = useRef(0);
  const stoppedRef = useRef(false);
  const fullRef = useRef(false);
  const resumeFallbackRef = useRef(false);
  const eventChainRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  const messageListRef = useRef<HTMLElement | null>(null);
  const shouldAutoScrollRef = useRef(true);
  const qrTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingRelayRef = useRef<PendingRelay | null>(null);

  const closeQr = useCallback(() => setQrOpen(false), []);
  const inviteUrl = sessionRef.current
    ? `${window.location.origin}/g/${encodeURIComponent(sessionRef.current.inviteToken)}#secret=${encodeURIComponent(sessionRef.current.linkSecret)}`
    : "";

  function clearTimers(): void {
    if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
    if (retryRef.current) window.clearTimeout(retryRef.current);
    heartbeatRef.current = undefined;
    retryRef.current = undefined;
  }

  function send(command: GroupClientCommand): boolean {
    if (socketRef.current?.readyState !== WebSocket.OPEN) return false;
    try {
      socketRef.current.send(JSON.stringify(command));
      return true;
    } catch {
      return false;
    }
  }

  function goToGone(): void {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    clearTimers();
    clearStoredGroup();
    sessionRef.current = null;
    cryptoRef.current?.destroy();
    cryptoRef.current = undefined;
    cryptoMemberIdRef.current = "";
    setMessages([]);
    setDraft("");
    pendingRelayRef.current = null;
    setSendPending(false);
    if (socketRef.current?.readyState === WebSocket.OPEN) socketRef.current.close();
    window.location.replace(inviteToken ? `/g/${encodeURIComponent(inviteToken)}` : "/g/gone");
  }

  function createCrypto(roomId: string, memberId: string, linkSecret: string): GroupCryptoSession {
    cryptoRef.current?.destroy();
    pendingRelayRef.current = null;
    setSendPending(false);
    cryptoMemberIdRef.current = memberId;
    const cryptoSession = new GroupCryptoSession({
      roomId,
      selfMemberId: memberId,
      linkSecret,
      callbacks: {
        sendControl: (control) => {
          send({ type: "group_control", ...control });
        },
        sendReady: (ready) => {
          send({ type: "group_ready", ...ready });
        },
        onActive: () => {
          if (!mountedRef.current || stoppedRef.current) return;
          setNotice("");
          setView("active");
        },
        onMessage: (message: GroupDecryptedMessage, senderMemberId: string) => {
          if (!mountedRef.current || stoppedRef.current) return;
          setMessages((current) => appendBoundedMessage(current, {
            ...message,
            id: `${senderMemberId}:${message.id}`,
            side: "peer"
          }));
        }
      }
    });
    cryptoRef.current = cryptoSession;
    return cryptoSession;
  }

  async function beginEpoch(event: Extract<GroupServerEvent, { type: "group_session" | "group_epoch" }>): Promise<void> {
    const local = sessionRef.current;
    if (!local?.roomId || !local.memberId) throw new Error("Missing group session");
    const cryptoSession = !cryptoRef.current || cryptoMemberIdRef.current !== local.memberId
      ? createCrypto(local.roomId, local.memberId, local.linkSecret)
      : cryptoRef.current;
    await cryptoSession.beginEpoch({
      epoch: event.epoch,
      epochNonce: event.epochNonce,
      rosterDigest: event.rosterDigest,
      members: event.members
    });
  }

  async function handleServerEvent(
    event: GroupServerEvent,
    authType: "group_join" | "group_resume"
  ): Promise<void> {
    if (event.type === "group_destroyed") {
      goToGone();
      return;
    }
    if (event.type === "group_room_gone") {
      const local = sessionRef.current;
      if (authType === "group_resume" && local && !resumeFallbackRef.current) {
        resumeFallbackRef.current = true;
        connect({
          type: "group_join",
          inviteToken: local.inviteToken,
          ownerCapability: local.ownerCapability
        });
        return;
      }
      goToGone();
      return;
    }
    if (event.type === "group_room_full") {
      fullRef.current = true;
      setMaxParticipants(event.maxParticipants);
      setView("full");
      return;
    }
    if (event.type === "group_forbidden") {
      setDestroying(false);
      setNotice("This browser is not authorized to destroy the room.");
      return;
    }
    if (event.type === "group_rate_limited") {
      setNotice("Secure setup traffic was rate limited. Please wait.");
      return;
    }
    if (event.type === "group_protocol_error") {
      setNotice("The secure room could not be synchronized.");
      return;
    }
    if (event.type === "group_relay_accepted") {
      const pending = pendingRelayRef.current;
      if (!pending || pending.relayId !== event.relayId) return;
      cryptoRef.current?.commitOutbound();
      pendingRelayRef.current = null;
      setSendPending(false);
      setMessages((current) => appendBoundedMessage(current, pending.message));
      setNotice("");
      return;
    }
    if (event.type === "group_relay_rejected") {
      const pending = pendingRelayRef.current;
      if (!pending || pending.relayId !== event.relayId) return;
      cryptoRef.current?.rejectOutbound();
      pendingRelayRef.current = null;
      setSendPending(false);
      setNotice("Message was not sent. Please try again.");
      return;
    }
    if (event.type === "group_epoch_failed") {
      setView("rekeying");
      setNotice("Secure setup did not complete. Waiting for participants.");
      return;
    }
    if (event.type === "group_presence") {
      setPresenceCount(event.presenceCount);
      return;
    }
    if (event.type === "group_session") {
      const existing = sessionRef.current;
      if (!existing) return;
      const session: StoredGroupSession = {
        ...existing,
        roomId: event.roomId,
        memberId: event.memberId,
        resumeToken: event.resumeToken,
        expiresAt: event.expiresAt,
        disconnectGraceMs: event.disconnectGraceMs,
        showInviteOnLoad: false
      };
      sessionRef.current = session;
      writeStoredGroup(session);
      retryDeadlineRef.current = 0;
      resumeFallbackRef.current = false;
      fullRef.current = false;
      setOwnerAuthorized(event.ownerAuthorized);
      setPresenceCount(event.presenceCount);
      setMaxParticipants(event.maxParticipants);
      setExpiresAt(event.expiresAt);
      setRemaining(event.expiresAt - Date.now());
      setShareOpen(existing.showInviteOnLoad === true);
      setNotice("");
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = window.setInterval(() => send({ type: "heartbeat" }), event.heartbeatEveryMs);
      setView("rekeying");
      await beginEpoch(event);
      return;
    }
    if (event.type === "group_epoch") {
      cryptoRef.current?.rejectOutbound();
      pendingRelayRef.current = null;
      setSendPending(false);
      setView("rekeying");
      setNotice("");
      await beginEpoch(event);
      return;
    }
    if (event.type === "group_epoch_ready") {
      try {
        cryptoRef.current?.handleEpochReady(event);
      } catch (error) {
        if (!isRecoverableGroupCryptoError(error)) throw error;
      }
      return;
    }
    if (event.type === "group_control") {
      try {
        cryptoRef.current?.handleControl(event);
      } catch (error) {
        if (!isRecoverableGroupCryptoError(error)) throw error;
      }
      return;
    }
    if (event.type === "group_relay") {
      try {
        cryptoRef.current?.handleApplication(event);
      } catch (error) {
        if (!isRecoverableGroupCryptoError(error)) throw error;
      }
    }
  }

  function connect(auth: Extract<GroupClientCommand, { type: "group_join" | "group_resume" }>): void {
    stoppedRef.current = false;
    fullRef.current = false;
    setView((current) => current === "active" ? current : "connecting");
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/group-ws`);
    socketRef.current = socket;
    socket.addEventListener("open", () => socket.send(JSON.stringify(auth)));
    socket.addEventListener("message", (message) => {
      let event: GroupServerEvent;
      try {
        event = JSON.parse(String(message.data)) as GroupServerEvent;
      } catch {
        socket.close(4400, "invalid event");
        return;
      }
      eventChainRef.current = eventChainRef.current
        .then(() => handleServerEvent(event, auth.type))
        .catch(() => {
          if (!mountedRef.current || stoppedRef.current) return;
          setNotice("The secure room could not be synchronized.");
          setView("reconnecting");
          socket.close(4400, "group cryptographic error");
        });
    });
    socket.addEventListener("close", (event) => {
      if (socketRef.current !== socket || stoppedRef.current || fullRef.current) return;
      if (event.code === 4001) {
        stoppedRef.current = true;
        clearTimers();
        setNotice("This live session continued in another tab.");
        setView("reconnecting");
        return;
      }
      if (heartbeatRef.current) window.clearInterval(heartbeatRef.current);
      heartbeatRef.current = undefined;
      if (pendingRelayRef.current) {
        cryptoRef.current?.rejectOutbound();
        pendingRelayRef.current = null;
        setSendPending(false);
        setNotice("Message delivery was not confirmed.");
      }
      const local = sessionRef.current;
      if (!local) return;
      const now = Date.now();
      if (!retryDeadlineRef.current) retryDeadlineRef.current = now + (local.disconnectGraceMs || 15_000) - 250;
      setView("reconnecting");
      retryRef.current = window.setTimeout(() => {
        const current = sessionRef.current;
        if (!current) return;
        if (Date.now() < retryDeadlineRef.current && current.roomId && current.memberId && current.resumeToken) {
          connect({
            type: "group_resume",
            roomId: current.roomId,
            memberId: current.memberId,
            resumeToken: current.resumeToken,
            ownerCapability: current.ownerCapability
          });
        } else {
          delete current.memberId;
          delete current.resumeToken;
          writeStoredGroup(current);
          connect({ type: "group_join", inviteToken: current.inviteToken, ownerCapability: current.ownerCapability });
        }
      }, 750);
    });
  }

  useEffect(() => {
    mountedRef.current = true;
    document.title = "Room — 410";
    void (async () => {
      await groupSodiumReady();
      if (!mountedRef.current) return;
      const hashSecret = new URLSearchParams(window.location.hash.slice(1)).get("secret");
      const stored = readStoredGroup(inviteToken);
      const linkSecret = hashSecret || stored?.linkSecret;
      if (!inviteToken || !linkSecret) {
        window.location.replace("/g/gone");
        return;
      }
      const session: StoredGroupSession = stored || {
        version: 1,
        inviteToken,
        linkSecret,
        expiresAt: Number.MAX_SAFE_INTEGER
      };
      session.linkSecret = linkSecret;
      sessionRef.current = session;
      writeStoredGroup(session);
      window.history.replaceState(null, "", window.location.pathname);
      if (session.roomId && session.memberId && session.resumeToken) {
        connect({
          type: "group_resume",
          roomId: session.roomId,
          memberId: session.memberId,
          resumeToken: session.resumeToken,
          ownerCapability: session.ownerCapability
        });
      } else {
        connect({ type: "group_join", inviteToken, ownerCapability: session.ownerCapability });
      }
    })().catch(() => goToGone());
    return () => {
      mountedRef.current = false;
      stoppedRef.current = true;
      clearTimers();
      socketRef.current?.close();
      cryptoRef.current?.destroy();
      cryptoRef.current = undefined;
    };
    // The group document boot sequence intentionally runs once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    document.documentElement.classList.add("conversation-active");
    return () => document.documentElement.classList.remove("conversation-active");
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (expiresAt) setRemaining(expiresAt - Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  useLayoutEffect(() => {
    const list = messageListRef.current;
    if (list && shouldAutoScrollRef.current) list.scrollTop = list.scrollHeight;
  }, [messages.length]);

  function updateScrollPreference(): void {
    const list = messageListRef.current;
    if (!list) return;
    shouldAutoScrollRef.current = list.scrollHeight - list.scrollTop - list.clientHeight <= AUTO_SCROLL_THRESHOLD;
  }

  function sendMessage(): void {
    const text = draft.trim();
    if (
      !text || text.length > 2000 || view !== "active" || presenceCount < 2 ||
      pendingRelayRef.current
    ) return;
    const message: GroupMessage = {
      id: randomMessageId(),
      text,
      sentAt: Date.now(),
      side: "self"
    };
    try {
      const relayId = randomRelayId();
      const encrypted = cryptoRef.current?.encryptMessage({
        id: message.id,
        text: message.text,
        sentAt: message.sentAt
      });
      if (!encrypted) throw new GroupCryptoError("Missing encrypted relay");
      pendingRelayRef.current = { relayId, message };
      setSendPending(true);
      if (!send({ type: "group_relay", relayId, ...encrypted })) throw new Error("send failed");
      setDraft("");
    } catch {
      cryptoRef.current?.rejectOutbound();
      pendingRelayRef.current = null;
      setSendPending(false);
      setNotice("The secure room is resynchronizing.");
      setView("reconnecting");
      socketRef.current?.close(4400, "group send failed");
    }
  }

  async function copyInvite(): Promise<void> {
    if (!inviteUrl) return;
    setCopyState(await copyText(inviteUrl) ? "copied" : "manual");
  }

  function requestDestroy(): void {
    const local = sessionRef.current;
    if (!local?.ownerCapability || !local.roomId) return;
    const { ownerCapability, roomId } = local;
    setDestroying(true);
    setDestroyConfirm(false);
    if (socketRef.current?.readyState === WebSocket.OPEN && ownerAuthorized) {
      send({ type: "group_destroy", ownerCapability });
      return;
    }
    const scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${window.location.host}/group-ws`);
    socket.addEventListener("open", () => socket.send(JSON.stringify({
      type: "group_owner_destroy",
      roomId,
      ownerCapability
    } satisfies GroupClientCommand)));
    socket.addEventListener("message", (message) => {
      const event = JSON.parse(String(message.data)) as GroupServerEvent;
      if (event.type === "group_destroyed" || event.type === "group_room_gone") goToGone();
      else if (event.type === "group_forbidden") {
        setDestroying(false);
        setNotice("This browser is not authorized to destroy the room.");
      }
    });
  }

  if (view === "connecting") {
    return (
      <main className="simple-page" aria-live="polite">
        <div className="simple-content loading-content"><GroupLogo /><p>Joining room…</p></div>
      </main>
    );
  }

  if (view === "full") {
    return (
      <main className="simple-page">
        <section className="simple-content group-full-content">
          <GroupLogo />
          <h1>Room is full.</h1>
          <p>This room already has {maxParticipants} people.</p>
          {sessionRef.current?.ownerCapability && (
            <button type="button" onClick={() => setDestroyConfirm(true)}>Destroy room</button>
          )}
          {notice && <p role="status">{notice}</p>}
        </section>
        {destroyConfirm && <DestroyRoomDialog destroying={destroying} onCancel={() => setDestroyConfirm(false)} onDestroy={requestDestroy} />}
      </main>
    );
  }

  const canSend = view === "active" && presenceCount >= 2 && !sendPending;
  const peopleText = `${presenceCount} ${presenceCount === 1 ? "person" : "people"} here`;

  return (
    <main className="group-room-page">
      <header className="group-room-header">
        <div className="group-room-summary">
          <strong className="group-room-label">ROOM</strong>
          <span className="group-presence" aria-live="polite">{peopleText}</span>
        </div>
        <div className="group-room-actions">
          <span>Ends in {formatRemaining(remaining)}</span>
          <button type="button" onClick={() => setShareOpen((current) => !current)} aria-expanded={shareOpen}>Invite</button>
          {ownerAuthorized && <button className="group-destroy" type="button" onClick={() => setDestroyConfirm(true)}>Destroy room</button>}
        </div>
      </header>

      {shareOpen && (
        <section className="group-invite-panel" aria-label="Room invite">
          <p>Share this link with people you want in the room.</p>
          <div className="group-invite-row">
            <input aria-label="Reusable room link" readOnly value={inviteUrl} onFocus={(event) => event.currentTarget.select()} />
            <button type="button" onClick={copyInvite}>Copy</button>
            <button ref={qrTriggerRef} type="button" onClick={() => setQrOpen(true)}>Show QR</button>
          </div>
          {copyState !== "idle" && (
            <p className="group-copy-state" role="status">{copyState === "copied" ? "Link copied." : "Clipboard access is unavailable. Copy the link manually."}</p>
          )}
        </section>
      )}

      {(view !== "active" || notice) && (
        <section className="connection-state" role="status">
          <span>{notice || (view === "reconnecting" ? "Reconnecting…" : "Securing room…")}</span>
        </section>
      )}

      <section
        ref={messageListRef}
        className="message-list"
        aria-label="Room conversation"
        aria-live="polite"
        onScroll={updateScrollPreference}
      >
        {messages.length === 0 && <p className="group-empty-note">Messages are visible only from the moment you join.</p>}
        {messages.map((message, index) => (
          <article key={message.id} className={`message ${message.side}`} data-last-message={index === messages.length - 1 ? "true" : undefined}>
            <p>{message.text}</p>
            <MessageTime sentAt={message.sentAt} />
          </article>
        ))}
      </section>

      <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
        <label className="sr-only" htmlFor="group-message">Message</label>
        <textarea
          id="group-message"
          value={draft}
          maxLength={2000}
          rows={1}
          placeholder={canSend ? "Message" : view === "active" ? "Waiting for someone" : "Securing room"}
          disabled={!canSend}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              sendMessage();
            }
          }}
        />
        <button type="submit" disabled={!draft.trim() || !canSend}>Send</button>
      </form>

      {destroyConfirm && <DestroyRoomDialog destroying={destroying} onCancel={() => setDestroyConfirm(false)} onDestroy={requestDestroy} />}
      {qrOpen && inviteUrl && (
        <QrInviteDialog
          inviteUrl={inviteUrl}
          note="This invite works while the room exists."
          onClose={closeQr}
          returnFocusRef={qrTriggerRef}
        />
      )}
    </main>
  );
}

function GroupLogo() {
  return <div className="logo" aria-label="410">410</div>;
}

function MessageTime({ sentAt }: { sentAt: number }) {
  const formatted = safeMessageTime(sentAt);
  return <time dateTime={formatted.dateTime}>{formatted.label}</time>;
}

function DestroyRoomDialog({ destroying, onCancel, onDestroy }: {
  destroying: boolean;
  onCancel: () => void;
  onDestroy: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !destroying) onCancel();
    }}>
      <section className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="destroy-room-title">
        <h2 id="destroy-room-title">Destroy this room?</h2>
        <p>This cannot be undone.</p>
        <div>
          <button type="button" onClick={onCancel} disabled={destroying}>Cancel</button>
          <button className="danger-action" type="button" onClick={onDestroy} disabled={destroying}>Destroy room</button>
        </div>
      </section>
    </div>
  );
}

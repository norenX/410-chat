import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  GROUP_PERSONA_COLORS,
  type GroupClientCommand,
  type GroupMemberPersona,
  type GroupPersona,
  type GroupServerEvent
} from "../../shared/group-protocol.js";
import {
  GroupCryptoError,
  GroupCryptoSession,
  groupSodiumReady,
  isRecoverableGroupCryptoError,
  type GroupDecryptedMessage
} from "./group-crypto-session";
import {
  createActivePersonaRoster,
  diffActivePersonaRosters,
  type ActivePersonaRoster
} from "./group-presence";
import { QrInviteDialog } from "./QrInviteDialog";

type GroupView = "connecting" | "rekeying" | "active" | "reconnecting" | "full" | "browser-limit";
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
  tabVerifier?: string;
}

export interface CreatedGroupSession {
  roomId: string;
  inviteToken: string;
  linkSecret: string;
  ownerCapability: string;
  ownerRecoverySecret: string;
  expiresAt: number;
}

interface GroupMessage {
  kind: "message";
  id: string;
  text: string;
  sentAt: number;
  side: "self" | "peer";
  authorNickname?: string;
  authorColor?: string;
}

interface GroupPresenceItem {
  kind: "presence";
  id: string;
  text: string;
}

type GroupStreamItem = GroupMessage | GroupPresenceItem;

interface PendingRelay {
  relayId: string;
  message: GroupMessage;
}

const GROUP_SESSION_KEY = "410.group.session.v1";
const GROUP_BROWSER_TOKEN_PREFIX = "410.group.browser.v1.";
const GROUP_TAB_TOKEN_PREFIX = "410.group.tab.v1.";
const GROUP_OWNER_RECOVERY_PREFIX = "410.group.owner-recovery.v1.";
const GROUP_INVITE_PATH = /^\/g\/([A-Za-z0-9_-]{43})$/;
const AUTO_SCROLL_THRESHOLD = 80;
const MAX_RENDERED_MESSAGES = 500;
const MAX_DATE_MS = 8_640_000_000_000_000;
const PERSONA_COLORS = new Set<string>(GROUP_PERSONA_COLORS);
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const MEMBER_ID_PATTERN = /^[A-Za-z0-9_-]{24}$/;
const NICKNAME_PATTERN = /^[A-Za-z][A-Za-z0-9 ]{1,62}$/;

function appendBoundedMessage(messages: GroupStreamItem[], message: GroupStreamItem): GroupStreamItem[] {
  if (messages.length < MAX_RENDERED_MESSAGES) return [...messages, message];
  return [...messages.slice(-(MAX_RENDERED_MESSAGES - 1)), message];
}

export function storeCreatedGroup(created: CreatedGroupSession): void {
  const { ownerRecoverySecret, ...sessionValues } = created;
  const session: StoredGroupSession = {
    version: 1,
    ...sessionValues,
    showInviteOnLoad: true
  };
  localStorage.setItem(tokenStorageKey(GROUP_OWNER_RECOVERY_PREFIX, created.inviteToken), ownerRecoverySecret);
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

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function tokenStorageKey(prefix: string, inviteToken: string): string {
  return `${prefix}${inviteToken}`;
}

function readOrCreateBrowserToken(inviteToken: string): string {
  const key = tokenStorageKey(GROUP_BROWSER_TOKEN_PREFIX, inviteToken);
  const stored = localStorage.getItem(key);
  if (stored && TOKEN_PATTERN.test(stored)) return stored;
  const token = randomToken();
  localStorage.setItem(key, token);
  return token;
}

function readOrCreateTabToken(inviteToken: string, preserveExisting: boolean): string {
  const key = tokenStorageKey(GROUP_TAB_TOKEN_PREFIX, inviteToken);
  const stored = sessionStorage.getItem(key);
  if (preserveExisting && stored && TOKEN_PATTERN.test(stored)) return stored;
  const token = randomToken();
  sessionStorage.setItem(key, token);
  return token;
}

async function tokenVerifier(token: string): Promise<string> {
  const bytes = Uint8Array.from(atob(token.replaceAll("-", "+").replaceAll("_", "/")), (value) => value.charCodeAt(0));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let binary = "";
  for (const byte of digest) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function clearPersonaTokens(inviteToken: string): void {
  localStorage.removeItem(tokenStorageKey(GROUP_BROWSER_TOKEN_PREFIX, inviteToken));
  localStorage.removeItem(tokenStorageKey(GROUP_OWNER_RECOVERY_PREFIX, inviteToken));
  sessionStorage.removeItem(tokenStorageKey(GROUP_TAB_TOKEN_PREFIX, inviteToken));
}

function readOwnerRecoverySecret(inviteToken: string): string | undefined {
  const value = localStorage.getItem(tokenStorageKey(GROUP_OWNER_RECOVERY_PREFIX, inviteToken));
  return value && TOKEN_PATTERN.test(value) ? value : undefined;
}

function isReloadNavigation(): boolean {
  const navigation = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
  return navigation?.type === "reload";
}

function validPersona(persona: GroupPersona): boolean {
  return Boolean(
    persona && NICKNAME_PATTERN.test(persona.nickname) && PERSONA_COLORS.has(persona.color)
  );
}

function validatedPersonaRoster(personas: GroupMemberPersona[], members: string[]): Map<string, GroupPersona> {
  if (!Array.isArray(personas) || personas.length !== members.length) throw new Error("Invalid persona roster");
  const expected = new Set(members);
  const result = new Map<string, GroupPersona>();
  for (const persona of personas) {
    if (
      !persona || !MEMBER_ID_PATTERN.test(persona.memberId) || !expected.has(persona.memberId) ||
      result.has(persona.memberId) || !validPersona(persona)
    ) throw new Error("Invalid persona roster");
    result.set(persona.memberId, { nickname: persona.nickname, color: persona.color });
  }
  return result;
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
  const [messages, setMessages] = useState<GroupStreamItem[]>([]);
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState("");
  const [shareOpen, setShareOpen] = useState(false);
  const [copyState, setCopyState] = useState<CopyState>("idle");
  const [qrOpen, setQrOpen] = useState(false);
  const [destroyConfirm, setDestroyConfirm] = useState(false);
  const [destroying, setDestroying] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [selfPersona, setSelfPersona] = useState<GroupPersona | null>(null);

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
  const composerInputRef = useRef<HTMLTextAreaElement | null>(null);
  const focusComposerAfterSendRef = useRef(false);
  const shouldAutoScrollRef = useRef(true);
  const qrTriggerRef = useRef<HTMLButtonElement | null>(null);
  const pendingRelayRef = useRef<PendingRelay | null>(null);
  const browserVerifierRef = useRef("");
  const tabVerifierRef = useRef("");
  const ownerRecoverySecretRef = useRef("");
  const personaMapRef = useRef(new Map<string, GroupPersona>());
  const activePersonaRosterRef = useRef<ActivePersonaRoster | undefined>(undefined);
  const pendingPersonaRosterRef = useRef<{
    epoch: number;
    personasByMember: Map<string, GroupPersona>;
    roster: ActivePersonaRoster;
  } | undefined>(undefined);

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

  function joinCommand(local: StoredGroupSession): Extract<GroupClientCommand, { type: "group_join" }> {
    return {
      type: "group_join",
      inviteToken: local.inviteToken,
      browserVerifier: browserVerifierRef.current,
      tabVerifier: tabVerifierRef.current,
      ownerCapability: local.ownerCapability,
      ...(ownerRecoverySecretRef.current
        ? { ownerRecoverySecret: ownerRecoverySecretRef.current }
        : {})
    };
  }

  function goToGone(): void {
    if (stoppedRef.current) return;
    stoppedRef.current = true;
    clearTimers();
    clearStoredGroup();
    clearPersonaTokens(inviteToken);
    sessionRef.current = null;
    cryptoRef.current?.destroy();
    cryptoRef.current = undefined;
    cryptoMemberIdRef.current = "";
    personaMapRef.current.clear();
    activePersonaRosterRef.current = undefined;
    pendingPersonaRosterRef.current = undefined;
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
        onActive: ({ epoch }) => {
          if (!mountedRef.current || stoppedRef.current) return;
          const pending = pendingPersonaRosterRef.current;
          if (pending?.epoch === epoch) {
            const changes = diffActivePersonaRosters(activePersonaRosterRef.current, pending.roster);
            personaMapRef.current = pending.personasByMember;
            activePersonaRosterRef.current = pending.roster;
            pendingPersonaRosterRef.current = undefined;
            if (changes.length > 0) {
              setMessages((current) => changes.reduce(
                (items, change, index) => appendBoundedMessage(items, {
                  kind: "presence",
                  id: `presence:${epoch}:${change.action}:${index}:${change.persona.nickname}`,
                  text: `${change.persona.nickname} ${change.action}`
                }),
                current
              ));
            }
          }
          setNotice("");
          setView("active");
        },
        onMessage: (message: GroupDecryptedMessage, senderMemberId: string) => {
          if (!mountedRef.current || stoppedRef.current) return;
          const author = personaMapRef.current.get(senderMemberId);
          if (!author) return;
          setMessages((current) => appendBoundedMessage(current, {
            ...message,
            kind: "message",
            id: `${senderMemberId}:${message.id}`,
            side: "peer",
            authorNickname: author.nickname,
            authorColor: author.color
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
    const personasByMember = validatedPersonaRoster(event.personas, event.members);
    pendingPersonaRosterRef.current = {
      epoch: event.epoch,
      personasByMember,
      roster: createActivePersonaRoster(personasByMember, local.memberId)
    };
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
        connect(joinCommand(local));
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
    if (event.type === "group_browser_limit") {
      fullRef.current = true;
      setMaxParticipants(event.maxSessions);
      setView("browser-limit");
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
      focusComposerAfterSendRef.current = true;
      setSendPending(false);
      setDraft("");
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
        showInviteOnLoad: false,
        tabVerifier: tabVerifierRef.current
      };
      if (event.ownerCapability) {
        if (!TOKEN_PATTERN.test(event.ownerCapability)) throw new Error("Invalid recovered owner capability");
        session.ownerCapability = event.ownerCapability;
      }
      sessionRef.current = session;
      writeStoredGroup(session);
      retryDeadlineRef.current = 0;
      resumeFallbackRef.current = false;
      fullRef.current = false;
      setOwnerAuthorized(event.ownerAuthorized);
      if (!validPersona(event.persona)) throw new Error("Invalid self persona");
      setSelfPersona({ ...event.persona });
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
          connect(joinCommand(current));
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
      const reload = isReloadNavigation();
      const browserToken = readOrCreateBrowserToken(inviteToken);
      const tabToken = readOrCreateTabToken(inviteToken, reload);
      ownerRecoverySecretRef.current = readOwnerRecoverySecret(inviteToken) || "";
      [browserVerifierRef.current, tabVerifierRef.current] = await Promise.all([
        tokenVerifier(browserToken),
        tokenVerifier(tabToken)
      ]);
      const belongsToThisTab = session.tabVerifier === tabVerifierRef.current;
      if (reload || !belongsToThisTab) {
        delete session.memberId;
        delete session.resumeToken;
      }
      if (session.tabVerifier && !belongsToThisTab) delete session.ownerCapability;
      sessionRef.current = session;
      writeStoredGroup(session);
      window.history.replaceState(null, "", window.location.pathname);
      if (!reload && session.roomId && session.memberId && session.resumeToken) {
        connect({
          type: "group_resume",
          roomId: session.roomId,
          memberId: session.memberId,
          resumeToken: session.resumeToken,
          ownerCapability: session.ownerCapability
        });
      } else {
        connect(joinCommand(session));
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

  useLayoutEffect(() => {
    if (!focusComposerAfterSendRef.current || sendPending) return;
    focusComposerAfterSendRef.current = false;
    const input = composerInputRef.current;
    if (
      !mountedRef.current || stoppedRef.current || !input || input.disabled ||
      document.visibilityState !== "visible"
    ) return;
    input.focus({ preventScroll: true });
  }, [sendPending]);

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
      kind: "message",
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

  if (view === "browser-limit") {
    return (
      <main className="simple-page">
        <section className="simple-content group-full-content">
          <GroupLogo />
          <h1>Too many sessions from this browser.</h1>
          <p>Up to {maxParticipants} tabs from one browser can be in this room at once.</p>
        </section>
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
          {selfPersona && (
            <span className="group-self-persona">
              You are <strong style={{ color: selfPersona.color }}>{selfPersona.nickname}</strong> in this room.
            </span>
          )}
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
        {messages.map((message, index) => message.kind === "presence" ? (
          <p key={message.id} className="group-presence-event">{message.text}</p>
        ) : (
          <article key={message.id} className={`message ${message.side}`} data-last-message={index === messages.length - 1 ? "true" : undefined}>
            {message.side === "peer" && message.authorNickname && (
              <strong className="group-message-author" style={{ color: message.authorColor }}>
                {message.authorNickname}
              </strong>
            )}
            <p>{message.text}</p>
            <MessageTime sentAt={message.sentAt} />
          </article>
        ))}
      </section>

      <form className="composer" onSubmit={(event) => { event.preventDefault(); sendMessage(); }}>
        <label className="sr-only" htmlFor="group-message">Message</label>
        <textarea
          ref={composerInputRef}
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

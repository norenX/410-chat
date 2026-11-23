import type { GroupPersona } from "../../shared/group-protocol.js";

export interface ActivePersonaRoster {
  personas: readonly GroupPersona[];
  selfPersona: GroupPersona;
}

export interface GroupPresenceChange {
  action: "joined" | "left";
  persona: GroupPersona;
}

export interface GroupSystemNotice {
  kind: "presence";
  id: string;
  text: string;
}

export const ROOM_SEALED_NOTICE: GroupSystemNotice = {
  kind: "presence",
  id: "system:room-sealed",
  text: "Room sealed. No one else can join."
};

export function appendRoomSealedNotice<T extends { id: string }>(
  items: T[],
  maximumItems: number
): Array<T | GroupSystemNotice> {
  if (items.some((item) => item.id === ROOM_SEALED_NOTICE.id)) return items;
  const retained = items.length < maximumItems
    ? items
    : maximumItems > 1 ? items.slice(-(maximumItems - 1)) : [];
  return [...retained, { ...ROOM_SEALED_NOTICE }];
}

function personaKey(persona: GroupPersona): string {
  return `${persona.nickname}\u0000${persona.color}`;
}

function comparePersonas(left: GroupPersona, right: GroupPersona): number {
  const leftKey = personaKey(left);
  const rightKey = personaKey(right);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

export function createActivePersonaRoster(
  personasByMember: ReadonlyMap<string, GroupPersona>,
  selfMemberId: string
): ActivePersonaRoster {
  const selfPersona = personasByMember.get(selfMemberId);
  if (!selfPersona) throw new Error("Local persona is missing from active roster");
  return {
    personas: [...personasByMember.values()].map((persona) => ({ ...persona })),
    selfPersona: { ...selfPersona }
  };
}

export function diffActivePersonaRosters(
  previous: ActivePersonaRoster | undefined,
  next: ActivePersonaRoster
): GroupPresenceChange[] {
  if (!previous) return [];

  const previousByKey = new Map(previous.personas.map((persona) => [personaKey(persona), persona]));
  const nextByKey = new Map(next.personas.map((persona) => [personaKey(persona), persona]));
  const ownPersonaKeys = new Set([personaKey(previous.selfPersona), personaKey(next.selfPersona)]);

  const left = [...previousByKey]
    .filter(([key]) => !ownPersonaKeys.has(key) && !nextByKey.has(key))
    .map(([, persona]) => persona)
    .sort(comparePersonas)
    .map((persona): GroupPresenceChange => ({ action: "left", persona: { ...persona } }));
  const joined = [...nextByKey]
    .filter(([key]) => !ownPersonaKeys.has(key) && !previousByKey.has(key))
    .map(([, persona]) => persona)
    .sort(comparePersonas)
    .map((persona): GroupPresenceChange => ({ action: "joined", persona: { ...persona } }));

  return [...left, ...joined];
}

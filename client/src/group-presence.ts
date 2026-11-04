import type { GroupPersona } from "../../shared/group-protocol.js";

export interface ActivePersonaRoster {
  personas: readonly GroupPersona[];
  selfPersona: GroupPersona;
}

export interface GroupPresenceChange {
  action: "joined" | "left";
  persona: GroupPersona;
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

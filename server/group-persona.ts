import { randomInt } from "node:crypto";
import { GROUP_PERSONA_COLORS, type GroupPersona } from "../shared/group-protocol.js";

const ADJECTIVES = [
  "Amber", "Arctic", "Autumn", "Blue", "Bright", "Calm", "Cedar", "Cloud",
  "Copper", "Coral", "Crimson", "Dawn", "Dusk", "Fern", "Frost", "Gentle",
  "Golden", "Hazel", "Indigo", "Ivory", "Jade", "Lake", "Lunar", "Meadow",
  "Mint", "Misty", "Moss", "Night", "Ocean", "Olive", "Pearl", "Pine",
  "Quiet", "Rain", "River", "Sage", "Silent", "Silver", "Sky", "Snow",
  "Solar", "Spring", "Stone", "Summer", "Teal", "Velvet", "Willow", "Winter",
  "Woodland", "Zephyr"
] as const;

const NOUNS = [
  "Albatross", "Badger", "Beetle", "Bison", "Carp", "Crane", "Deer", "Dolphin",
  "Dove", "Elk", "Falcon", "Finch", "Fox", "Frog", "Gecko", "Hare",
  "Heron", "Ibex", "Jay", "Jellyfish", "Kite", "Koala", "Lark", "Lynx",
  "Marten", "Mink", "Mole", "Moose", "Moth", "Newt", "Orca", "Otter",
  "Owl", "Panda", "Penguin", "Raven", "Robin", "Salmon", "Seal", "Shrew",
  "Sparrow", "Stoat", "Swan", "Swift", "Tern", "Trout", "Turtle", "Whale",
  "Wolf", "Wren"
] as const;

function allocateNickname(usedNicknames: Set<string>): string {
  const total = ADJECTIVES.length * NOUNS.length;
  const start = randomInt(total);
  for (let offset = 0; offset < total; offset += 1) {
    const index = (start + offset) % total;
    const adjective = ADJECTIVES[Math.floor(index / NOUNS.length)]!;
    const noun = NOUNS[index % NOUNS.length]!;
    const nickname = `${adjective} ${noun}`;
    if (!usedNicknames.has(nickname)) {
      usedNicknames.add(nickname);
      return nickname;
    }
  }
  const fallback = `Quiet Otter ${usedNicknames.size + 1}`;
  usedNicknames.add(fallback);
  return fallback;
}

function allocateColor(unavailableColors: ReadonlySet<string>, activeColors: readonly string[]): string {
  const available = GROUP_PERSONA_COLORS.filter((color) => !unavailableColors.has(color));
  if (available.length) return available[randomInt(available.length)]!;
  const counts = new Map<string, number>(GROUP_PERSONA_COLORS.map((color) => [color, 0]));
  for (const color of activeColors) {
    if (counts.has(color)) counts.set(color, counts.get(color)! + 1);
  }
  const minimum = Math.min(...counts.values());
  const leastUsed = GROUP_PERSONA_COLORS.filter((color) => counts.get(color) === minimum);
  return leastUsed[randomInt(leastUsed.length)]!;
}

export function allocateGroupPersona(
  usedNicknames: Set<string>,
  unavailableColors: ReadonlySet<string>,
  activeColors: readonly string[]
): GroupPersona {
  return {
    nickname: allocateNickname(usedNicknames),
    color: allocateColor(unavailableColors, activeColors)
  };
}

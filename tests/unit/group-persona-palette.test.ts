import { describe, expect, it } from "vitest";
import { allocateGroupPersona } from "../../server/group-persona.js";
import {
  GROUP_PARTICIPANT_LIMITS,
  GROUP_PERSONA_COLORS
} from "../../shared/group-protocol.js";

const WHITE_LUMINANCE = 1;

function channelLuminance(channel: number): number {
  const value = channel / 255;
  return value <= 0.04045
    ? value / 12.92
    : ((value + 0.055) / 1.055) ** 2.4;
}

function contrastAgainstWhite(color: string): number {
  const red = Number.parseInt(color.slice(1, 3), 16);
  const green = Number.parseInt(color.slice(3, 5), 16);
  const blue = Number.parseInt(color.slice(5, 7), 16);
  const luminance =
    0.2126 * channelLuminance(red) +
    0.7152 * channelLuminance(green) +
    0.0722 * channelLuminance(blue);
  return (WHITE_LUMINANCE + 0.05) / (luminance + 0.05);
}

describe("group persona palette", () => {
  it("provides one distinct valid color per possible active participant", () => {
    expect(GROUP_PERSONA_COLORS).toHaveLength(GROUP_PARTICIPANT_LIMITS.at(-1));
    expect(new Set(GROUP_PERSONA_COLORS).size).toBe(GROUP_PERSONA_COLORS.length);
    for (const color of GROUP_PERSONA_COLORS) expect(color).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("keeps every nickname color at WCAG AA contrast against white", () => {
    for (const color of GROUP_PERSONA_COLORS) {
      expect(contrastAgainstWhite(color), color).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("allocates all colors without reuse for a ten-person active roster", () => {
    const usedNicknames = new Set<string>();
    const allocatedColors = new Set<string>();
    for (let index = 0; index < GROUP_PARTICIPANT_LIMITS.at(-1)!; index += 1) {
      const persona = allocateGroupPersona(usedNicknames, allocatedColors, [...allocatedColors]);
      allocatedColors.add(persona.color);
    }
    expect(allocatedColors).toEqual(new Set(GROUP_PERSONA_COLORS));
  });
});

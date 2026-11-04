import { describe, expect, it } from "vitest";
import type { GroupPersona } from "../../shared/group-protocol.js";
import {
  createActivePersonaRoster,
  diffActivePersonaRosters
} from "../../client/src/group-presence.js";

const IVORY_HERON = { nickname: "Ivory Heron", color: "#2f6f5e" } satisfies GroupPersona;
const JADE_DOVE = { nickname: "Jade Dove", color: "#4f6f52" } satisfies GroupPersona;
const WOODLAND_DOVE = { nickname: "Woodland Dove", color: "#795548" } satisfies GroupPersona;
const AMBER_FOX = { nickname: "Amber Fox", color: "#a65f00" } satisfies GroupPersona;

function roster(selfMemberId: string, entries: Array<[string, GroupPersona]>) {
  return createActivePersonaRoster(new Map(entries), selfMemberId);
}

describe("local group presence events", () => {
  it("uses the first active roster only as a baseline", () => {
    expect(diffActivePersonaRosters(undefined, roster("a", [["a", IVORY_HERON]]))).toEqual([]);
  });

  it("reports only other personas added after the previous active roster", () => {
    const first = roster("a", [["a", IVORY_HERON]]);
    const second = roster("a", [["a", IVORY_HERON], ["b", JADE_DOVE]]);
    expect(diffActivePersonaRosters(first, second)).toEqual([
      { action: "joined", persona: JADE_DOVE }
    ]);
    expect(diffActivePersonaRosters(undefined, roster("b", [["a", IVORY_HERON], ["b", JADE_DOVE]]))).toEqual([]);
  });

  it("does not treat a fresh member id for the same persona as a presence change", () => {
    const before = roster("a-old", [["a-old", IVORY_HERON], ["b", JADE_DOVE]]);
    const afterForPeer = roster("b", [["a-new", IVORY_HERON], ["b", JADE_DOVE]]);
    const afterForSelf = roster("a-new", [["a-new", IVORY_HERON], ["b", JADE_DOVE]]);
    expect(diffActivePersonaRosters(before, afterForPeer)).toEqual([]);
    expect(diffActivePersonaRosters(before, afterForSelf)).toEqual([]);
  });

  it("emits one final leave and a later join without duplicating unchanged rosters", () => {
    const three = roster("a", [["a", IVORY_HERON], ["b", JADE_DOVE], ["c", WOODLAND_DOVE]]);
    const two = roster("a", [["a", IVORY_HERON], ["b", JADE_DOVE]]);
    expect(diffActivePersonaRosters(three, three)).toEqual([]);
    expect(diffActivePersonaRosters(three, two)).toEqual([
      { action: "left", persona: WOODLAND_DOVE }
    ]);
    expect(diffActivePersonaRosters(two, two)).toEqual([]);
    expect(diffActivePersonaRosters(two, three)).toEqual([
      { action: "joined", persona: WOODLAND_DOVE }
    ]);
  });

  it("orders simultaneous leaves before joins and sorts each group deterministically", () => {
    const before = roster("a", [["a", IVORY_HERON], ["c", WOODLAND_DOVE], ["b", JADE_DOVE]]);
    const after = roster("a", [["a", IVORY_HERON], ["d", AMBER_FOX]]);
    expect(diffActivePersonaRosters(before, after)).toEqual([
      { action: "left", persona: JADE_DOVE },
      { action: "left", persona: WOODLAND_DOVE },
      { action: "joined", persona: AMBER_FOX }
    ]);
  });
});

import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);

async function renderStats(payload: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(payload));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("stats test server has no TCP address");
  try {
    const result = await execFileAsync(join(process.cwd(), "scripts/stats.sh"), {
      env: {
        ...process.env,
        STATS_URL: `http://127.0.0.1:${address.port}/__stats`
      }
    });
    return result.stdout;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

describe("scripts/stats.sh", () => {
  it("renders isolated direct and group quick counters through STATS_URL", async () => {
    const output = await renderStats({
      now: { waiting: 0, active: 1 },
      today: {
        homepage_views: 8,
        rooms_created: 2,
        conversations_started: 1,
        messages_relayed: 0,
        responses_410: 2
      },
      totals: {
        homepage_views: 165,
        rooms_created: 14,
        conversations_started: 9,
        messages_relayed: 120,
        responses_410: 24
      },
      groups: {
        now: { rooms: 1, participants: 4 },
        today: {
          group_rooms_created: 3,
          group_participants_joined: 12,
          group_messages_relayed: 87,
          group_responses_410: 4
        },
        totals: {
          group_rooms_created: 7,
          group_participants_joined: 29,
          group_messages_relayed: 214,
          group_responses_410: 9
        }
      }
    });

    expect(output).toBe([
      "410.chat stats",
      "",
      "DIRECT",
      "NOW     waiting 0 | active 1",
      "TODAY   views 8 | rooms 2 | chats 1 | messages 0 | 410 2",
      "TOTAL   views 165 | rooms 14 | chats 9 | messages 120 | 410 24",
      "",
      "GROUP",
      "NOW     rooms 1 | people 4",
      "TODAY   rooms 3 | joins 12 | messages 87 | 410 4",
      "TOTAL   rooms 7 | joins 29 | messages 214 | 410 9",
      ""
    ].join("\n"));
  });

  it("renders stable zero group counters when the API has no group section", async () => {
    const output = await renderStats({
      now: { waiting: 2, active: 3 },
      today: {},
      totals: {}
    });
    expect(output).toContain("NOW     waiting 2 | active 3");
    expect(output).toContain("GROUP\nNOW     rooms 0 | people 0");
    expect(output).toContain("TODAY   rooms 0 | joins 0 | messages 0 | 410 0");
    expect(output).toContain("TOTAL   rooms 0 | joins 0 | messages 0 | 410 0");
  });
});

import { useEffect, useState } from "react";
import type {
  AdminDirectMetricCounts,
  AdminGroupMetricCounts,
  AdminStatsSnapshot
} from "../../shared/admin-stats.js";

const POLL_INTERVAL_MS = 5000;

const DIRECT_FIELDS = [
  ["views", "homepage_views"],
  ["rooms", "rooms_created"],
  ["chats", "conversations_started"],
  ["messages", "messages_relayed"],
  ["410", "responses_410"]
] as const satisfies ReadonlyArray<readonly [string, keyof AdminDirectMetricCounts]>;

const GROUP_FIELDS = [
  ["rooms", "group_rooms_created"],
  ["joins", "group_participants_joined"],
  ["messages", "group_messages_relayed"],
  ["410", "group_responses_410"]
] as const satisfies ReadonlyArray<readonly [string, keyof AdminGroupMetricCounts]>;

type UpdateState = "loading" | "live" | "failed";

function validCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function validCounts<T extends string>(value: unknown, fields: readonly T[]): value is Record<T, number> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return fields.every((field) => validCount(record[field]));
}

function parseStats(value: unknown): AdminStatsSnapshot | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const root = value as Record<string, unknown>;
  const direct = root.direct as Record<string, unknown> | undefined;
  const group = root.group as Record<string, unknown> | undefined;
  if (!direct || !group) return null;

  const directNow = direct.now as Record<string, unknown> | undefined;
  const groupNow = group.now as Record<string, unknown> | undefined;
  if (
    !directNow || !validCount(directNow.waiting) || !validCount(directNow.active) ||
    !groupNow || !validCount(groupNow.rooms) || !validCount(groupNow.people)
  ) return null;

  const directKeys = DIRECT_FIELDS.map(([, key]) => key);
  const groupKeys = GROUP_FIELDS.map(([, key]) => key);
  if (
    !validCounts(direct.today, directKeys) || !validCounts(direct.totals, directKeys) ||
    !validCounts(group.today, groupKeys) || !validCounts(group.totals, groupKeys)
  ) return null;

  return value as AdminStatsSnapshot;
}

function updateTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(date);
}

function MetricRows<T extends string>({
  values,
  fields
}: {
  values: Record<T, number>;
  fields: ReadonlyArray<readonly [string, T]>;
}) {
  return (
    <dl className="admin-stats-values">
      {fields.map(([label, key]) => (
        <div key={key}>
          <dt>{label}</dt>
          <dd>{values[key].toLocaleString()}</dd>
        </div>
      ))}
    </dl>
  );
}

function DirectSection({ stats }: { stats: AdminStatsSnapshot["direct"] }) {
  return (
    <section className="admin-stats-section" aria-labelledby="direct-stats-title">
      <h2 id="direct-stats-title">DIRECT</h2>
      <div className="admin-stats-periods">
        <div className="admin-stats-period">
          <h3>NOW</h3>
          <MetricRows values={stats.now} fields={[["waiting", "waiting"], ["active", "active"]]} />
        </div>
        <div className="admin-stats-period">
          <h3>TODAY</h3>
          <MetricRows values={stats.today} fields={DIRECT_FIELDS} />
        </div>
        <div className="admin-stats-period">
          <h3>TOTAL</h3>
          <MetricRows values={stats.totals} fields={DIRECT_FIELDS} />
        </div>
      </div>
    </section>
  );
}

function GroupSection({ stats }: { stats: AdminStatsSnapshot["group"] }) {
  return (
    <section className="admin-stats-section" aria-labelledby="group-stats-title">
      <h2 id="group-stats-title">GROUP</h2>
      <div className="admin-stats-periods">
        <div className="admin-stats-period">
          <h3>NOW</h3>
          <MetricRows values={stats.now} fields={[["rooms", "rooms"], ["people", "people"]]} />
        </div>
        <div className="admin-stats-period">
          <h3>TODAY</h3>
          <MetricRows values={stats.today} fields={GROUP_FIELDS} />
        </div>
        <div className="admin-stats-period">
          <h3>TOTAL</h3>
          <MetricRows values={stats.totals} fields={GROUP_FIELDS} />
        </div>
      </div>
    </section>
  );
}

export function AdminStatsPage() {
  const [stats, setStats] = useState<AdminStatsSnapshot | null>(null);
  const [state, setState] = useState<UpdateState>("loading");
  const [updatedAt, setUpdatedAt] = useState<Date | null>(null);

  useEffect(() => {
    document.title = "Stats — 410.chat";
    let disposed = false;
    let inFlight = false;
    const controller = new AbortController();

    async function refresh(): Promise<void> {
      if (disposed || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch("/admin/api/stats", {
          cache: "no-store",
          headers: { Accept: "application/json" },
          signal: controller.signal
        });
        if (!response.ok) throw new Error("stats request failed");
        const parsed = parseStats(await response.json());
        if (!parsed) throw new Error("invalid stats response");
        if (!disposed) {
          setStats(parsed);
          setUpdatedAt(new Date());
          setState("live");
        }
      } catch {
        if (!disposed && !controller.signal.aborted) setState("failed");
      } finally {
        inFlight = false;
      }
    }

    void refresh();
    const timer = window.setInterval(() => void refresh(), POLL_INTERVAL_MS);
    return () => {
      disposed = true;
      controller.abort();
      window.clearInterval(timer);
    };
  }, []);

  return (
    <main className="admin-stats-page">
      <div className="admin-stats-shell">
        <header className="admin-stats-header">
          <h1>410.chat stats</h1>
          <span className={`admin-live-state ${state === "live" ? "is-live" : ""}`} role="status" aria-live="polite">
            <span aria-hidden="true">●</span> {state === "failed" ? "UPDATE FAILED" : state === "live" ? "LIVE" : "LOADING"}
          </span>
        </header>

        {stats ? (
          <>
            <DirectSection stats={stats.direct} />
            <GroupSection stats={stats.group} />
          </>
        ) : (
          <p className="admin-stats-empty">{state === "failed" ? "Stats unavailable." : "Loading stats…"}</p>
        )}

        <footer className="admin-stats-updated" aria-live="polite">
          {updatedAt ? `Updated ${updateTime(updatedAt)}` : "Not updated yet"}
        </footer>
      </div>
    </main>
  );
}

export const TRAFFIC_SOURCES = [
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
] as const;

export type TrafficSource = typeof TRAFFIC_SOURCES[number];

const SOURCE_SET = new Set<string>(TRAFFIC_SOURCES);

export function normalizeTrafficSource(value: unknown): TrafficSource {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== "string") return "direct";

  const normalized = raw.trim().toLowerCase();
  if (!normalized) return "direct";

  return SOURCE_SET.has(normalized)
    ? normalized as TrafficSource
    : "other";
}

function sourceFromHostname(hostname: string): TrafficSource {
  const host = hostname.toLowerCase();

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
}

export function trafficSourceFromPageRequest(
  url: URL,
  referer: string | string[] | undefined
): TrafficSource {
  const explicit = url.searchParams.get("from");
  if (explicit) return normalizeTrafficSource(explicit);

  const rawReferer = Array.isArray(referer) ? referer[0] : referer;
  if (!rawReferer) return "direct";

  try {
    const referrerUrl = new URL(rawReferer);

    if (referrerUrl.hostname.toLowerCase() === url.hostname.toLowerCase()) return "direct";

    return sourceFromHostname(referrerUrl.hostname);
  } catch {
    return "other";
  }
}

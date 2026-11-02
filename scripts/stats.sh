#!/bin/sh
set -eu

stats_url=${STATS_URL:-http://127.0.0.1:8080/__stats}

curl -fsS "$stats_url" | python3 -c '
import json
import sys

stats = json.load(sys.stdin)
now = stats.get("now", {})
today = stats.get("today", {})
totals = stats.get("totals", {})
waiting = now.get("waiting", 0)
active = now.get("active", 0)
fields = (
    ("views", "homepage_views"),
    ("rooms", "rooms_created"),
    ("chats", "conversations_started"),
    ("messages", "messages_relayed"),
    ("410", "responses_410"),
)

def summary(label, values):
    counters = " | ".join(f"{name} {values.get(key, 0)}" for name, key in fields)
    return f"{label:<8}{counters}"

print("410.chat stats")
print()
print(f"NOW     waiting {waiting} | active {active}")
print(summary("TODAY", today))
print(summary("TOTAL", totals))
'

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
groups = stats.get("groups", {}) or {}
group_now = groups.get("now", {}) or {}
group_today = groups.get("today", {}) or {}
group_totals = groups.get("totals", {}) or {}
waiting = now.get("waiting", 0)
active = now.get("active", 0)
group_rooms = group_now.get("rooms", 0)
group_people = group_now.get("participants", 0)
direct_fields = (
    ("views", "homepage_views"),
    ("rooms", "rooms_created"),
    ("chats", "conversations_started"),
    ("messages", "messages_relayed"),
    ("410", "responses_410"),
)
group_fields = (
    ("rooms", "group_rooms_created"),
    ("joins", "group_participants_joined"),
    ("messages", "group_messages_relayed"),
    ("410", "group_responses_410"),
)

def summary(label, values, fields):
    counters = " | ".join(f"{name} {values.get(key, 0)}" for name, key in fields)
    return f"{label:<8}{counters}"

print("410.chat stats")
print()
print("DIRECT")
print(f"NOW     waiting {waiting} | active {active}")
print(summary("TODAY", today, direct_fields))
print(summary("TOTAL", totals, direct_fields))
print()
print("GROUP")
print(f"NOW     rooms {group_rooms} | people {group_people}")
print(summary("TODAY", group_today, group_fields))
print(summary("TOTAL", group_totals, group_fields))
'

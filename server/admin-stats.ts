import type { AdminStatsSnapshot } from "../shared/admin-stats.js";
import type { MetricsSnapshot } from "./metrics.js";

export function adminStatsSnapshot(snapshot: MetricsSnapshot): AdminStatsSnapshot {
  return {
    direct: {
      now: {
        waiting: snapshot.now.waiting,
        active: snapshot.now.active
      },
      today: {
        homepage_views: snapshot.today.homepage_views,
        rooms_created: snapshot.today.rooms_created,
        conversations_started: snapshot.today.conversations_started,
        messages_relayed: snapshot.today.messages_relayed,
        responses_410: snapshot.today.responses_410
      },
      totals: {
        homepage_views: snapshot.totals.homepage_views,
        rooms_created: snapshot.totals.rooms_created,
        conversations_started: snapshot.totals.conversations_started,
        messages_relayed: snapshot.totals.messages_relayed,
        responses_410: snapshot.totals.responses_410
      }
    },
    group: {
      now: {
        rooms: snapshot.groups.now.rooms,
        people: snapshot.groups.now.participants
      },
      today: {
        group_rooms_created: snapshot.groups.today.group_rooms_created,
        group_participants_joined: snapshot.groups.today.group_participants_joined,
        group_messages_relayed: snapshot.groups.today.group_messages_relayed,
        group_responses_410: snapshot.groups.today.group_responses_410
      },
      totals: {
        group_rooms_created: snapshot.groups.totals.group_rooms_created,
        group_participants_joined: snapshot.groups.totals.group_participants_joined,
        group_messages_relayed: snapshot.groups.totals.group_messages_relayed,
        group_responses_410: snapshot.groups.totals.group_responses_410
      }
    }
  };
}

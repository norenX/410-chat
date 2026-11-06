export interface AdminDirectMetricCounts {
  homepage_views: number;
  rooms_created: number;
  conversations_started: number;
  messages_relayed: number;
  responses_410: number;
}

export interface AdminGroupMetricCounts {
  group_rooms_created: number;
  group_participants_joined: number;
  group_messages_relayed: number;
  group_responses_410: number;
}

export interface AdminStatsSnapshot {
  direct: {
    now: {
      waiting: number;
      active: number;
    };
    today: AdminDirectMetricCounts;
    totals: AdminDirectMetricCounts;
  };
  group: {
    now: {
      rooms: number;
      people: number;
    };
    today: AdminGroupMetricCounts;
    totals: AdminGroupMetricCounts;
  };
}

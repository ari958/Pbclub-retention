export type EngagementState = "active" | "lapsing" | "dormant" | "never-visited";
export type ProgressionStatus = "ready-to-advance" | "developing" | "at-ceiling" | null;
export type MessageStatus = "pending" | "sent" | "skipped" | "failed" | "undelivered";

export interface Player {
  id: string;
  external_id: string | null;
  name: string;
  skill_level: string | null;
  membership_status: string | null;
  progression_status: ProgressionStatus;
  last_visit_date: string | null;
  phone: string | null;
  notes: string | null;
  club_id: string | null;
  sms_opt_in: boolean | null;
  last_outbound_at: string | null;
  dupr_rating: number | null;
  churn_risk: string | null;
}

export interface MessageQueueItem {
  id: string;
  body: string;
  signup_url: string | null;
  status: MessageStatus;
  conversation_id: string;
  conversations: {
    id: string;
    triggered_by: string | null;
    player_id: string | null;
    players: {
      id: string;
      name: string;
      skill_level: string | null;
      progression_status: ProgressionStatus;
      last_outbound_at: string | null;
    } | null;
  } | null;
}

export interface MessageTemplate {
  id: string;
  name: string;
  body: string;
  use_case_tags: string[];
  is_builtin: boolean;
  created_at: string;
}

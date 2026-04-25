export type EngagementState = "active" | "lapsing" | "dormant" | "never-visited";
export type ProgressionStatus = "ready-to-advance" | "developing" | "at-ceiling" | null;

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
}

export interface MessageQueueItem {
  id: string;
  body: string;
  signup_url: string | null;
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

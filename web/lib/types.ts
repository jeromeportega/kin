export interface DigestItem {
  classification_id: number
  message_id: string
  uid: string | null
  from_addr: string
  subject: string
  date: string
  category: string
  priority: "low" | "medium" | "high"
  action_required: boolean
  summary: string
  action_items: string[]
  dates: string[]
  confidence: number
  model: string
  prompt_version: string
  classified_at: string
}

export interface Digest {
  generated_at: string
  user_id: string
  model: string | null
  prompt_version: string | null
  window_hours: number
  window_start: string
  window_end: string
  include_other: boolean
  classified_count: number
  actionable_count: number
  informational_count: number
  skipped_other_count: number
  dropped_low_count: number
  items: DigestItem[]
}

export interface Classification {
  classification_id: number
  model: string
  prompt_version: string
  category: string
  priority: "low" | "medium" | "high"
  action_required: boolean
  summary: string
  action_items: string[]
  dates: string[]
  confidence: number
  classified_at: string
  email_id: number
  message_id: string
  uid: string | null
  folder: string
  from_addr: string
  subject: string
  email_date: string
}

export interface Run {
  id: number
  user_id: string
  started_at: string
  ended_at: string | null
  hours: number | null
  limit_n: number | null
  model: string
  prompt_version: string
  fetched: number
  filtered: number
  classified: number
  reused: number
  errors: number
  truncated: number
}

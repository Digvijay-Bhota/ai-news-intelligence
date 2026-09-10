export interface ArticleExtractedEntities {
  topics?: string[];
  events?: {
    title: string;
    description: string;
    severity: string;
  }[];
}

export interface Article {
  id: number;
  external_id: string;
  title: string;
  summary: string | null;
  url: string;
  source: string;
  published_at: number | null;
  category: string | null;
  topics: string[];
  events: { title: string; hash: string }[];
  extracted_entities?: ArticleExtractedEntities;
}

export interface Topic {
  id: number;
  name: string;
  slug: string;
  description: string | null;
  active: number;
}

export interface Source {
  id: number;
  name: string;
  base_url: string;
  source_type: string;
  active: number;
}

export interface FeedResponse {
  success: boolean;
  data: {
    meta: {
      limit: number;
      offset: number;
      total: number;
    };
    items: Article[];
  };
}

export interface TopicsResponse {
  success: boolean;
  data: Topic[];
}

export interface SourcesResponse {
  success: boolean;
  data: Source[];
}

export interface EventIntelligence {
  topic_count: number;
  unique_topics: string[];
  days_active: number | null;
  coverage_density: number | null;
  top_source: string | null;
}

export interface EventDetailResponse {
  success: boolean;
  data: {
    event: {
      hash: string;
      title: string;
      description: string | null;
      severity: string;
      started_at: number | null;
      last_published_at: number | null;
      freshness: "developing" | "active" | "stale";
    };
    coverage: {
      total_articles: number;
      total_sources: number;
      first_published_at: number | null;
      last_published_at: number | null;
      sources: {
        name: string;
        article_count: number;
        first_published_at: number | null;
      }[];
    };
    intelligence: EventIntelligence;
    brief: EventBrief | null;
    brief_metadata: EventBriefMetadata | null;
    narrative_delta?: NarrativeDelta | null;
    narrative_delta_metadata?: NarrativeDeltaMetadata | null;
    claim_comparisons?: ClaimComparison[];
    claim_comparison_metadata?: ClaimComparisonMetadata | null;
    change_summary: ChangeSummary | null;
    articles: Article[];
  };
}

// ─── Phase 9: Grounded AI Event Briefing & Change Detection ───

export interface EventBriefSourceReference {
  article_id: number;
  claim_context: string;
}

export interface EventBriefKeyEntity {
  name: string;
  type: string;
  relevance: string;
}

export interface EventBrief {
  summary: string;
  why_it_matters: string;
  key_developments: string[];
  key_entities: EventBriefKeyEntity[];
  uncertainties: string[];
  source_references: EventBriefSourceReference[];
}

export interface EventBriefMetadata {
  version: number;
  status: 'completed' | 'generating' | 'failed' | 'unavailable';
  generated_at: number | null;
  model: string | null;
  article_fingerprint: string | null;
  article_count: number;
  source_count: number;
  is_stale: boolean;
  unincorporated_article_count: number;
}

export interface ChangeSummary {
  has_changed: boolean;
  article_delta: number;
  source_delta: number;
  latest_activity_at: number | null;
}

export interface EventSummary {
  hash: string;
  title: string;
  description: string | null;
  severity: string;
  started_at: number | null;
  article_count: number;
  last_published_at: number | null;
  freshness: "developing" | "active" | "stale";
  source_count?: number;
  first_published_at?: number | null;
  topics?: string[];
  sources?: string[];
  brief_version?: number;
  has_narrative_delta?: boolean;
  has_claim_comparison?: boolean;
  score?: number;
  rank_reasons?: string[];
}

export interface PersonalizedFeedItem extends EventSummary {
  id?: number;
  score: number;
  rank_reasons: string[];
  brief_version: number;
  has_narrative_delta: boolean;
  has_claim_comparison: boolean;
}

export interface PersonalizedFeedResponse {
  success: boolean;
  data: {
    items: PersonalizedFeedItem[];
    meta: {
      total: number;
      limit: number;
      offset: number;
      user_has_follows: boolean;
      fallback_applied: boolean;
    };
  };
}

export interface GlobalFreshnessSummary {
  total: number;
  developing: number;
  active: number;
  stale: number;
}

export interface EventListResponse {
  items: EventSummary[];
  summary: GlobalFreshnessSummary;
}

// ─── Phase 10: Narrative Evolution & Cross-Source Intelligence ─

export interface NewlyConfirmedFact {
  statement: string;
  source_references: number[];
}

export interface ChangedClaim {
  previous_statement: string;
  current_statement: string;
  change_type: 'refined' | 'expanded' | 'contradicted' | 'retracted' | 'uncertain';
  source_references: number[];
}

export interface RemovedClaim {
  statement: string;
  source_references: number[];
}

export interface NarrativeDelta {
  previous_version: number;
  current_version: number;
  summary: string;
  newly_confirmed: NewlyConfirmedFact[];
  changed_claims: ChangedClaim[];
  removed_or_no_longer_supported: RemovedClaim[];
  unchanged_core: string[];
  open_questions: string[];
}

export interface NarrativeDeltaMetadata {
  previous_version: number;
  current_version: number;
  status: 'completed' | 'generating' | 'failed' | 'unavailable';
  model: string | null;
  generated_at: number | null;
  article_fingerprint: string | null;
}

export interface ClaimSourcePosition {
  source_id: number;
  source_name: string;
  position: string;
  article_ids: number[];
}

export interface ClaimComparison {
  claim: string;
  status: 'consensus' | 'disputed' | 'unconfirmed' | 'evolving';
  sources: ClaimSourcePosition[];
}

export interface ClaimComparisonMetadata {
  version: number;
  status: 'completed' | 'generating' | 'failed' | 'unavailable';
  model: string | null;
  generated_at: number | null;
  claim_count: number;
  article_fingerprint: string | null;
}

// ─── Phase 11A: Identity Foundation & Follow Graph ────────────

export type FollowTargetType = 'topic' | 'event' | 'source';

export interface UserFollow {
  id: string;
  user_id: string;
  target_type: FollowTargetType;
  target_id: string;
  created_at: number;
}


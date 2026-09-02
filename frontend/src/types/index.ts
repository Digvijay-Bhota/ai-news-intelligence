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

export interface EventDetailResponse {
  success: boolean;
  data: {
    event: {
      hash: string;
      title: string;
      description: string | null;
      severity: string;
      started_at: number | null;
      last_published_at?: number | null;
      freshness?: "developing" | "active" | "stale";
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
    articles: Article[];
  };
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
}

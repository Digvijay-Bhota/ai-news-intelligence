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
  events: string[];
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

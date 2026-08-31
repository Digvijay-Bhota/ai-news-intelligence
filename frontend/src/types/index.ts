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

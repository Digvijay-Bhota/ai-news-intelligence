// Type declarations for client.mjs (used by the Workers tests).

export interface ReviewConfig {
  apiUrl: string;
  hmacSecret: string;
  tokenId: string;
  tokenSecret: string;
  reviewerId: string;
}

export interface SignPayloadInput {
  method: string;
  path: string;
  timestamp: number;
  nonce: string;
  body: string;
  userId?: string;
}

export interface CandidateEvidence {
  post_id: string;
  body: string;
  body_truncated: boolean;
  created_at: number;
}

export interface CandidateSignal {
  id: string;
  type: string;
  content: string;
  created_at: number;
  active_evidence_count: number;
  distinct_author_count: number;
  meets_public_threshold: boolean;
  evidence: CandidateEvidence[];
}

export interface CandidateList {
  candidates: CandidateSignal[];
  has_more: boolean;
  limit: number;
}

type FetchImpl = (request: Request) => Promise<Response>;

export declare const ENV_VARS: Record<'apiUrl' | 'hmacSecret' | 'tokenId' | 'tokenSecret' | 'reviewerId', string>;
export declare class UsageError extends Error {}
export declare class ReviewApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string);
}
export declare function parseConfig(env: Record<string, string | undefined>): ReviewConfig;
export declare function signPayload(payload: SignPayloadInput, secret: string): Promise<string>;
export declare function signedRequest(
  config: ReviewConfig,
  method: string,
  pathWithQuery: string,
  payload: unknown,
  fetchImpl?: FetchImpl
): Promise<unknown>;
export declare function listCandidates(
  config: ReviewConfig,
  eventHash: string,
  options?: { limit?: number | string },
  fetchImpl?: FetchImpl
): Promise<CandidateList>;
export declare function approveSignal(config: ReviewConfig, eventHash: string, signalId: string, fetchImpl?: FetchImpl): Promise<null>;
export declare function rejectSignal(
  config: ReviewConfig,
  eventHash: string,
  signalId: string,
  reason: string,
  fetchImpl?: FetchImpl
): Promise<null>;
export declare function sanitizeForTerminal(text: string): string;
export declare function formatCandidates(data: CandidateList): string;

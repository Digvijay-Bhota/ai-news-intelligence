import type { Env } from '../src/types';

export const TEST_SECRET = 'test-secret-key-32-bytes-long!!';

export function createMockEnv(overrides: Partial<Env> = {}): Env {
  return {
    DB: {} as D1Database,
    CACHE: {} as KVNamespace,
    HMAC_SECRET: TEST_SECRET,
    GEMINI_API_KEY: 'test-gemini-key',
    PIPELINE_TOKEN_ID: 'test-pipeline-token',
    ENVIRONMENT: 'test',
    CORS_ORIGIN: '*',
    PUBLIC_RATE_LIMIT_WINDOW_SECONDS: '60',
    PUBLIC_RATE_LIMIT_MAX_REQUESTS: '100',
    INTERNAL_RATE_LIMIT_WINDOW_SECONDS: '60',
    INTERNAL_RATE_LIMIT_MAX_REQUESTS: '1000',
    PUBLIC_BODY_LIMIT_BYTES: '65536',
    INTERNAL_BODY_LIMIT_BYTES: '262144',
    HMAC_ALGORITHM: 'SHA-256',
    HMAC_HEADER: 'X-HMAC-Signature',
    NONCE_HEADER: 'X-Nonce',
    TIMESTAMP_HEADER: 'X-Timestamp',
    REPLAY_WINDOW_SECONDS: '300',
    ...overrides,
  };
}

export function createMockD1Database(seed = false): D1Database {
  const storage = new Map<string, Record<string, unknown>[]>();
  const follows: Array<{ id: string; user_id: string; target_type: string; target_id: string; created_at: number }> = [];
  const users: Map<string, { id: string; created_at: number; last_active_at: number }> = new Map();
  const knownTopics = [
    { id: 1, name: 'AI Integration Topic', slug: 'ai-integration-topic', description: 'Desc', active: 1 },
    { id: 2, name: 'Machine Learning', slug: 'machine-learning', description: 'Desc', active: 1 },
  ];
  const knownSources = [
    { id: 1, name: 'Integration Source', base_url: 'https://example.com', source_type: 'rss', active: 1 },
    { id: 2, name: 'TechCrunch', base_url: 'https://techcrunch.com', source_type: 'rss', active: 1 },
  ];
  const knownEvents = [
    { id: 1, event_hash: 'evt-hash', title: 'AI Integration Event', description: 'Desc', severity: 'info', status: 'active', started_at: 1000 },
  ];

  return {
    prepare: (query: string) => {
      const bind = (...values: unknown[]) => ({
        first: async <T>() => {
  const upperQuery = query.toUpperCase();

  if (upperQuery.includes('FROM USERS WHERE ID =')) {
    const existing = users.get(values[0] as string);
    return (existing ?? { id: values[0] as string, created_at: 1000, last_active_at: 1000 }) as T;
  }

  if (upperQuery.includes('FROM TOPICS WHERE SLUG =')) {
    const found = knownTopics.find(t => t.slug === values[0]);
    return (found ?? null) as T;
  }

  if (upperQuery.includes('FROM SOURCES WHERE NAME =')) {
    const found = knownSources.find(s => s.name === values[0]);
    return (found ?? null) as T;
  }


  if (upperQuery.includes('SELECT 1 FROM USER_FOLLOWS')) {
    const found = follows.some(f => f.user_id === values[0] && f.target_type === values[1] && f.target_id === values[2]);
    return (found ? { 1: 1 } : null) as T;
  }

  if (upperQuery.includes('FROM USER_FOLLOWS') && upperQuery.includes('TARGET_ID')) {
    const found = follows.find(f => f.user_id === values[0] && f.target_type === values[1] && f.target_id === values[2]);
    return (found ?? { id: 'f-1', user_id: values[0], target_type: values[1], target_id: values[2], created_at: 1000 }) as T;
  }

  if (upperQuery.includes('INSERT INTO USER_PREFERENCES')) {
    return {
      id: 1,
      user_id: values[0],
      preferred_topics: values[1] ?? null,
      preferred_sources: values[2] ?? null,
      digest_frequency: values[3],
      email: values[4] ?? null,
      created_at: values[5],
      updated_at: values[6],
    } as T;
  }

  if (upperQuery.includes('UPDATE USER_PREFERENCES')) {
    return {
      id: 1,
      user_id: values[5],
      preferred_topics: values[0] ?? null,
      preferred_sources: values[1] ?? null,
      digest_frequency: values[2],
      email: values[3] ?? null,
      created_at: values[4],
      updated_at: values[4],
    } as T;
  }

  if (upperQuery.includes('INSERT INTO SAVED_ARTICLES')) {
    return {
      id: 1,
      user_id: values[0],
      article_raw_id: values[1],
      note: values[2] ?? null,
      created_at: values[3],
    } as T;
  }

  if (upperQuery.includes('INSERT INTO HIDDEN_STORIES')) {
    return {
      id: 1,
      user_id: values[0],
      article_raw_id: values[1],
      reason: values[2],
      created_at: values[3],
    } as T;
  }

  if (upperQuery.includes('INSERT INTO EVENT_BRIEFS')) {
    return {
      id: 1,
      event_id: values[0],
      content: values[1],
      article_fingerprint: values[2],
      article_ids: values[3],
      source_count: values[4],
      article_count: values[5],
      model: values[6],
      version: values[7],
      status: values[8],
      error_message: values[9] ?? null,
      created_at: values[10],
      updated_at: values[11],
    } as T;
  }

  if (upperQuery.includes('FROM SQLITE_MASTER') && upperQuery.includes('EVENT_BRIEFS')) {
    return { name: 'event_briefs' } as T;
  }

  if (seed && upperQuery.includes('SELECT * FROM ARTICLES_RAW WHERE ID = ?') && values[0] === 1) {
    return {
      id: 1, external_id: 'ext-1', source_id: 1, title: 'Integration Test Article',
      summary: 'Sum', url: 'http://test', raw_content: '',
      published_at: 1000, fetched_at: 1000, language: 'en',
      status: 'processed', created_at: 1000
    } as T;
  }

  if (upperQuery.includes('FROM EVENTS WHERE EVENT_HASH =')) {
    const found = knownEvents.find(e => e.event_hash === values[0]);
    if (found) return found as T;
    if (seed && values[0] === 'evt-hash') {
      return {
        id: 1, hash: 'evt-hash', event_hash: 'evt-hash', title: 'AI Integration Event', description: 'Desc', severity: 'info', started_at: 1000
      } as T;
    }
    return null as T;
  }

  if (seed && (upperQuery.includes('SELECT COUNT(*) AS TOTAL FROM ARTICLES_RAW') || upperQuery.includes('SELECT COUNT(DISTINCT ARTICLES_RAW.ID) AS TOTAL FROM ARTICLES_RAW'))) {
    return { total: 1 } as T;
  }

  const key = `${query}:${JSON.stringify(values)}`;
  const rows = storage.get(key) ?? [];
  return (rows[0] ?? null) as T | null;
},
        all: async <T>() => {
          const upperQuery = query.toUpperCase();

          if (seed && upperQuery.includes('WITH ACTIVE_EVENTS AS')) {
            return {
              results: [
                {
                  id: 1,
                  hash: 'evt-hash',
                  title: 'AI Integration Event',
                  description: 'Desc',
                  severity: 'warning',
                  status: 'active',
                  started_at: 1000,
                  article_count: 5,
                  source_count: 2,
                  last_published_at: 1000,
                  topic_slugs_raw: 'ai-integration-topic',
                  source_names_raw: 'Integration Source,TechCrunch',
                  brief_version: 2,
                  has_narrative_delta: 1,
                  has_claim_comparison: 1,
                },
                {
                  id: 2,
                  hash: 'evt-hash-2',
                  title: 'Second Active Event',
                  description: 'Desc 2',
                  severity: 'info',
                  status: 'active',
                  started_at: 900,
                  article_count: 2,
                  source_count: 1,
                  last_published_at: 950,
                  topic_slugs_raw: 'machine-learning',
                  source_names_raw: 'Integration Source',
                  brief_version: 1,
                  has_narrative_delta: 0,
                  has_claim_comparison: 0,
                },
              ] as unknown as T[],
              success: true,
              meta: {},
            };
          }

          if (seed && upperQuery.includes('WHERE E.STATUS = \'ACTIVE\'') && upperQuery.includes('GROUP BY E.ID')) {
             return {
                results: [
                  { hash: 'evt-hash-crit', title: 'Critical Event', description: 'Desc', severity: 'critical', started_at: 1000, article_count: 50, last_published_at: 1000 },
                  { hash: 'evt-hash-warn', title: 'Warning Event', description: 'Desc', severity: 'warning', started_at: 1000, article_count: 20, last_published_at: 1000 },
                  { hash: 'evt-hash-info', title: 'Info Event', description: 'Desc', severity: 'info', started_at: 1000, article_count: 10, last_published_at: 1000 }
                ] as unknown as T[],
                success: true, meta: {}
             };
          }
          if (seed && (upperQuery.includes('SELECT * FROM ARTICLES_RAW') || upperQuery.includes('SELECT DISTINCT ARTICLES_RAW.* FROM ARTICLES_RAW'))) {
            return {
              results: [{
                id: 1, external_id: 'ext-1', source_id: 1, title: 'Integration Test Article',
                summary: 'Sum', url: 'http://test', raw_content: '',
                published_at: 1000, fetched_at: 1000, language: 'en',
                status: 'processed', created_at: 1000
              }] as unknown as T[],
              success: true, meta: {}
            };
          }
          if (seed && upperQuery.includes('SELECT COUNT(*) AS TOTAL FROM ARTICLES_RAW') || upperQuery.includes('SELECT COUNT(DISTINCT ARTICLES_RAW.ID) AS TOTAL FROM ARTICLES_RAW')) {
            return {
              results: [{ total: 1 }] as unknown as T[],
              success: true, meta: {}
            };
          }
          if (seed && upperQuery.includes('COUNT(A.ID) AS ARTICLE_COUNT') && upperQuery.includes('WHERE E.EVENT_HASH = ?')) {
            return {
              results: [{ name: 'Integration Source', article_count: 1, first_published_at: 1000 }] as unknown as T[],
              success: true, meta: {}
            };
          }
          if (seed && upperQuery.includes('FROM ARTICLES_RAW A') && upperQuery.includes('WHERE E.EVENT_HASH = ?')) {
            return {
              results: [{
                id: 1, external_id: 'ext-1', source_id: 1, title: 'Integration Test Article',
                summary: 'Sum', url: 'http://test', raw_content: '',
                published_at: 1000, fetched_at: 1000, language: 'en',
                status: 'processed', created_at: 1000
              }] as unknown as T[],
              success: true, meta: {}
            };
          }
          if (seed && upperQuery.includes('FROM ARTICLE_TOPICS AT')) {
            return {
              results: [{ article_raw_id: 1, name: 'AI Integration Topic' }] as unknown as T[],
              success: true, meta: {}
            };
          }
          if (seed && upperQuery.includes('FROM ARTICLE_EVENTS AE')) {
            if (upperQuery.includes('SELECT E.EVENT_HASH, E.TITLE, E.DESCRIPTION, E.SEVERITY, E.STARTED_AT')) {
              return {
                results: [{ event_hash: 'evt-hash', title: 'AI Integration Event', description: 'Desc', severity: 'info', started_at: 1000 }] as unknown as T[],
                success: true, meta: {}
              };
            }
            if (upperQuery.includes('E.EVENT_HASH')) {
               return {
                results: [{ article_raw_id: 1, title: 'AI Integration Event', event_hash: 'evt-hash' }] as unknown as T[],
                success: true, meta: {}
              };
            }
            return {
              results: [{ article_raw_id: 1, title: 'AI Integration Event' }] as unknown as T[],
              success: true, meta: {}
            };
          }
          if (seed && upperQuery.includes('FROM SOURCES WHERE ID IN')) {
            return {
              results: [{ id: 1, name: 'Integration Source' }] as unknown as T[],
              success: true, meta: {}
            };
          }

          if (upperQuery.includes('FROM USER_FOLLOWS') && upperQuery.includes('TARGET_TYPE =')) {
            const res = follows.filter(f => f.user_id === values[0] && f.target_type === values[1]);
            return { results: res as unknown as T[], success: true, meta: {} };
          }
          if (upperQuery.includes('FROM USER_FOLLOWS')) {
            const res = follows.filter(f => f.user_id === values[0]);
            return { results: res as unknown as T[], success: true, meta: {} };
          }

          const key = `${query}:${JSON.stringify(values)}`;
          const rows = storage.get(key) ?? [];
          return { results: rows as T[], success: true, meta: {} };
        },
        run: async () => {
          const upperQuery = query.toUpperCase();
          if (upperQuery.includes('INSERT INTO USER_FOLLOWS')) {
            const userId = values[0] as string;
            const targetType = values[1] as string;
            const targetId = values[2] as string;
            const createdAt = (values[3] as number) || 1000;
            if (!follows.some(f => f.user_id === userId && f.target_type === targetType && f.target_id === targetId)) {
              follows.push({ id: `f-${follows.length + 1}`, user_id: userId, target_type: targetType, target_id: targetId, created_at: createdAt });
            }
            return { success: true, meta: { changes: 1, last_row_id: follows.length } };
          }
          if (upperQuery.includes('DELETE FROM USER_FOLLOWS')) {
            const userId = values[0] as string;
            const targetType = values[1] as string;
            const targetId = values[2] as string;
            const initialLen = follows.length;
            const remaining = follows.filter(f => !(f.user_id === userId && f.target_type === targetType && f.target_id === targetId));
            follows.length = 0;
            follows.push(...remaining);
            const changes = initialLen - remaining.length;
            return { success: true, meta: { changes, last_row_id: 0 } };
          }
          if (upperQuery.includes('INSERT OR IGNORE INTO USERS')) {
            const userId = values[0] as string;
            const createdAt = (values[1] as number) || 1000;
            if (!users.has(userId)) {
              users.set(userId, { id: userId, created_at: createdAt, last_active_at: createdAt });
            }
            return { success: true, meta: { changes: 1, last_row_id: 1 } };
          }
          return { success: true, meta: { changes: 1, last_row_id: 1 } };
        },
      });
      return {
        bind,
        first: async <T>() => bind().first<T>(),
        all: async <T>() => bind().all<T>(),
        run: async () => bind().run(),
      };
    },
    batch: async <T>(statements: D1PreparedStatement[]) =>
      statements.map(() => ({ results: [] as T[], success: true, meta: {} })),
    dump: async () => new ArrayBuffer(0),
    exec: async () => ({ count: 0, duration: 0 }),
  } as unknown as D1Database;
}

export function createMockKVNamespace(): KVNamespace {
  const store = new Map<string, { value: string; expiration?: number }>();
  return {
    get: async (key: string) => {
      const entry = store.get(key);
      if (!entry) return null;
      if (entry.expiration && entry.expiration < Math.floor(Date.now() / 1000)) {
        store.delete(key);
        return null;
      }
      return entry.value;
    },
    put: async (key: string, value: string, options?: { expirationTtl?: number; expiration?: number }) => {
      const expiration = options?.expirationTtl
        ? Math.floor(Date.now() / 1000) + options.expirationTtl
        : options?.expiration;
      store.set(key, { value, expiration });
    },
    delete: async (key: string) => { store.delete(key); },
    list: async () => ({ keys: [], list_complete: true, cursor: '' }),
    getWithMetadata: async () => ({ value: null, metadata: null, cacheStatus: null }),
  } as unknown as KVNamespace;
}

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
  return {
    prepare: (query: string) => ({
      bind: (...values: unknown[]) => ({
        first: async <T>() => {
  const upperQuery = query.toUpperCase();




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

  if (seed && upperQuery.includes('SELECT * FROM ARTICLES_RAW WHERE ID = ?') && values[0] === 1) {
    return {
      id: 1, external_id: 'ext-1', source_id: 1, title: 'Integration Test Article',
      summary: 'Sum', url: 'http://test', raw_content: '',
      published_at: 1000, fetched_at: 1000, language: 'en',
      status: 'processed', created_at: 1000
    } as T;
  }

  if (seed && upperQuery.includes('FROM EVENTS WHERE EVENT_HASH = ?')) {
    return {
      hash: 'evt-hash', title: 'AI Integration Event', description: 'Desc', severity: 'info', started_at: 1000
    } as T;
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

          const key = `${query}:${JSON.stringify(values)}`;
          const rows = storage.get(key) ?? [];
          return { results: rows as T[], success: true, meta: {} };
        },
        run: async () => ({ success: true, meta: { changes: 1, last_row_id: 1 } }),
      }),
      first: async <T>() => null as T | null,
      all: async <T>() => ({ results: [] as T[], success: true, meta: {} }),
      run: async () => ({ success: true, meta: { changes: 0, last_row_id: 0 } }),
    }),
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

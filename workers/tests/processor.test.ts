import { describe, it, expect, vi } from 'vitest';
import { processArticle } from '../src/tasks/processor';
import { createMockEnv } from './setup';
import * as dbClientModule from '../src/db/client';
import * as geminiModule from '../src/tasks/gemini';
import type { ArticleRaw } from '../src/types';

describe('Article Processor', () => {
  it('processes article successfully', async () => {
    const env = createMockEnv();
    const article: ArticleRaw = {
      id: 1, external_id: 'e1', source_id: 1, title: 'Title', summary: 'S', url: 'u',
      raw_content: 'content', published_at: null, fetched_at: 0, language: 'en', status: 'pending', created_at: 0
    };

    const mockDbClient = {
      createAiJob: vi.fn().mockResolvedValue({ id: 10 }),
      createArticleContent: vi.fn(),
      getTopicBySlug: vi.fn().mockResolvedValue(null),
      createTopic: vi.fn().mockResolvedValue(20),
      linkArticleTopic: vi.fn(),
      getEventByHash: vi.fn().mockResolvedValue(null),
      createEvent: vi.fn().mockResolvedValue(30),
      linkArticleEvent: vi.fn(),
      updateArticleStatus: vi.fn(),
      updateAiJobStatus: vi.fn(),
      createAiLog: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

    const mockEnrichment = {
      summary: 'summary',
      topics: ['topic1'],
      events: [{ title: 'e1', description: 'desc', severity: 'medium' }]
    };
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue(mockEnrichment as any);

    await processArticle(env, article);

    expect(mockDbClient.createArticleContent).toHaveBeenCalled();
    expect(mockDbClient.createEvent).toHaveBeenCalled();
    expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(1, 'processed');
    expect(mockDbClient.updateAiJobStatus).toHaveBeenCalledWith(10, 'completed', JSON.stringify(mockEnrichment));
  });

  it('rejects invalid AI JSON', async () => {
    const env = createMockEnv();
    const article: ArticleRaw = {
      id: 1, external_id: 'e1', source_id: 1, title: 'Title', summary: 'S', url: 'u',
      raw_content: 'content', published_at: null, fetched_at: 0, language: 'en', status: 'pending', created_at: 0
    };

    const mockDbClient = {
      createAiJob: vi.fn().mockResolvedValue({ id: 10 }),
      createAiLog: vi.fn(),
      updateAiJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue({ invalid: 'structure' } as any);

    await expect(processArticle(env, article)).rejects.toThrow();
    expect(mockDbClient.updateAiJobStatus).toHaveBeenCalledWith(10, 'failed', undefined, expect.any(String));
  });

  it('retries on 429', async () => {
    const env = createMockEnv();
    const article: ArticleRaw = {
      id: 1, external_id: 'e1', source_id: 1, title: 'Title', summary: 'S', url: 'u',
      raw_content: 'content', published_at: null, fetched_at: 0, language: 'en', status: 'pending', created_at: 0
    };

    const mockDbClient = {
      createAiJob: vi.fn().mockResolvedValue({ id: 10 }),
      createArticleContent: vi.fn(),
      getTopicBySlug: vi.fn().mockResolvedValue(null),
      createTopic: vi.fn().mockResolvedValue(20),
      linkArticleTopic: vi.fn(),
      getEventByHash: vi.fn().mockResolvedValue(null),
      createEvent: vi.fn().mockResolvedValue(30),
      linkArticleEvent: vi.fn(),
      updateArticleStatus: vi.fn(),
      updateAiJobStatus: vi.fn(),
      createAiLog: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    const geminiSpy = vi.spyOn(geminiModule, 'generateEnrichment')
      .mockRejectedValueOnce(new Error('429 Too Many Requests'))
      .mockResolvedValue({ summary: 's', topics: [], events: [] } as any);

    await processArticle(env, article);
    expect(geminiSpy).toHaveBeenCalledTimes(2);
  });
});

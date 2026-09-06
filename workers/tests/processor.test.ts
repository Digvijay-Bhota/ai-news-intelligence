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
      getRecentActiveEvents: vi.fn().mockResolvedValue([]),
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

  it('rejects invalid AI JSON structure', async () => {
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

    await expect(processArticle(env, article)).rejects.toThrow('Invalid structure: summary must be a string');
    expect(mockDbClient.updateAiJobStatus).toHaveBeenCalledWith(10, 'failed', undefined, expect.any(String));
  });

  it('rejects missing or null event description', async () => {
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
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue({
      summary: 's', topics: [], events: [{ title: 't', description: null, severity: 'low' }]
    } as any);

    await expect(processArticle(env, article)).rejects.toThrow('Invalid event structure: description must be a non-empty string');
  });

  it('rejects invalid event severity', async () => {
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
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue({
      summary: 's', topics: [], events: [{ title: 't', description: 'd', severity: 'extreme' }]
    } as any);

    await expect(processArticle(env, article)).rejects.toThrow('Invalid event structure: severity must be one of low, medium, high, critical');
  });

  it('allows empty events array', async () => {
    const env = createMockEnv();
    const article: ArticleRaw = {
      id: 1, external_id: 'e1', source_id: 1, title: 'Title', summary: 'S', url: 'u',
      raw_content: 'content', published_at: null, fetched_at: 0, language: 'en', status: 'pending', created_at: 0
    };

    const mockDbClient = {
      createAiJob: vi.fn().mockResolvedValue({ id: 10 }),
      createArticleContent: vi.fn(),
      updateArticleStatus: vi.fn(),
      updateAiJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

    const mockEnrichment = { summary: 's', topics: [], events: [] };
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue(mockEnrichment as any);

    await processArticle(env, article);
    expect(mockDbClient.updateAiJobStatus).toHaveBeenCalledWith(10, 'completed', JSON.stringify(mockEnrichment));
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
      getRecentActiveEvents: vi.fn().mockResolvedValue([]),
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

  it('uses matched event on semantic match', async () => {
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
      getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 99, event_hash: 'abc', title: 'Old Title', description: 'Old desc', severity: 'high' }]),
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
      topics: [],
      events: [{ title: 'New Title', description: 'New desc', severity: 'high' }]
    };
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue(mockEnrichment as any);
    vi.spyOn(geminiModule, 'matchEventToCluster').mockResolvedValue({ match: true, event_id: 99 });

    await processArticle(env, article);

    expect(mockDbClient.createEvent).not.toHaveBeenCalled();
    expect(mockDbClient.linkArticleEvent).toHaveBeenCalledWith(1, 99, 1.0);
  });

  it('creates new event on semantic no-match', async () => {
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
      getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 99, event_hash: 'abc', title: 'Old Title', description: 'Old desc', severity: 'high' }]),
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
      topics: [],
      events: [{ title: 'New Title', description: 'New desc', severity: 'high' }]
    };
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue(mockEnrichment as any);
    vi.spyOn(geminiModule, 'matchEventToCluster').mockResolvedValue({ match: false, event_id: null });

    await processArticle(env, article);

    expect(mockDbClient.createEvent).toHaveBeenCalled();
    expect(mockDbClient.linkArticleEvent).toHaveBeenCalledWith(1, 30, 1.0);
  });

  it('falls back to new event if semantic matcher fails', async () => {
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
      getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 99, event_hash: 'abc', title: 'Old Title', description: 'Old desc', severity: 'high' }]),
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
      topics: [],
      events: [{ title: 'New Title', description: 'New desc', severity: 'high' }]
    };
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue(mockEnrichment as any);
    vi.spyOn(geminiModule, 'matchEventToCluster').mockRejectedValue(new Error('AI matching failed'));

    await processArticle(env, article);

    expect(mockDbClient.createEvent).toHaveBeenCalled();
    expect(mockDbClient.linkArticleEvent).toHaveBeenCalledWith(1, 30, 1.0);
  });

  it('falls back to new event if matcher returns unknown ID', async () => {
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
      getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 99, event_hash: 'abc', title: 'Old Title', description: 'Old desc', severity: 'high' }]),
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
      topics: [],
      events: [{ title: 'New Title', description: 'New desc', severity: 'high' }]
    };
    vi.spyOn(geminiModule, 'generateEnrichment').mockResolvedValue(mockEnrichment as any);
    vi.spyOn(geminiModule, 'matchEventToCluster').mockResolvedValue({ match: true, event_id: 12345 });

    await processArticle(env, article);

    expect(mockDbClient.createEvent).toHaveBeenCalled();
    expect(mockDbClient.linkArticleEvent).toHaveBeenCalledWith(1, 30, 1.0);
  });
});

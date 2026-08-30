import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from '../src/tasks/orchestrator';
import { createMockEnv } from './setup';
import * as dbClientModule from '../src/db/client';
import * as fetcherModule from '../src/tasks/fetcher';
import * as processorModule from '../src/tasks/processor';

describe('Orchestrator', () => {
  it('runs successful pipeline', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      listSources: vi.fn().mockResolvedValue([{ id: 1, feed_url: 'u' }]),
      getSourceHealth: vi.fn().mockResolvedValue(null),
      updateSourceHealth: vi.fn(),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(true),
      listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
      claimFailedArticle: vi.fn().mockResolvedValue(true),
      updatePipelineJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    const fetchSpy = vi.spyOn(fetcherModule, 'fetchAndIngest').mockResolvedValue(1);
    const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

    await runPipeline(env);

    expect(fetchSpy).toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalled();
    expect(mockDbClient.updateSourceHealth).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'healthy' }));
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined);
  });

  it('isolates failures', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      listSources: vi.fn().mockResolvedValue([{ id: 1, feed_url: 'u' }]),
      getSourceHealth: vi.fn().mockResolvedValue(null),
      updateSourceHealth: vi.fn(),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(true),
      listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
      claimFailedArticle: vi.fn().mockResolvedValue(true),
      updateArticleStatus: vi.fn(),
      updatePipelineJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    vi.spyOn(fetcherModule, 'fetchAndIngest').mockRejectedValue(new Error('Fetch fail'));
    vi.spyOn(processorModule, 'processArticle').mockRejectedValue(new Error('Process fail'));

    await runPipeline(env);

    expect(mockDbClient.updateSourceHealth).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'down', error_message: 'Fetch fail' }));
    expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(1, 'failed');
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined);
  });

  it('correctly finalizes pipeline on unexpected error', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      listSources: vi.fn().mockRejectedValue(new Error('Fatal DB Error')),
      updatePipelineJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

    await expect(runPipeline(env)).rejects.toThrow('Fatal DB Error');
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'failed', 'Fatal DB Error');
  });

  describe('Unified Retry and Budget Mechanism', () => {
    it('processes exactly 20 pending articles and zero retries if pending fills budget', async () => {
      const env = createMockEnv();
      const mockArticles = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockArticles }),
        claimArticle: vi.fn().mockResolvedValue(true),
        listRetryableFailedArticles: vi.fn(),
        claimFailedArticle: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

      await runPipeline(env);

      expect(processSpy).toHaveBeenCalledTimes(20);
      expect(mockDbClient.listRetryableFailedArticles).not.toHaveBeenCalled();
    });

    it('allocates remaining slots to retries if pending is under budget', async () => {
      const env = createMockEnv();
      const mockPending = Array.from({ length: 15 }, (_, i) => ({ id: i + 1 }));
      const mockRetries = Array.from({ length: 10 }, (_, i) => ({ id: i + 100 }));
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockPending }),
        claimArticle: vi.fn().mockResolvedValue(true),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        claimFailedArticle: vi.fn().mockResolvedValue(true),
        updatePipelineJobStatus: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

      await runPipeline(env);

      // 15 pending + 5 retries = 20 total
      expect(mockDbClient.claimArticle).toHaveBeenCalledTimes(15);
      expect(mockDbClient.listRetryableFailedArticles).toHaveBeenCalledWith(5);
      expect(mockDbClient.claimFailedArticle).toHaveBeenCalledTimes(5);
      expect(processSpy).toHaveBeenCalledTimes(20);
    });

    it('does not increment totalAttempts on failed claims', async () => {
      const env = createMockEnv();
      const mockPending = [{ id: 1 }, { id: 2 }];
      const mockRetries = [{ id: 3 }, { id: 4 }];
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockPending }),
        // First pending claim fails, second succeeds
        claimArticle: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        // First retry claim fails, second succeeds
        claimFailedArticle: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        updatePipelineJobStatus: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

      await runPipeline(env);

      // Only 2 total successful claims
      expect(processSpy).toHaveBeenCalledTimes(2);
      expect(processSpy).toHaveBeenCalledWith(env, mockPending[1]);
      expect(processSpy).toHaveBeenCalledWith(env, mockRetries[1]);
    });

    it('returns retry failure to failed status', async () => {
      const env = createMockEnv();
      const mockRetries = [{ id: 100 }];
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        claimArticle: vi.fn(),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        claimFailedArticle: vi.fn().mockResolvedValue(true),
        updateArticleStatus: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      vi.spyOn(processorModule, 'processArticle').mockRejectedValue(new Error('Retry fail'));

      await runPipeline(env);

      expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(100, 'failed');
    });
  });
});

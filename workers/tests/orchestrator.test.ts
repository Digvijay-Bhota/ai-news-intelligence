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
      updateSourceHealth: vi.fn(),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(true),
      updatePipelineJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    const fetchSpy = vi.spyOn(fetcherModule, 'fetchAndIngest').mockResolvedValue(1);
    const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

    await runPipeline(env);

    expect(fetchSpy).toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalled();
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed');
  });

  it('isolates failures', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      listSources: vi.fn().mockResolvedValue([{ id: 1, feed_url: 'u' }]),
      updateSourceHealth: vi.fn(),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(true),
      updateArticleStatus: vi.fn(),
      updatePipelineJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    vi.spyOn(fetcherModule, 'fetchAndIngest').mockRejectedValue(new Error('Fetch fail'));
    vi.spyOn(processorModule, 'processArticle').mockRejectedValue(new Error('Process fail'));

    await runPipeline(env);

    expect(mockDbClient.updateSourceHealth).toHaveBeenCalledWith(1, 'failed', 'Fetch fail');
    expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(1, 'failed');
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed');
  });

  it('does not process article if claiming fails', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      listSources: vi.fn().mockResolvedValue([]),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(false),
      updateArticleStatus: vi.fn(),
      updatePipelineJobStatus: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

    await runPipeline(env);

    expect(processSpy).not.toHaveBeenCalled();
    expect(mockDbClient.updateArticleStatus).not.toHaveBeenCalled();
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed');
  });
});

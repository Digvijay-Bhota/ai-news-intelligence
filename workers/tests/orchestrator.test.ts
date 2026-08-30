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
});

import { describe, it, expect, vi } from 'vitest';
import { runPipeline } from '../src/tasks/orchestrator';
import { createMockEnv } from './setup';
import * as dbClientModule from '../src/db/client';
import * as fetcherModule from '../src/tasks/fetcher';
import * as processorModule from '../src/tasks/processor';
import * as briefGenModule from '../src/tasks/brief-generator';
import * as commGenModule from '../src/tasks/community-signal-generator';
import * as claimGenModule from '../src/tasks/claim-comparison-generator';
import { GeminiDeferredError } from '../src/tasks/model-router';

describe('Orchestrator', () => {
  it('runs successful pipeline', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
      listSources: vi.fn().mockResolvedValue([{ id: 1, feed_url: 'u' }]),
      getSourceHealth: vi.fn().mockResolvedValue(null),
      updateSourceHealth: vi.fn(),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(true),
      listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
      claimFailedArticle: vi.fn().mockResolvedValue(true),
      updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    const fetchSpy = vi.spyOn(fetcherModule, 'fetchAndIngest').mockResolvedValue({ parsed: 1, inserted: 1, newest_published_at: null });
    const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

    await runPipeline(env);

    expect(fetchSpy).toHaveBeenCalled();
    expect(processSpy).toHaveBeenCalled();
    expect(mockDbClient.updateSourceHealth).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'healthy' }));
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined, expect.any(String));
  });

  it('isolates failures', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
      listSources: vi.fn().mockResolvedValue([{ id: 1, feed_url: 'u' }]),
      getSourceHealth: vi.fn().mockResolvedValue(null),
      updateSourceHealth: vi.fn(),
      listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }] }),
      claimArticle: vi.fn().mockResolvedValue(true),
      listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
      claimFailedArticle: vi.fn().mockResolvedValue(true),
      updateArticleStatus: vi.fn(),
      updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
    vi.spyOn(fetcherModule, 'fetchAndIngest').mockRejectedValue(new Error('Fetch fail'));
    vi.spyOn(processorModule, 'processArticle').mockRejectedValue(new Error('Process fail'));

    await runPipeline(env);

    expect(mockDbClient.updateSourceHealth).toHaveBeenCalledWith(1, expect.objectContaining({ status: 'down', error_message: 'Fetch fail' }));
    expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(1, 'failed');
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined, expect.any(String));
  });

  it('correctly finalizes pipeline on unexpected error', async () => {
    const env = createMockEnv();
    const mockDbClient = {
      createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
      recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
      listSources: vi.fn().mockRejectedValue(new Error('Fatal DB Error')),
      updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
    };
    vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);

    await expect(runPipeline(env)).rejects.toThrow('Fatal DB Error');
    expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'failed', 'Fatal DB Error', expect.any(String));
  });

  describe('Unified Retry and Budget Mechanism', () => {
    it('processes exactly 20 pending articles and zero retries if pending fills budget', async () => {
      const env = createMockEnv();
      const mockArticles = Array.from({ length: 25 }, (_, i) => ({ id: i + 1 }));
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockArticles }),
        claimArticle: vi.fn().mockResolvedValue(true),
        listRetryableFailedArticles: vi.fn(),
        claimFailedArticle: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
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
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockPending }),
        claimArticle: vi.fn().mockResolvedValue(true),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        claimFailedArticle: vi.fn().mockResolvedValue(true),
        updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
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
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockPending }),
        // First pending claim fails, second succeeds
        claimArticle: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        // First retry claim fails, second succeeds
        claimFailedArticle: vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
        updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
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
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        claimArticle: vi.fn(),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        claimFailedArticle: vi.fn().mockResolvedValue(true),
        updateArticleStatus: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
      recoverStaleProcessingArticles: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      vi.spyOn(processorModule, 'processArticle').mockRejectedValue(new Error('Retry fail'));

      await runPipeline(env);

      expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(100, 'failed');
    });
  });

  describe('Phase 14 Scheduled Community Signal Generation', () => {
    it('calls generateCommunitySignalsForEvent for active events and isolates failures', async () => {
      const env = createMockEnv();
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
        hasEventBriefsTable: vi.fn().mockResolvedValue(true),
        getRecentActiveEvents: vi.fn().mockResolvedValue([
          { id: 1, event_hash: 'hash-1' },
          { id: 2, event_hash: 'hash-2' }
        ]),
        getEventDetailByHash: vi.fn().mockResolvedValue(null),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      
      const commSpy = vi.spyOn(commGenModule, 'generateCommunitySignalsForEvent')
        .mockRejectedValueOnce(new Error('Signal gen fail')) // Event 1 fails
        .mockResolvedValueOnce(undefined); // Event 2 succeeds

      await runPipeline(env);

      expect(commSpy).toHaveBeenCalledTimes(2);
      expect(commSpy).toHaveBeenNthCalledWith(1, env, 1);
      expect(commSpy).toHaveBeenNthCalledWith(2, env, 2);
      expect(mockDbClient.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined, expect.any(String));
    });
  });

  describe('Phase 9 Event Brief Synthesis', () => {
    it('skips brief generation if event_briefs table is not yet migrated', async () => {
      const env = createMockEnv();
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
        hasEventBriefsTable: vi.fn().mockResolvedValue(false),
        getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 1, event_hash: 'hash-1' }]),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const briefSpy = vi.spyOn(briefGenModule, 'generateAndSaveEventBrief');

      await runPipeline(env);

      expect(mockDbClient.hasEventBriefsTable).toHaveBeenCalled();
      expect(mockDbClient.getRecentActiveEvents).not.toHaveBeenCalled();
      expect(briefSpy).not.toHaveBeenCalled();
    });

    it('skips brief generation if completed brief already matches current fingerprint', async () => {
      const env = createMockEnv();
      const mockArticles = [{ id: 1, title: 'A', source_id: 1, published_at: 1000 }];
      const fp = 'deterministic-fp-123';
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
        hasEventBriefsTable: vi.fn().mockResolvedValue(true),
        getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 1, event_hash: 'hash-1' }]),
        getEventDetailByHash: vi.fn().mockResolvedValue({
          articles: mockArticles,
        }),
        getLatestEventBrief: vi.fn().mockResolvedValue({
          article_fingerprint: fp,
          status: 'completed',
        }),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      vi.spyOn(briefGenModule, 'computeArticleFingerprint').mockResolvedValue(fp);
      const briefSpy = vi.spyOn(briefGenModule, 'generateAndSaveEventBrief').mockResolvedValue({} as any);

      await runPipeline(env);

      expect(mockDbClient.getLatestEventBrief).toHaveBeenCalledWith(1);
      expect(briefSpy).not.toHaveBeenCalled();
    });

    it('skips brief generation if previous attempt failed recently (cooldown active)', async () => {
      const env = createMockEnv();
      const mockArticles = [{ id: 1, title: 'A', source_id: 1, published_at: 1000 }];
      const fp = 'deterministic-fp-123';
      const now = Math.floor(Date.now() / 1000);
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
        hasEventBriefsTable: vi.fn().mockResolvedValue(true),
        getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 1, event_hash: 'hash-1' }]),
        getEventDetailByHash: vi.fn().mockResolvedValue({
          articles: mockArticles,
        }),
        getLatestEventBrief: vi.fn().mockResolvedValue({
          article_fingerprint: fp,
          status: 'failed',
          updated_at: now - 300, // failed 5 minutes ago (within 1-hr cooldown)
        }),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      vi.spyOn(briefGenModule, 'computeArticleFingerprint').mockResolvedValue(fp);
      const briefSpy = vi.spyOn(briefGenModule, 'generateAndSaveEventBrief').mockResolvedValue({} as any);

      await runPipeline(env);

      expect(briefSpy).not.toHaveBeenCalled();
    });

    it('triggers brief generation when fingerprint has changed', async () => {
      const env = createMockEnv();
      const mockArticles = [{ id: 1, title: 'A', source_id: 1, published_at: 1000 }];
      const newFp = 'new-fp-456';
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
        hasEventBriefsTable: vi.fn().mockResolvedValue(true),
        getRecentActiveEvents: vi.fn().mockResolvedValue([{ id: 1, event_hash: 'hash-1', title: 'T', description: 'D', severity: 'info' }]),
        getEventDetailByHash: vi.fn().mockResolvedValue({
          articles: mockArticles,
        }),
        getLatestEventBrief: vi.fn().mockResolvedValue({
          article_fingerprint: 'old-fp-123',
          status: 'completed',
        }),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      vi.spyOn(briefGenModule, 'computeArticleFingerprint').mockResolvedValue(newFp);
      const briefSpy = vi.spyOn(briefGenModule, 'generateAndSaveEventBrief').mockResolvedValue({} as any);

      await runPipeline(env);

      expect(briefSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Gemini model deferral (no eligible model available)', () => {
    it('returns a deferred pending-pass article to pending and stops the run without starting the retry pass', async () => {
      const env = createMockEnv();
      const mockArticles = [{ id: 1 }, { id: 2 }];
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockArticles }),
        claimArticle: vi.fn().mockResolvedValue(true),
        listRetryableFailedArticles: vi.fn(),
        claimFailedArticle: vi.fn(),
        updateArticleStatus: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const deferredErr = new GeminiDeferredError('enrichment', 'models_unavailable', [], null);
      const processSpy = vi.spyOn(processorModule, 'processArticle').mockRejectedValue(deferredErr);

      await runPipeline(env);

      // The deferral ends article processing for this run: article 2 is never attempted,
      // and the retry pass never runs.
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(1, 'pending');
      expect(mockDbClient.updateArticleStatus).not.toHaveBeenCalledWith(1, 'failed');
      expect(mockDbClient.listRetryableFailedArticles).not.toHaveBeenCalled();
    });

    it('returns a deferred retry-pass article to failed (its retry budget untouched) and stops the run', async () => {
      const env = createMockEnv();
      const mockRetries = [{ id: 100 }, { id: 101 }];
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        claimArticle: vi.fn(),
        listRetryableFailedArticles: vi.fn().mockResolvedValue(mockRetries),
        claimFailedArticle: vi.fn().mockResolvedValue(true),
        updateArticleStatus: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const deferredErr = new GeminiDeferredError('enrichment', 'models_unavailable', [], null);
      const processSpy = vi.spyOn(processorModule, 'processArticle').mockRejectedValue(deferredErr);

      await runPipeline(env);

      // Article 101 is never attempted once the first retry defers.
      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(mockDbClient.claimFailedArticle).toHaveBeenCalledTimes(1);
      expect(mockDbClient.updateArticleStatus).toHaveBeenCalledWith(100, 'failed');
    });

    it('does not attempt the same article twice in one run across the pending and retry passes', async () => {
      const env = createMockEnv();
      const mockArticles = [{ id: 1 }];
      const mockDbClient = {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: mockArticles }),
        claimArticle: vi.fn().mockResolvedValue(true),
        // If the orchestrator asked for retry candidates, article 1 (already attempted) must be filtered out by id.
        listRetryableFailedArticles: vi.fn().mockResolvedValue([{ id: 1 }]),
        claimFailedArticle: vi.fn(),
        updateArticleStatus: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn(),
      };
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(mockDbClient as any);
      const processSpy = vi.spyOn(processorModule, 'processArticle').mockResolvedValue(undefined);

      await runPipeline(env);

      expect(processSpy).toHaveBeenCalledTimes(1);
      expect(mockDbClient.claimFailedArticle).not.toHaveBeenCalled();
    });
  });

  describe('Run summary counters', () => {
    function baseDb(overrides: Record<string, unknown> = {}): Record<string, any> {
      return {
        createPipelineJob: vi.fn().mockResolvedValue({ id: 1 }),
        recoverStalePipelineJobs: vi.fn().mockResolvedValue(0),
        listSources: vi.fn().mockResolvedValue([]),
        listArticles: vi.fn().mockResolvedValue({ articles: [] }),
        claimArticle: vi.fn().mockResolvedValue(true),
        listRetryableFailedArticles: vi.fn().mockResolvedValue([]),
        claimFailedArticle: vi.fn().mockResolvedValue(true),
        updateArticleStatus: vi.fn(),
        updatePipelineJobStatus: vi.fn(),
        recoverStaleProcessingArticles: vi.fn().mockResolvedValue(0),
        hasEventBriefsTable: vi.fn().mockResolvedValue(true),
        getRecentActiveEvents: vi.fn().mockResolvedValue([]),
        ...overrides,
      };
    }

    function persistedSummary(db: Record<string, any>) {
      const call = db.updatePipelineJobStatus.mock.calls.at(-1)!;
      return JSON.parse(call[3]);
    }

    it('counts pending attempts, failures and a deferral separately; a deferral is not a failure', async () => {
      const env = createMockEnv();
      const db = baseDb({
        listArticles: vi.fn().mockResolvedValue({ articles: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] }),
        recoverStaleProcessingArticles: vi.fn().mockResolvedValue(2),
      });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);
      vi.spyOn(processorModule, 'processArticle')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Enrichment failed'))
        .mockRejectedValueOnce(new GeminiDeferredError('enrichment', 'models_unavailable', [], null));

      await runPipeline(env);

      expect(db.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined, expect.any(String));
      const summary = persistedSummary(db);
      expect(summary.processing).toEqual({ attempted: 3, succeeded: 1, failed: 1, deferred: 1 });
      // The deferral ends article processing, so the retry pass makes no attempts.
      expect(summary.retries).toEqual({ attempted: 0, succeeded: 0, failed: 0, deferred: 0 });
      expect(summary.stale_articles_recovered).toBe(2);
    });

    it('counts retry attempts, failures and a deferral', async () => {
      const env = createMockEnv();
      const db = baseDb({
        listRetryableFailedArticles: vi.fn().mockResolvedValue([{ id: 100 }, { id: 101 }, { id: 102 }, { id: 103 }]),
      });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);
      vi.spyOn(processorModule, 'processArticle')
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('Retry failed'))
        .mockRejectedValueOnce(new GeminiDeferredError('enrichment', 'models_unavailable', [], null));

      await runPipeline(env);

      const summary = persistedSummary(db);
      expect(summary.processing).toEqual({ attempted: 0, succeeded: 0, failed: 0, deferred: 0 });
      expect(summary.retries).toEqual({ attempted: 3, succeeded: 1, failed: 1, deferred: 1 });
    });

    it('counts briefs generated, failed and deferred, ignoring events whose brief is current', async () => {
      const env = createMockEnv();
      const events = [1, 2, 3, 4].map((id) => ({ id, event_hash: `hash-${id}`, title: 'T', description: null, severity: 'info' }));
      const db = baseDb({
        getRecentActiveEvents: vi.fn().mockResolvedValue(events),
        getEventDetailByHash: vi.fn().mockResolvedValue({ articles: [{ id: 1, source_id: 1, published_at: 1000 }] }),
        getLatestEventBrief: vi.fn(async (eventId: number) =>
          eventId === 4 ? { article_fingerprint: 'fp', status: 'completed', version: 1 } : null),
      });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);
      vi.spyOn(commGenModule, 'generateCommunitySignalsForEvent').mockResolvedValue(undefined as any);
      vi.spyOn(briefGenModule, 'computeArticleFingerprint').mockResolvedValue('fp');
      vi.spyOn(claimGenModule, 'generateAndSaveClaimComparisons').mockResolvedValue([] as any);
      const briefSpy = vi.spyOn(briefGenModule, 'generateAndSaveEventBrief')
        .mockResolvedValueOnce({ id: 10, version: 1 } as any)
        .mockRejectedValueOnce(new Error('Brief failed'))
        .mockRejectedValueOnce(new GeminiDeferredError('event_brief', 'models_unavailable', [], null));

      await runPipeline(env);

      expect(briefSpy).toHaveBeenCalledTimes(3);
      expect(persistedSummary(db).briefs).toEqual({ state: 'ran', events: 4, generated: 1, failed: 1, deferred: 1, in_progress: 0 });
    });

    it('counts a held generation lease as in progress, a cooldown as neither, and a lookup error as failed', async () => {
      const env = createMockEnv();
      const now = Math.floor(Date.now() / 1000);
      const events = [1, 2, 3, 4].map((id) => ({ id, event_hash: `hash-${id}`, title: 'T', description: null, severity: 'info' }));
      const latest: Record<number, unknown> = {
        1: { article_fingerprint: 'fp', status: 'generating', updated_at: now - 60, version: 1 }, // another worker holds the lease
        3: { article_fingerprint: 'fp', status: 'failed', updated_at: now - 60, version: 1 }, // failed recently: cooldown
      };
      const db = baseDb({
        getRecentActiveEvents: vi.fn().mockResolvedValue(events),
        getEventDetailByHash: vi.fn(async (hash: string) => {
          if (hash === 'hash-4') throw new Error('detail query failed');
          return { articles: [{ id: 1, source_id: 1, published_at: 1000 }] };
        }),
        getLatestEventBrief: vi.fn(async (eventId: number) => latest[eventId] ?? null),
      });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);
      vi.spyOn(commGenModule, 'generateCommunitySignalsForEvent').mockResolvedValue(undefined as any);
      vi.spyOn(briefGenModule, 'computeArticleFingerprint').mockResolvedValue('fp');
      // Event 2: the lease was taken between the pipeline's check and its own lease attempt.
      const briefSpy = vi.spyOn(briefGenModule, 'generateAndSaveEventBrief')
        .mockRejectedValueOnce(new briefGenModule.EventBriefLeaseHeldError(2));

      await runPipeline(env);

      expect(briefSpy).toHaveBeenCalledTimes(1);
      expect(db.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined, expect.any(String));
      expect(persistedSummary(db).briefs).toEqual({ state: 'ran', events: 4, generated: 0, failed: 1, deferred: 0, in_progress: 2 });
    });

    it('records a brief stage error without failing the run', async () => {
      const env = createMockEnv();
      const db = baseDb({ getRecentActiveEvents: vi.fn().mockRejectedValue(new Error('events query failed')) });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);

      await runPipeline(env);

      expect(db.updatePipelineJobStatus).toHaveBeenCalledWith(1, 'completed', undefined, expect.any(String));
      expect(persistedSummary(db).briefs).toEqual({ state: 'errored', events: 0, generated: 0, failed: 0, deferred: 0, in_progress: 0 });
    });

    it('records a skipped brief stage when event_briefs is not migrated', async () => {
      const env = createMockEnv();
      const db = baseDb({ hasEventBriefsTable: vi.fn().mockResolvedValue(false) });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);

      await runPipeline(env);

      expect(persistedSummary(db).briefs).toEqual({ state: 'skipped', events: 0, generated: 0, failed: 0, deferred: 0, in_progress: 0 });
    });

    it('records a thrown source fetch as down with unknown counts and keeps its error', async () => {
      const env = createMockEnv();
      const db = baseDb({
        listSources: vi.fn().mockResolvedValue([{ id: 1, name: 'Up', feed_url: 'u1' }, { id: 2, name: 'Down', feed_url: 'u2' }]),
        getSourceHealth: vi.fn().mockResolvedValue(null),
        updateSourceHealth: vi.fn(),
      });
      vi.spyOn(dbClientModule, 'createDbClient').mockReturnValue(db as any);
      vi.spyOn(fetcherModule, 'fetchAndIngest')
        .mockResolvedValueOnce({ parsed: 5, inserted: 2, newest_published_at: 1700000000 })
        .mockRejectedValueOnce(new Error('Fetch fail'));

      await runPipeline(env);

      expect(persistedSummary(db).sources).toEqual([
        { id: 1, name: 'Up', outcome: 'healthy', parsed: 5, inserted: 2, newest_published_at: 1700000000, error: null },
        { id: 2, name: 'Down', outcome: 'down', parsed: null, inserted: null, newest_published_at: null, error: 'Fetch fail' },
      ]);
      expect(db.updateSourceHealth).toHaveBeenCalledWith(2, expect.objectContaining({ status: 'down', error_message: 'Fetch fail' }));
    });
  });
});

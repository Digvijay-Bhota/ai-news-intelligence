/// <reference types="vite/client" />
/**
 * Event brief generation lease and AI job lifecycle, against a real local D1
 * binding (Miniflare). Gemini is replaced by a spy, so no network is used.
 *
 * See source-initialization.test.ts for why `cloudflare:test-internal` is used.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
// @ts-expect-error -- untyped pool runtime module (see header comment)
import { env as workerEnv } from 'cloudflare:test-internal';
import schemaSql from '../../d1/schema.sql?raw';
import { computeArticleFingerprint, generateAndSaveEventBrief } from '../src/tasks/brief-generator';
import * as geminiModule from '../src/tasks/gemini';
import { createMockEnv } from './setup';
import type { ArticleRaw } from '../src/types';

const DB = (workerEnv as unknown as { DB: D1Database }).DB;

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !/^PRAGMA\b/i.test(s));
}

async function run(sql: string): Promise<void> {
  for (const stmt of splitSql(sql)) {
    await DB.prepare(stmt).run();
  }
}

const validBrief = (articleIds: number[]) => ({
  summary: 'A summary of the event that is at least twenty characters long.',
  why_it_matters: 'This matters because it sets a precedent.',
  key_developments: ['First development noted by reporters.'],
  key_entities: [{ name: 'Example Corp', type: 'organization', relevance: 'Central actor in the story.' }],
  uncertainties: ['The final outcome has not been confirmed.'],
  source_references: articleIds.map((id) => ({
    article_id: id,
    claim_context: `This article provided the key claim for article ${id}.`,
  })),
});

type EventInput = { id: number; hash: string; title: string; description: string | null; severity: string };

let event: EventInput;
let articles: ArticleRaw[];
let fingerprint: string;

async function aiJobs() {
  return (await DB.prepare("SELECT * FROM ai_jobs WHERE job_type = 'event_brief' ORDER BY id").all<any>()).results;
}

async function briefRow() {
  return DB.prepare('SELECT * FROM event_briefs WHERE event_id = ?1 AND article_fingerprint = ?2')
    .bind(event.id, fingerprint).first<any>();
}

async function holdLease(updatedAt: number): Promise<void> {
  await DB.prepare(
    `INSERT INTO event_briefs (event_id, content, article_fingerprint, article_ids, source_count, article_count,
       model, version, status, error_message, created_at, updated_at)
     VALUES (?1, '{}', ?2, '[]', 1, 2, 'gemini-3.6-flash', 1, 'generating', NULL, ?3, ?3)`
  ).bind(event.id, fingerprint, updatedAt).run();
}

function generate() {
  return generateAndSaveEventBrief(createMockEnv({ DB }), event, articles);
}

describe('Event brief generation lease and AI job lifecycle (local D1)', () => {
  beforeEach(async () => {
    await run(schemaSql);
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('Unexpected outbound fetch in test');
    }));

    const ev = (await DB.prepare(
      `INSERT INTO events (event_hash, title, description, severity, status)
       VALUES ('lease-event', 'Lease event', 'An event under test', 'medium', 'active') RETURNING *`
    ).first<any>())!;
    event = { id: ev.id, hash: ev.event_hash, title: ev.title, description: ev.description, severity: ev.severity };

    const source = (await DB.prepare("SELECT id FROM sources WHERE name = 'TechCrunch'").first<{ id: number }>())!;
    articles = [];
    for (const n of [1, 2]) {
      articles.push((await DB.prepare(
        `INSERT INTO articles_raw (external_id, source_id, title, summary, url, published_at, status)
         VALUES (?1, ?2, ?3, 'Summary', ?4, ?5, 'processed') RETURNING *`
      ).bind(`lease-article-${n}`, source.id, `Lease article ${n}`, `https://news.example.test/${n}`, 1000 + n)
        .first<ArticleRaw>())!);
    }
    fingerprint = await computeArticleFingerprint(event.id, articles);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('lease already held: throws without creating a running AI job or calling Gemini', async () => {
    const heldAt = Math.floor(Date.now() / 1000);
    await holdLease(heldAt);
    const gemini = vi.spyOn(geminiModule, 'generateEventBriefFromGemini');

    await expect(generate()).rejects.toThrow(/Generation in progress/);

    expect(await aiJobs()).toEqual([]);
    expect(gemini).not.toHaveBeenCalled();
    // The other worker's lease is left untouched.
    expect(await briefRow()).toMatchObject({ status: 'generating', updated_at: heldAt });
  });

  it('success: saves a completed brief, completes its AI job, and is idempotent', async () => {
    const gemini = vi.spyOn(geminiModule, 'generateEventBriefFromGemini')
      .mockResolvedValue(validBrief(articles.map((a) => a.id)));

    const saved = await generate();

    expect(saved).toMatchObject({ event_id: event.id, article_fingerprint: fingerprint, status: 'completed', version: 1 });
    const jobs = await aiJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'completed', error_message: null });
    expect(jobs[0].completed_at).not.toBeNull();
    expect(JSON.parse(jobs[0].result)).toEqual({ brief_id: saved.id, version: 1 });

    // Same article set again: the completed brief is returned, with no new job or Gemini call.
    await expect(generate()).resolves.toMatchObject({ id: saved.id, status: 'completed' });
    expect(await aiJobs()).toHaveLength(1);
    expect(gemini).toHaveBeenCalledTimes(1);
  });

  it('failure after the job starts: job is failed with completed_at, error is logged, lease is released', async () => {
    vi.spyOn(geminiModule, 'generateEventBriefFromGemini').mockRejectedValue(new Error('Gemini exploded'));

    await expect(generate()).rejects.toThrow('Gemini exploded');

    const jobs = await aiJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'failed', error_message: 'Gemini exploded' });
    expect(jobs[0].completed_at).not.toBeNull();
    const logs = (await DB.prepare('SELECT * FROM ai_logs WHERE ai_job_id = ?1').bind(jobs[0].id).all<any>()).results;
    expect(logs).toEqual([expect.objectContaining({ message: 'Gemini exploded', log_level: 'error' })]);
    expect(await briefRow()).toMatchObject({ status: 'failed', error_message: 'Gemini exploded' });
  });

  it('if the AI job cannot be created after taking the lease, the lease is still released', async () => {
    await DB.prepare('DROP TABLE ai_logs').run();
    await DB.prepare('DROP TABLE ai_jobs').run();
    const gemini = vi.spyOn(geminiModule, 'generateEventBriefFromGemini');

    await expect(generate()).rejects.toThrow(/ai_jobs/);

    expect(gemini).not.toHaveBeenCalled();
    expect(await briefRow()).toMatchObject({ status: 'failed' });
  });

  it('a released lease can be retried, and a stale lease can be taken over', async () => {
    const gemini = vi.spyOn(geminiModule, 'generateEventBriefFromGemini')
      .mockRejectedValueOnce(new Error('Transient failure'))
      .mockResolvedValueOnce(validBrief(articles.map((a) => a.id)));

    await expect(generate()).rejects.toThrow('Transient failure');
    await expect(generate()).resolves.toMatchObject({ status: 'completed' });
    expect((await aiJobs()).map((j) => j.status)).toEqual(['failed', 'completed']);

    // A lease abandoned more than 300 seconds ago does not block a new attempt.
    await DB.prepare('DELETE FROM event_briefs').run();
    await holdLease(Math.floor(Date.now() / 1000) - 301);
    gemini.mockResolvedValueOnce(validBrief(articles.map((a) => a.id)));
    await expect(generate()).resolves.toMatchObject({ status: 'completed' });
    expect((await aiJobs()).map((j) => j.status)).toEqual(['failed', 'completed', 'completed']);
  });

  it('overlapping requests: only the lease holder runs, the other leaves no AI job behind', async () => {
    let releaseGemini!: () => void;
    const geminiGate = new Promise<void>((resolve) => { releaseGemini = resolve; });
    let geminiStarted!: () => void;
    const started = new Promise<void>((resolve) => { geminiStarted = resolve; });
    const gemini = vi.spyOn(geminiModule, 'generateEventBriefFromGemini').mockImplementation(async () => {
      geminiStarted();
      await geminiGate;
      return validBrief(articles.map((a) => a.id));
    });

    // e.g. the hourly pipeline is mid-generation when the on-demand endpoint is called.
    const first = generate();
    await started;
    await expect(generate()).rejects.toThrow(/Generation in progress/);

    releaseGemini();
    await expect(first).resolves.toMatchObject({ status: 'completed' });

    expect(gemini).toHaveBeenCalledTimes(1);
    expect((await aiJobs()).map((j) => j.status)).toEqual(['completed']);
  });
});

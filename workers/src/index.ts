/**
 * AI News Intelligence — Cloudflare Workers Entry Point
 *
 * Phase 0 Foundation
 */

import type { Env } from './types';
import { route } from './router';
import { runPipeline } from './tasks/orchestrator';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(runPipeline(env));
  },
};

/**
 * AI News Intelligence — Cloudflare Workers Entry Point
 *
 * Phase 0 Foundation
 */

import type { Env } from './types';
import { route } from './router';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return route(request, env);
  },
};

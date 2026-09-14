import { requireAuthenticatedUser } from "./middleware/auth";
import type { Env } from './types';
import type { AuthContext } from './middleware/auth';
import { NotFoundError, BadRequestError, ForbiddenError } from './utils/errors';
import { parseBody } from './middleware/body-limit';

function success(data: any, status = 200, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ success: true, data }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

export function error(message: string, status = 400, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
  });
}

function requireString(val: any, name: string): string {
  if (typeof val !== 'string' || !val.trim()) throw new BadRequestError(`Missing or invalid field: ${name}`);
  const trimmed = val.trim();
  if (trimmed === '') throw new BadRequestError(`${name} cannot be empty`);
  return trimmed;
}

export async function handleGetCommunityPosts(request: Request, env: Env, eventHash: string): Promise<Response> {
  const url = new URL(request.url);
  const cursor = url.searchParams.get('cursor');
  
  const event = await env.DB.prepare('SELECT id FROM events WHERE event_hash = ?').bind(eventHash).first<{ id: number }>();
  if (!event) throw new NotFoundError('Event not found');
  
  let q = `
    SELECT p.id, p.body, p.created_at, p.edited_at, p.context_anchor_type, p.context_anchor_id,
           u.public_id as author_public_id, u.display_name as author_display_name,
           (SELECT COUNT(*) FROM community_votes v WHERE v.post_id = p.id) as upvotes,
           (SELECT COUNT(*) FROM community_posts r WHERE r.parent_id = p.id AND r.status IN ('active', 'flagged')) as reply_count
    FROM community_posts p
    JOIN user_profiles u ON p.user_id = u.user_id
    WHERE p.event_id = ? AND p.parent_id IS NULL AND p.status IN ('active', 'flagged')
  `;
  const params: any[] = [event.id];
  
  if (cursor) {
    q += ` AND (p.created_at < ? OR (p.created_at = ? AND p.id < ?))`;
    const parts = cursor.split('_');
    if (parts.length === 2) {
      params.push(parseInt(parts[0], 10), parseInt(parts[0], 10), parts[1]);
    } else {
      params.push(0, 0, '');
    }
  }
  
  q += ` ORDER BY p.created_at DESC, p.id DESC LIMIT 50`;
  
  const postsRes = await env.DB.prepare(q).bind(...params).all();
  const posts = postsRes.results ?? [];
  
  let nextCursor = null;
  if (posts.length === 50) {
    const last = posts[posts.length - 1] as any;
    nextCursor = `${last.created_at}_${last.id}`;
  }
  
  return success({ items: posts, next_cursor: nextCursor }, 200, {
    'Cache-Control': 'public, s-maxage=60'
  });
}

export async function handleCreateCommunityPost(request: Request, env: Env, auth: AuthContext, eventHash: string): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = (await parseBody(request, false)) as any;
  const text = requireString(body.body, 'body');
  if (text.length > 5000) throw new BadRequestError('Body exceeds 5000 characters');
  
  const anchorType = body.anchor_type ? requireString(body.anchor_type, 'anchor_type') : null;
  const anchorId = body.anchor_id ? requireString(body.anchor_id, 'anchor_id') : null;
  
  const event = await env.DB.prepare('SELECT id FROM events WHERE event_hash = ?').bind(eventHash).first<{ id: number }>();
  if (!event) throw new NotFoundError('Event not found');
  
  if (anchorType === 'article') {
    if (!anchorId) throw new BadRequestError('anchor_id required for anchor_type article');
    const article = await env.DB.prepare('SELECT 1 FROM article_events WHERE article_raw_id = ? AND event_id = ?').bind(anchorId, event.id).first();
    if (!article) throw new BadRequestError('Invalid cross-event or nonexistent anchor');
  } else if (anchorType === 'source') {
    if (!anchorId) throw new BadRequestError('anchor_id required for anchor_type source');
    const source = await env.DB.prepare('SELECT 1 FROM article_events ae JOIN articles_raw a ON ae.article_raw_id = a.id JOIN sources s ON a.source_id = s.id WHERE ae.event_id = ? AND s.name = ?').bind(event.id, anchorId).first();
    if (!source) throw new BadRequestError('Invalid cross-event or nonexistent anchor');
  } else if (anchorType === 'claim') {
    if (!anchorId) throw new BadRequestError('anchor_id required for anchor_type claim');
    const claim = await env.DB.prepare('SELECT 1 FROM event_claim_comparisons WHERE id = ? AND event_id = ?').bind(anchorId, event.id).first();
    if (!claim) throw new BadRequestError('Invalid cross-event or nonexistent anchor');
  } else if (anchorType) {
    throw new BadRequestError('Unsupported anchor type');
  }
  
  const postId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO community_posts (id, event_id, user_id, parent_id, body, status, context_anchor_type, context_anchor_id)
     VALUES (?, ?, ?, NULL, ?, 'active', ?, ?)`
  ).bind(postId, event.id, userId, text, anchorType, anchorId).run();
  
  return success({ id: postId }, 201);
}

export async function handleGetCommunityReplies(_request: Request, env: Env, postId: string): Promise<Response> {
  const q = `
    SELECT p.id, p.body, p.created_at, p.edited_at,
           u.public_id as author_public_id, u.display_name as author_display_name,
           (SELECT COUNT(*) FROM community_votes v WHERE v.post_id = p.id) as upvotes
    FROM community_posts p
    JOIN user_profiles u ON p.user_id = u.user_id
    WHERE p.parent_id = ? AND p.status IN ('active', 'flagged')
    ORDER BY p.created_at ASC LIMIT 100
  `;
  const replies = await env.DB.prepare(q).bind(postId).all();
  return success({ items: replies.results ?? [] }, 200, {
    'Cache-Control': 'public, s-maxage=60'
  });
}

export async function handleCreateCommunityReply(request: Request, env: Env, auth: AuthContext, postId: string): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = (await parseBody(request, false)) as any;
  const text = requireString(body.body, 'body');
  if (text.length > 5000) throw new BadRequestError('Body exceeds 5000 characters');
  
  const parent = await env.DB.prepare("SELECT id, event_id, parent_id FROM community_posts WHERE id = ? AND status IN ('active', 'flagged')").bind(postId).first<{ id: string, event_id: number, parent_id: string | null }>();
  if (!parent) throw new NotFoundError('Parent post not found');
  if (parent.parent_id !== null) throw new BadRequestError('Excessive nesting. Replies can only be to top-level posts.');
  
  const replyId = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO community_posts (id, event_id, user_id, parent_id, body, status)
     VALUES (?, ?, ?, ?, ?, 'active')`
  ).bind(replyId, parent.event_id, userId, parent.id, text).run();
  
  return success({ id: replyId }, 201);
}

export async function handleEditCommunityPost(request: Request, env: Env, auth: AuthContext, postId: string): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = (await parseBody(request, false)) as any;
  const text = requireString(body.body, 'body');
  if (text.length > 5000) throw new BadRequestError('Body exceeds 5000 characters');
  
  const post = await env.DB.prepare('SELECT user_id, status FROM community_posts WHERE id = ?').bind(postId).first<{ user_id: string, status: string }>();
  if (!post) throw new NotFoundError('Post not found');
  if (post.user_id !== userId) throw new ForbiddenError('Not owner');
  if (post.status !== 'active') throw new ForbiddenError('Cannot edit locked post');
  
  await env.DB.prepare(
    `UPDATE community_posts SET body = ?, edited_at = unixepoch(), edit_count = edit_count + 1 WHERE id = ?`
  ).bind(text, postId).run();
  
  return success(null);
}

export async function handleDeleteCommunityPost(_request: Request, env: Env, auth: AuthContext, postId: string): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const post = await env.DB.prepare('SELECT user_id, status FROM community_posts WHERE id = ?').bind(postId).first<{ user_id: string, status: string }>();
  if (!post) throw new NotFoundError('Post not found');
  
  if (post.user_id !== userId) throw new ForbiddenError('Not owner');
  if (post.status === 'deleted') return success(null);
  
  await env.DB.prepare(`UPDATE community_posts SET status = 'deleted' WHERE id = ?`).bind(postId).run();
  
  await env.DB.prepare(
    `INSERT INTO moderation_audits (post_id, actor, actor_role, previous_state, new_state, reason) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(postId, userId, 'USER', post.status, 'deleted', 'User deleted own post').run();
  
  return success(null);
}

export async function handleVoteCommunityPost(_request: Request, env: Env, auth: AuthContext, postId: string, isDelete: boolean): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const post = await env.DB.prepare('SELECT status FROM community_posts WHERE id = ?').bind(postId).first<{ status: string }>();
  if (!post) throw new NotFoundError('Post not found');
  if (post.status !== 'active' && post.status !== 'flagged') throw new ForbiddenError('Cannot interact with this post');

  if (isDelete) {
    await env.DB.prepare('DELETE FROM community_votes WHERE post_id = ? AND user_id = ?').bind(postId, userId).run();
  } else {
    await env.DB.prepare(
      'INSERT OR IGNORE INTO community_votes (post_id, user_id, vote_type) VALUES (?, ?, ?)'
    ).bind(postId, userId, 'upvote').run();
  }
  return success(null);
}

export async function handleReportCommunityPost(request: Request, env: Env, auth: AuthContext, postId: string): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = (await parseBody(request, false)) as any;
  const reason = requireString(body.reason, 'reason');
  
  const post = await env.DB.prepare('SELECT status FROM community_posts WHERE id = ?').bind(postId).first<{ status: string }>();
  if (!post) throw new NotFoundError('Post not found');
  
  await env.DB.prepare(
    'INSERT OR IGNORE INTO community_reports (post_id, user_id, reason) VALUES (?, ?, ?)'
  ).bind(postId, userId, reason).run();
  
  const reports = await env.DB.prepare('SELECT COUNT(*) as count FROM community_reports WHERE post_id = ?').bind(postId).first<{ count: number }>();
  if (reports && reports.count >= 5 && post.status === 'active') {
    await env.DB.prepare(`UPDATE community_posts SET status = 'flagged' WHERE id = ? AND status = 'active'`).bind(postId).run();
    await env.DB.prepare(
      `INSERT INTO moderation_audits (post_id, actor, actor_role, previous_state, new_state, reason) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(postId, 'SYSTEM', 'SYSTEM', 'active', 'flagged', 'Report threshold reached').run();
  }
  
  return success(null);
}

export async function handleGetMyInteractions(request: Request, env: Env, auth: AuthContext): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const url = new URL(request.url);
  const eventHash = url.searchParams.get('event_hash');
  
  let eventCondition = "";
  let params: (string|number)[] = [userId];
  
  if (eventHash) {
    const event = await env.DB.prepare('SELECT id FROM events WHERE event_hash = ?').bind(eventHash).first<{ id: number }>();
    if (event) {
      eventCondition = " AND p.event_id = ?";
      params.push(event.id);
    }
  }

  const votesRes = await env.DB.prepare(`
    SELECT v.post_id 
    FROM community_votes v 
    JOIN community_posts p ON v.post_id = p.id
    WHERE v.user_id = ? ${eventCondition}
  `).bind(...params).all<{ post_id: string }>();

  const reportsRes = await env.DB.prepare(`
    SELECT r.post_id 
    FROM community_reports r 
    JOIN community_posts p ON r.post_id = p.id
    WHERE r.user_id = ? ${eventCondition}
  `).bind(...params).all<{ post_id: string }>();
  
  return success({
    upvoted: (votesRes.results ?? []).map(v => v.post_id),
    reported: (reportsRes.results ?? []).map(r => r.post_id)
  }, 200, {
    'Cache-Control': 'private, no-store'
  });
}

export async function handleModerateCommunityPost(request: Request, env: Env, auth: AuthContext, postId: string): Promise<Response> {
  const userId = requireAuthenticatedUser(auth);
  const body = (await parseBody(request, false)) as any;
  const newState = requireString(body.status, 'status');
  
  if (!['active', 'flagged', 'hidden', 'deleted'].includes(newState)) {
    throw new BadRequestError('Invalid status transition');
  }

  const post = await env.DB.prepare('SELECT status FROM community_posts WHERE id = ?').bind(postId).first<{ status: string }>();
  if (!post) throw new NotFoundError('Post not found');
  
  if (post.status === newState) {
    return success(null);
  }
  
  if (post.status === 'deleted') {
    throw new BadRequestError('Cannot transition from deleted state');
  }
  
  if (post.status === 'hidden' && newState === 'flagged') {
    throw new BadRequestError('Cannot transition from hidden to flagged');
  }

  const reason = body.reason && typeof body.reason === 'string' ? body.reason : 'Moderation action';
  
  let actorRole = 'UNKNOWN';
  if (auth.scopes.includes('admin')) {
    actorRole = 'ADMIN';
  } else if (auth.scopes.includes('moderator')) {
    actorRole = 'MODERATOR';
  } else if (auth.scopes.includes('internal')) {
    actorRole = 'SYSTEM';
  }

  await env.DB.prepare(`UPDATE community_posts SET status = ? WHERE id = ?`).bind(newState, postId).run();
  
  await env.DB.prepare(
    `INSERT INTO moderation_audits (post_id, actor, actor_role, previous_state, new_state, reason) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(postId, userId, actorRole, post.status, newState, reason).run();

  return success(null);
}

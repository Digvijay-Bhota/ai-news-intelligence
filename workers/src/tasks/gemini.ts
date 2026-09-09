/**
 * Gemini 3.6 Flash Client
 */

import type { Env } from '../types';
import { ApiError } from '../utils/errors';

export interface GeminiResponse {
  summary: string;
  topics: string[];
  events: {
    title: string;
    description: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
  }[];
}

export async function generateEnrichment(
  env: Env,
  prompt: string
): Promise<GeminiResponse> {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Gemini API error: ${response.status} ${response.statusText}`, 'GEMINI_ERROR');
  }

  const data = (await response.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string') {
    throw new Error('Invalid response structure from Gemini API');
  }

  const cleanedText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(cleanedText) as GeminiResponse;
  } catch (e) {
    throw new Error('Invalid JSON returned by Gemini API');
  }
}

export interface EventMatchResponse {
  match: boolean;
  event_id: number | null;
}

export async function matchEventToCluster(
  env: Env,
  newEvent: { title: string; description: string },
  candidates: { id: number; title: string; description: string | null; severity: string }[]
): Promise<EventMatchResponse> {
  if (candidates.length === 0) {
    return { match: false, event_id: null };
  }

  const prompt = `You are a semantic event matching engine.
Your task is to determine if a newly extracted event describes the EXACT SAME REAL-WORLD INCIDENT as any of the candidate events provided.

NEW EVENT:
Title: ${newEvent.title}
Description: ${newEvent.description}

CANDIDATE EVENTS:
${candidates.map(c => `ID: ${c.id} | Title: ${c.title} | Desc: ${c.description || 'N/A'}`).join('\n')}

CRITICAL INSTRUCTIONS:
- Return ONLY a JSON object. No markdown, no code fences.
- Distinguish between SAME REAL-WORLD INCIDENT and SAME TOPIC.
- Do NOT merge two different incidents (e.g. two separate lawsuits, two different funding rounds, two distinct product launches).
- If the new event is identical in real-world reference to a candidate, return: {"match": true, "event_id": <candidate_id>}
- If there is no exact real-world incident match, return: {"match": false, "event_id": null}
- Output JSON ONLY.`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Gemini API error: ${response.status} ${response.statusText}`, 'GEMINI_ERROR');
  }

  const data = (await response.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string') {
    throw new Error('Invalid response structure from Gemini API');
  }

  const cleanedText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  let result: any;
  try {
    result = JSON.parse(cleanedText);
  } catch (e) {
    throw new Error('Invalid JSON returned by Gemini API');
  }

  if (typeof result.match !== 'boolean') {
    throw new Error('Invalid structure: match must be boolean');
  }
  if (result.match && typeof result.event_id !== 'number') {
    throw new Error('Invalid structure: event_id must be a number when match is true');
  }

  return {
    match: result.match,
    event_id: result.match ? result.event_id : null
  };
}

export async function generateEventBriefFromGemini(
  env: Env,
  event: { title: string; description: string | null; severity: string },
  articles: { id: number; title: string; summary?: string | null; raw_content?: string | null; source: string; published_at: number | null }[]
): Promise<unknown> {
  const boundedArticles = articles.slice(0, 10);

  const articlesText = boundedArticles.map(a => {
    const published = a.published_at ? new Date(a.published_at * 1000).toISOString() : 'Unknown';
    const content = a.summary || (a.raw_content ? a.raw_content.slice(0, 600) : 'N/A');
    return `--- ARTICLE [ID: ${a.id}] ---
Source: ${(a.source || '').slice(0, 50)}
Published: ${published}
Title: ${(a.title || '').slice(0, 200)}
Content: ${content.slice(0, 600)}`;
  }).join('\n\n');

  const prompt = `You are an intelligence briefing analyst for an AI news platform.
Synthesize the provided real-world reporting into a grounded, comprehensive intelligence event brief.

EVENT INFORMATION:
Title: ${event.title}
Description: ${event.description || 'N/A'}
Severity: ${event.severity}

GROUNDED SOURCE ARTICLES (YOU MAY ONLY CITE THESE EXACT ARTICLE IDS):
${articlesText}

CRITICAL GROUNDING RULES:
1. USE ONLY EVIDENCE from the supplied articles. NEVER invent facts, statistics, names, dates, or outcomes.
2. DO NOT claim something happened unless explicitly corroborated by the text.
3. If reporting differs between outlets or facts remain unverified, explicitly document this in "uncertainties".
4. If multiple articles originate from the same wire service or outlet, avoid treating them as separate independent confirmations.
5. In "source_references", cite ONLY the exact integer article IDs provided in the header above ([ID: ...]). Any citation of an unlisted article ID is strictly forbidden.
6. Return a valid JSON object ONLY. Do NOT wrap in markdown or code fences.

REQUIRED JSON OUTPUT FORMAT:
{
  "summary": "A concise factual narrative of the overall event (2-4 sentences).",
  "why_it_matters": "The strategic, technical, economic, or regulatory significance (1-2 sentences).",
  "key_developments": [
    "Key factual development 1 with context.",
    "Key factual development 2 with context."
  ],
  "key_entities": [
    {
      "name": "Exact entity name",
      "type": "organization|person|technology|regulation|location",
      "relevance": "Role or connection to this specific event"
    }
  ],
  "uncertainties": [
    "Fact or claim that remains unconfirmed, disputed, or subject to ongoing investigation."
  ],
  "source_references": [
    {
      "article_id": 123,
      "claim_context": "Specific factual claim corroborated by this article"
    }
  ]
}`;

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${env.GEMINI_API_KEY}`;

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        responseMimeType: 'application/json',
      },
    }),
  });

  if (!response.ok) {
    throw new ApiError(response.status, `Gemini API error: ${response.status} ${response.statusText}`, 'GEMINI_ERROR');
  }

  const data = (await response.json()) as any;
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (typeof text !== 'string') {
    throw new Error('Invalid response structure from Gemini API');
  }

  const cleanedText = text.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();

  try {
    return JSON.parse(cleanedText);
  } catch (_e) {
    throw new Error('Invalid JSON returned by Gemini API');
  }
}

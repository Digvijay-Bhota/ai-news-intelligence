/**
 * Gemini 3.6 Flash Client
 */

import type { Env, EventBrief } from '../types';
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

import { formatSandboxedArticleCollection, PROMPT_SANDBOX_SECURITY_RULES } from './prompt-sandbox';

export async function generateEventBriefFromGemini(
  env: Env,
  event: { title: string; description: string | null; severity: string },
  articles: { id: number; title: string; summary?: string | null; raw_content?: string | null; source: string; published_at: number | null }[]
): Promise<unknown> {
  const sandboxedEvidence = formatSandboxedArticleCollection(articles, 10);

  const prompt = `You are an intelligence briefing analyst for an AI news platform.
Synthesize the provided real-world reporting into a grounded, comprehensive intelligence event brief.

${PROMPT_SANDBOX_SECURITY_RULES}

EVENT INFORMATION:
Title: ${event.title}
Description: ${event.description || 'N/A'}
Severity: ${event.severity}

GROUNDED EVIDENCE:
${sandboxedEvidence}

CRITICAL GROUNDING RULES:
1. USE ONLY EVIDENCE from the supplied <article_context> tags. NEVER invent facts, statistics, names, dates, or outcomes.
2. DO NOT claim something happened unless explicitly corroborated by the text.
3. If reporting differs between outlets or facts remain unverified, explicitly document this in "uncertainties".
4. If multiple articles originate from the same wire service or outlet, avoid treating them as separate independent confirmations.
5. In "source_references", cite ONLY the exact integer article IDs specified in the id attribute of the <article_context id="..."> tags. Any citation of an unlisted article ID is strictly forbidden.
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

export async function generateNarrativeDeltaFromGemini(
  env: Env,
  event: { title: string; description: string | null; severity: string },
  previousBrief: EventBrief,
  previousVersion: number,
  currentVersion: number,
  articles: { id: number; title: string; summary?: string | null; raw_content?: string | null; source: string; published_at: number | null }[]
): Promise<unknown> {
  const sandboxedEvidence = formatSandboxedArticleCollection(articles, 10);

  const prevKeyDevs = previousBrief.key_developments.slice(0, 8).map(d => `- ${d}`).join('\n');
  const prevUncertainties = previousBrief.uncertainties.slice(0, 5).map(u => `- ${u}`).join('\n');

  const prompt = `You are a senior intelligence analyst evaluating narrative evolution in ongoing news reporting.
Your task is to analyze what changed between the PREVIOUS EVENT BRIEF (Version ${previousVersion}) and the CURRENT GROUNDED EVIDENCE to produce the narrative evolution for Version ${currentVersion}.

${PROMPT_SANDBOX_SECURITY_RULES}

EVENT INFORMATION:
Title: ${event.title}
Description: ${event.description || 'N/A'}
Severity: ${event.severity}

PREVIOUS BRIEF (VERSION ${previousVersion}):
<previous_brief version="${previousVersion}">
  <summary>${previousBrief.summary.slice(0, 1500)}</summary>
  <key_developments>
${prevKeyDevs}
  </key_developments>
  <uncertainties>
${prevUncertainties}
  </uncertainties>
</previous_brief>

CURRENT GROUNDED EVIDENCE (VERSION ${currentVersion}):
${sandboxedEvidence}

ANALYTICAL OBJECTIVES:
1. FOCUS ON SEMANTIC EVOLUTION: Do not just list new articles. Explain what new facts are confirmed, which prior claims shifted or were retracted, and what questions remain unresolved.
2. PRESERVE UNCHANGED FACTS: Acknowledge core elements that stayed consistent in "unchanged_core".
3. STRICT SOURCE CITATIONS: In all "source_references" arrays, cite ONLY the exact integer article IDs specified in the id attribute of the <article_context id="..."> tags.
4. NO INVENTED CHANGES: If there is no meaningful change, state in summary that the core story remains steady and provide empty arrays where appropriate.
5. Return a valid JSON object ONLY. No markdown, no code fences.

REQUIRED JSON OUTPUT FORMAT:
{
  "summary": "Concise 1-3 sentence narrative synthesis explaining what fundamentally evolved in the reporting.",
  "newly_confirmed": [
    {
      "statement": "Fact or development newly verified in the latest reporting",
      "source_references": [101]
    }
  ],
  "changed_claims": [
    {
      "previous_statement": "What was previously reported or claimed",
      "current_statement": "What is now reported",
      "change_type": "refined|expanded|contradicted|retracted|uncertain",
      "source_references": [102]
    }
  ],
  "removed_or_no_longer_supported": [
    {
      "statement": "Claim from the previous brief no longer corroborated by current evidence",
      "source_references": [101]
    }
  ],
  "unchanged_core": [
    "Fundamental element of the event that remains true and unchanged"
  ],
  "open_questions": [
    "New ambiguity, pending investigation, or unresolved question"
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

export async function generateClaimComparisonsFromGemini(
  env: Env,
  event: { title: string; description: string | null; severity: string },
  articles: { id: number; title: string; summary?: string | null; raw_content?: string | null; source: string; published_at: number | null; source_id: number }[]
): Promise<unknown> {
  const sandboxedEvidence = formatSandboxedArticleCollection(articles, 10);

  const prompt = `You are a cross-source news intelligence analyst.
Your task is to analyze reporting across distinct newsrooms and identify discrete factual claims, comparing coverage to discover consensus and disagreement.

${PROMPT_SANDBOX_SECURITY_RULES}

EVENT INFORMATION:
Title: ${event.title}
Description: ${event.description || 'N/A'}
Severity: ${event.severity}

GROUNDED EVIDENCE:
${sandboxedEvidence}

ANALYSIS GUIDELINES:
1. DISCRETE CLAIMS: Extract 2 to 6 key factual claims reported across the articles.
2. STATUS DEFINITIONS:
   - "consensus": Corroborated by multiple independent newsrooms without contradiction.
   - "disputed": Different newsrooms report conflicting numbers, timelines, responsibility, or outcomes.
   - "unconfirmed": Claimed by a single outlet or attributed to anonymous/unverified sources.
   - "evolving": Active breaking situation where different outlets report differing rapid updates.
3. SOURCE ATTRIBUTION: For each claim, list the contributing sources with their source_id, source_name, specific reported position (1 sentence), and the article_ids from the evidence.
4. REFERENTIAL INTEGRITY: Use ONLY exact integer article IDs from the <article_context id="..."> tags.
5. Return a valid JSON array ONLY. No markdown, no code fences.

REQUIRED JSON OUTPUT FORMAT:
[
  {
    "claim": "Specific factual claim or assertion",
    "status": "consensus|disputed|unconfirmed|evolving",
    "sources": [
      {
        "source_id": 1,
        "source_name": "Reuters",
        "position": "Reported that the merger talks stalled due to regulatory scrutiny.",
        "article_ids": [101]
      }
    ]
  }
]`;

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

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

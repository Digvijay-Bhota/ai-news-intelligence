/**
 * Gemini 3.6 Flash Client
 */

import type { Env } from '../types';

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
    throw new Error(`Gemini API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as any;
  const text = data.candidates[0].content.parts[0].text;
  return JSON.parse(text) as GeminiResponse;
}

import { GoogleGenAI } from '@google/genai';

const ANALYSIS_MODEL = process.env.GEMINI_ANALYSIS_MODEL || 'gemini-2.5-flash';

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  try {
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) {
      res.status(503).json({ error: 'Gemini not configured.' });
      return;
    }

    const body = await readJsonBody(req);
    const imageBase64 = String(body?.imageBase64 || '').trim();
    const mimeType = String(body?.mimeType || 'image/png').trim();
    if (!imageBase64) {
      res.status(400).json({ error: 'Missing imageBase64.' });
      return;
    }

    const systemPrompt = [
      'You are analyzing an image and must return strict JSON only.',
      'Return JSON with keys: place, story, musicPrompt.',
      'place: 1-2 sentences describing the setting or world in the image.',
      'story: ~1 minute narration (about 130-160 words) set in that place.',
      'musicPrompt: 1-2 sentences describing music that fits the place and mood.',
      'No markdown. No extra keys. No surrounding text.'
    ].join(' ');

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: ANALYSIS_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            { text: systemPrompt },
            { inlineData: { mimeType, data: imageBase64 } },
          ],
        },
      ],
      generationConfig: {
        maxOutputTokens: 600,
        temperature: 0.7,
      },
    });

    const raw = response?.text?.trim() || '';
    const parsed = safeParseJson(raw);
    if (!parsed) {
      res.status(500).json({ error: 'Failed to parse analysis JSON.', raw });
      return;
    }

    const place = String(parsed.place || '').trim();
    const story = String(parsed.story || '').trim();
    const musicPrompt = String(parsed.musicPrompt || '').trim();

    if (!place || !story || !musicPrompt) {
      res.status(500).json({ error: 'Analysis JSON missing required fields.', raw: parsed });
      return;
    }

    res.json({ place, story, musicPrompt });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Analysis failed.';
    res.status(500).json({ error: message });
  }
}

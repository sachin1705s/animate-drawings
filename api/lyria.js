import { GoogleGenAI } from '@google/genai';

const LYRIA_MODEL = process.env.LYRIA_MODEL || 'lyria-3-clip-preview';

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? JSON.parse(raw) : {};
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
    const musicPrompt = String(body?.musicPrompt || '').trim();
    if (!musicPrompt) {
      res.status(400).json({ error: 'Missing musicPrompt.' });
      return;
    }

    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: LYRIA_MODEL,
      contents: [{ role: 'user', parts: [{ text: musicPrompt }] }],
      generationConfig: {
        responseModalities: ['AUDIO', 'TEXT'],
      },
    });

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const audioPart = parts.find((part) => part.inlineData?.data);
    if (!audioPart?.inlineData?.data) {
      res.status(500).json({ error: 'No audio returned from Lyria.' });
      return;
    }

    const textPart = parts.find((part) => typeof part.text === 'string');
    const audioBase64 = audioPart.inlineData.data;
    const mimeType = audioPart.inlineData.mimeType || 'audio/mpeg';
    res.json({ audioBase64, mimeType, lyricsText: textPart?.text || '' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Music generation failed.';
    res.status(500).json({ error: message });
  }
}

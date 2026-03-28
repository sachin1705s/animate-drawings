import { getGeminiClient, getGeminiModels, generateWithRetry, parseGeminiError, isRetryableGeminiError } from '../_gemini.js';

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ ok: false, error: 'Method not allowed.' });
    return;
  }

  try {
    const ai = getGeminiClient();
    await generateWithRetry(
      ai,
      getGeminiModels(),
      [{ role: 'user', parts: [{ text: 'ping' }] }],
      1
    );
    res.json({ ok: true });
  } catch (err) {
    const info = parseGeminiError(err);
    const message = info?.message || 'Gemini check failed.';
    const status = isRetryableGeminiError(info) ? 503 : 500;
    res.status(status).json({ ok: false, error: message });
  }
}

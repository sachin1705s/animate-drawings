import { GoogleGenAI } from '@google/genai';

const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-image-preview';

function parseGeminiError(err) {
  const raw = err?.message || 'Gemini request failed.';
  try {
    const parsed = JSON.parse(raw);
    const message = parsed?.error?.message || parsed?.message || raw;
    const status = parsed?.error?.status || parsed?.status;
    const code = parsed?.error?.code || parsed?.code;
    return { message, status, code };
  } catch {
    return { message: raw, status: err?.status, code: err?.code };
  }
}

function isRetryableGeminiError(info) {
  const text = String(info?.status || '') + ' ' + String(info?.message || '');
  return text.includes('UNAVAILABLE') || text.includes('503') || text.includes('RESOURCE_EXHAUSTED');
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithRetry(ai, models, contents, attempts = 2) {
  let lastErr = null;
  for (let i = 0; i < models.length; i += 1) {
    const model = models[i];
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await ai.models.generateContent({ model, contents });
        return { response, model };
      } catch (err) {
        const info = parseGeminiError(err);
        lastErr = info;
        if (!isRetryableGeminiError(info)) {
          throw err;
        }
        if (attempt < attempts - 1) {
          await sleep(800 * (attempt + 1));
        }
      }
    }
  }
  const error = new Error(lastErr?.message || 'Gemini overloaded.');
  error.status = lastErr?.status;
  error.code = lastErr?.code;
  throw error;
}

export function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY || '';
  if (!apiKey) throw new Error('Missing GEMINI_API_KEY.');
  return new GoogleGenAI({ apiKey });
}

export function getGeminiModels() {
  return [GEMINI_MODEL, GEMINI_FALLBACK_MODEL];
}

export { parseGeminiError, isRetryableGeminiError, generateWithRetry };

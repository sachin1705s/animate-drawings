import express from 'express';
import multer from 'multer';
import helmet from 'helmet';
import cors from 'cors';
import 'dotenv/config';
import { GoogleGenAI } from '@google/genai';

const app = express();
app.set('trust proxy', 1);

const PORT = process.env.PORT || 8787;
const GEMINI_MODEL = process.env.GEMINI_IMAGE_MODEL || 'gemini-2.5-flash-image';
const GEMINI_FALLBACK_MODEL = process.env.GEMINI_FALLBACK_MODEL || 'gemini-3.1-flash-image-preview';
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

const allowedOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
  })
);

app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (
        process.env.NODE_ENV !== 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
      ) {
        return callback(null, true);
      }
      if (allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
        return callback(null, true);
      }
      return callback(new Error('Not allowed by CORS'));
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type'],
  })
);

app.use(express.json({ limit: '2mb' }));

const storage = multer.memoryStorage();
const uploadImage = multer({
  storage,
  limits: { fileSize: MAX_IMAGE_BYTES },
  fileFilter: (_req, file, cb) => {
    const type = file.mimetype || '';
    const ok = type.startsWith('image/') || ['image/heic', 'image/heif'].includes(type);
    cb(ok ? null : new Error('Invalid file type'), ok);
  },
});

const styleMap = {
  realism: 'realism',
  comic: 'comic',
  manga: 'manga',
  'ghibli-inspired': 'ghibli-inspired',
};

function buildPrompt(style) {
  return [
    `Make this drawing into an image in ${style} style.`,
    'Preserve composition, shapes, and major colors.',
    'Keep it faithful to the original drawing.',
  ].join(' ');
}

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

function isSafetyRejection(info) {
  const text = `${String(info?.status || '')} ${String(info?.message || '')} ${String(info?.code || '')}`.toLowerCase();
  return (
    text.includes('safety') ||
    text.includes('unsafe') ||
    text.includes('blocked') ||
    text.includes('policy') ||
    text.includes('nsfw') ||
    text.includes('sexually explicit')
  );
}

function getBlockedReason(response) {
  const promptFeedbackReason = response?.promptFeedback?.blockReason;
  if (promptFeedbackReason) return String(promptFeedbackReason);

  const candidateReason = response?.candidates?.find((candidate) => candidate?.finishReason)?.finishReason;
  if (candidateReason) return String(candidateReason);

  return '';
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

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/gemini/health', async (req, res) => {
  try {
    const apiKey = req.get('x-gemini-api-key') || process.env.GEMINI_API_KEY || '';
    if (!apiKey) return res.status(400).json({ ok: false, error: 'Missing Gemini API key.' });

    const ai = new GoogleGenAI({ apiKey });
    await generateWithRetry(
      ai,
      [GEMINI_MODEL, GEMINI_FALLBACK_MODEL],
      [{ role: 'user', parts: [{ text: 'ping' }] }],
      1
    );

    return res.json({ ok: true });
  } catch (err) {
    const info = parseGeminiError(err);
    const message = info?.message || 'Gemini check failed.';
    const status = isRetryableGeminiError(info) ? 503 : 500;
    return res.status(status).json({ ok: false, error: message });
  }
});

app.get('/api/odyssey/token', (_req, res) => {
  const apiKey = process.env.ODYSSEY_API_KEY || '';
  if (!apiKey) return res.status(503).json({ error: 'Odyssey not configured.' });
  return res.json({ apiKey });
});

app.post('/api/nano-banana', uploadImage.single('image'), async (req, res) => {
  try {
    const apiKey = req.get('x-gemini-api-key') || process.env.GEMINI_API_KEY || '';
    if (!apiKey) return res.status(503).json({ error: 'Gemini not configured.' });
    if (!req.file) return res.status(400).json({ error: 'Missing image file.' });

    const styleRaw = String(req.body?.style || '').trim().toLowerCase();
    const style = styleMap[styleRaw] || 'realism';

    const base64 = req.file.buffer.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';
    const prompt = buildPrompt(style);

    const ai = new GoogleGenAI({ apiKey });
    const contents = [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64 } },
        ],
      },
    ];
    const { response } = await generateWithRetry(ai, [GEMINI_MODEL, GEMINI_FALLBACK_MODEL], contents, 2);

    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      const blockedReason = getBlockedReason(response);
      if (isSafetyRejection({ message: blockedReason })) {
        return res.status(422).json({
          error: 'This image was rejected by the safety filter. Try a different image.',
          reason: 'safety',
        });
      }
      return res.status(500).json({ error: 'No image returned from Gemini.' });
    }

    const outMime = imagePart.inlineData.mimeType || 'image/png';
    const outBase64 = imagePart.inlineData.data;
    return res.json({ imageBase64: outBase64, mimeType: outMime });
  } catch (err) {
    const info = parseGeminiError(err);
    if (isSafetyRejection(info)) {
      return res.status(422).json({
        error: 'This image was rejected by the safety filter. Try a different image.',
        reason: 'safety',
      });
    }
    const message = info?.message || 'Image generation failed.';
    const status = isRetryableGeminiError(info) ? 503 : 500;
    return res.status(status).json({ error: message });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

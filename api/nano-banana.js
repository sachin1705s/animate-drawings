import { parseMultipart } from './_multipart.js';
import { getGeminiClient, getGeminiModels, generateWithRetry, parseGeminiError, isRetryableGeminiError } from './_gemini.js';

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed.' });
    return;
  }

  try {
    const { fields, fileBuffer, fileMime } = await parseMultipart(req);
    if (!fileBuffer) {
      res.status(400).json({ error: 'Missing image file.' });
      return;
    }

    const styleRaw = String(fields?.style || '').trim().toLowerCase();
    const style = styleMap[styleRaw] || 'realism';
    const mimeType = fileMime || 'image/png';
    const base64 = fileBuffer.toString('base64');
    const prompt = buildPrompt(style);

    const ai = getGeminiClient();
    const contents = [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType, data: base64 } },
        ],
      },
    ];

    const { response } = await generateWithRetry(ai, getGeminiModels(), contents, 2);
    const parts = response?.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find((part) => part.inlineData?.data);
    if (!imagePart?.inlineData?.data) {
      res.status(500).json({ error: 'No image returned from Gemini.' });
      return;
    }

    const outMime = imagePart.inlineData.mimeType || 'image/png';
    const outBase64 = imagePart.inlineData.data;
    res.json({ imageBase64: outBase64, mimeType: outMime });
  } catch (err) {
    const info = parseGeminiError(err);
    const message = info?.message || 'Image generation failed.';
    const status = isRetryableGeminiError(info) ? 503 : 500;
    res.status(status).json({ error: message });
  }
}

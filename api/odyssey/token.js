export default async function handler(_req, res) {
  const apiKey = process.env.ODYSSEY_API_KEY || '';
  if (!apiKey) {
    res.status(503).json({ error: 'Odyssey not configured.' });
    return;
  }
  res.json({ apiKey });
}

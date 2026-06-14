import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { networkInterfaces } from 'os';

const PROVIDER = (process.env.PROVIDER ?? 'anthropic').toLowerCase();
const YNAB_BASE = 'https://api.youneedabudget.com/v1';

// ── Startup validation ────────────────────────────────────────────────────────

if (!process.env.YNAB_ACCESS_TOKEN) {
  console.error('YNAB_ACCESS_TOKEN is required');
  process.exit(1);
}
if (PROVIDER === 'anthropic' && !process.env.ANTHROPIC_API_KEY) {
  console.error('ANTHROPIC_API_KEY is required when PROVIDER=anthropic');
  process.exit(1);
}
if (PROVIDER === 'gemini' && !process.env.GEMINI_API_KEY) {
  console.error('GEMINI_API_KEY is required when PROVIDER=gemini');
  process.exit(1);
}
if (PROVIDER !== 'anthropic' && PROVIDER !== 'gemini') {
  console.error(`Unknown PROVIDER "${PROVIDER}". Use "anthropic" or "gemini".`);
  process.exit(1);
}

// ── AI clients ────────────────────────────────────────────────────────────────

const anthropic = PROVIDER === 'anthropic'
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const genai = PROVIDER === 'gemini'
  ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY })
  : null;

// ── Shared prompt ──────────────────────────────────────────────────────────────

function receiptPrompt(today) {
  return `Analyze this receipt and extract transaction details. Group line items by purchase category type.

Return ONLY a valid JSON object:
{
  "merchant_name": "store or restaurant name",
  "date": "YYYY-MM-DD (use ${today} if unclear)",
  "total_amount": 0.00,
  "memo": "1-sentence description of the overall purchase",
  "splits": [
    {
      "category": "one of: Food & Dining | Groceries | Gas & Fuel | Shopping | Entertainment | Healthcare | Transportation | Utilities | Other",
      "amount": 0.00,
      "description": "brief description of items in this group"
    }
  ]
}

Rules:
- Group items by category type; if all items are the same type, return one split with the full total
- splits[].amount values must sum exactly to total_amount
- total_amount is the FINAL amount paid (after tax/tip), as a positive decimal
- Return only the JSON object, no markdown fences, no explanation`;
}

function stripFences(text) {
  return text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
}

// ── Provider implementations ──────────────────────────────────────────────────

async function parseWithAnthropic(base64, mediaType, today) {
  const stream = await anthropic.messages.stream({
    model: 'claude-opus-4-8',
    max_tokens: 1024,
    thinking: { type: 'adaptive' },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: receiptPrompt(today) }
      ]
    }]
  });

  const message = await stream.finalMessage();
  const text = message.content.find(b => b.type === 'text')?.text ?? '';
  return JSON.parse(stripFences(text));
}

async function parseWithGemini(base64, mediaType, today) {
  const response = await genai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: mediaType, data: base64 } },
        { text: receiptPrompt(today) }
      ]
    }]
  });

  return JSON.parse(stripFences(response.text));
}

// ── Express app ───────────────────────────────────────────────────────────────

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

app.get('/api/config', (req, res) => {
  res.json({ provider: PROVIDER });
});

app.post('/api/parse-receipt', async (req, res) => {
  const { image, mediaType } = req.body;
  if (!image || !mediaType) {
    return res.status(400).json({ error: 'image and mediaType are required' });
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    const data = PROVIDER === 'gemini'
      ? await parseWithGemini(image, mediaType, today)
      : await parseWithAnthropic(image, mediaType, today);

    res.json({ success: true, data });
  } catch (err) {
    console.error('parse-receipt error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── YNAB proxy ────────────────────────────────────────────────────────────────

async function ynab(path, options = {}) {
  const response = await fetch(`${YNAB_BASE}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${process.env.YNAB_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      ...options.headers
    }
  });

  const body = await response.json();
  if (!response.ok) throw new Error(body.error?.detail ?? `YNAB ${response.status}`);
  return body.data;
}

app.get('/api/ynab/budgets', async (req, res) => {
  try {
    const data = await ynab('/budgets');
    res.json({ budgets: data.budgets });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ynab/budgets/:id/accounts', async (req, res) => {
  try {
    const data = await ynab(`/budgets/${req.params.id}/accounts`);
    res.json({ accounts: data.accounts });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/ynab/budgets/:id/categories', async (req, res) => {
  try {
    const data = await ynab(`/budgets/${req.params.id}/categories`);
    res.json({ category_groups: data.category_groups });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/ynab/budgets/:id/transactions', async (req, res) => {
  try {
    const data = await ynab(`/budgets/${req.params.id}/transactions`, {
      method: 'POST',
      body: JSON.stringify({ transaction: req.body.transaction })
    });
    res.json({ transaction: data.transaction });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ─────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT ?? 3000;

app.listen(PORT, '0.0.0.0', () => {
  const ip = Object.values(networkInterfaces())
    .flat()
    .find(n => n.family === 'IPv4' && !n.internal)?.address;

  const providerLabel = PROVIDER === 'gemini'
    ? 'Gemini 2.5 Flash'
    : 'Claude Opus 4.8';

  console.log(`\n📄  YNAB Receipt Scanner  [${providerLabel}]`);
  console.log(`    Local:   http://localhost:${PORT}`);
  if (ip) console.log(`    Network: http://${ip}:${PORT}`);
  console.log(`\nOpen the Network URL on your phone to use as a PWA.\n`);
});

import 'dotenv/config';
import express from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { networkInterfaces } from 'os';

const required = ['ANTHROPIC_API_KEY', 'YNAB_ACCESS_TOKEN'];
const missing = required.filter(k => !process.env[k]);
if (missing.length) {
  console.error(`Missing required env vars: ${missing.join(', ')}`);
  console.error('Copy .env.example to .env and fill in your keys.');
  process.exit(1);
}

const app = express();
app.use(express.json({ limit: '20mb' }));
app.use(express.static('public'));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const YNAB_BASE = 'https://api.youneedabudget.com/v1';

// ── Claude receipt parsing ──────────────────────────────────────────────────

app.post('/api/parse-receipt', async (req, res) => {
  const { image, mediaType } = req.body;
  if (!image || !mediaType) {
    return res.status(400).json({ error: 'image and mediaType are required' });
  }

  const today = new Date().toISOString().split('T')[0];

  try {
    const stream = await anthropic.messages.stream({
      model: 'claude-opus-4-8',
      max_tokens: 1024,
      thinking: { type: 'adaptive' },
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: mediaType, data: image }
          },
          {
            type: 'text',
            text: `Analyze this receipt image and extract the transaction details.

Return ONLY a valid JSON object with exactly these fields:
{
  "merchant_name": "store or restaurant name",
  "date": "YYYY-MM-DD (use ${today} if unclear)",
  "total_amount": 0.00,
  "memo": "1-sentence description of what was purchased",
  "suggested_category": "one of: Food & Dining | Groceries | Gas & Fuel | Shopping | Entertainment | Healthcare | Transportation | Utilities | Other"
}

Rules:
- total_amount is the FINAL amount paid (after tax/tip), as a positive decimal
- Return only the JSON object, no markdown fences, no explanation`
          }
        ]
      }]
    });

    const message = await stream.finalMessage();
    const text = message.content.find(b => b.type === 'text')?.text ?? '';
    const jsonStr = text.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    const data = JSON.parse(jsonStr);

    res.json({ success: true, data });
  } catch (err) {
    console.error('parse-receipt error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── YNAB proxy ───────────────────────────────────────────────────────────────

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

  if (!response.ok) {
    throw new Error(body.error?.detail ?? `YNAB ${response.status}`);
  }

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

  console.log(`\n📄  YNAB Receipt Scanner`);
  console.log(`    Local:   http://localhost:${PORT}`);
  if (ip) console.log(`    Network: http://${ip}:${PORT}`);
  console.log(`\nOpen the Network URL on your phone to use as a PWA.\n`);
});

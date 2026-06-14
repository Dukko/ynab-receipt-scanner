# YNAB Receipt Scanner

A self-hosted PWA that photographs receipts, uses AI vision to extract and categorise the line items, and creates YNAB transactions — all from your phone.

## Features

- **Camera or gallery** — tap to scan or pick an existing photo
- **AI parsing** — Claude or Gemini reads the receipt and groups items by category
- **Your YNAB categories** — the AI is given your actual budget categories so suggestions land on the right line
- **Split transactions** — mixed receipts (e.g. groceries + household) create YNAB subtransactions automatically
- **Autocomplete fields** — type to search accounts and categories
- **Installable PWA** — add to your home screen, works offline for the shell

## Stack

| Layer | Tech |
|---|---|
| Server | Node.js 20 + Express |
| AI | Claude Opus 4.8 (default) or Gemini 2.5 Flash |
| Budget | YNAB REST API |
| Frontend | Vanilla JS PWA (no framework) |
| Deploy | Docker Compose |

## Quick start

### 1. Clone and configure

```bash
git clone https://github.com/Dukko/ynab-receipt-scanner.git
cd ynab-receipt-scanner
```

You can supply credentials via a `.env` file (never committed):

```env
ANTHROPIC_API_KEY=sk-ant-...
YNAB_ACCESS_TOKEN=...
```

Or to use Gemini instead:

```env
GEMINI_API_KEY=AIza...
YNAB_ACCESS_TOKEN=...
PROVIDER=gemini
```

Alternatively, declare them directly in `docker-compose.yml` under the `environment` key:

```yaml
environment:
  - YNAB_ACCESS_TOKEN=...
  - ANTHROPIC_API_KEY=sk-ant-...
```

**Getting your tokens:**
- **Anthropic** — [console.anthropic.com](https://console.anthropic.com) → API Keys
- **Gemini** — [aistudio.google.com](https://aistudio.google.com) → Get API key
- **YNAB** — [app.ynab.com/settings/developer](https://app.ynab.com/settings/developer) → Personal Access Tokens

### 2. Run

```bash
docker compose up -d
```

The server starts on port 3000. Open `http://<your-server-ip>:3000` on your phone and tap **Add to Home Screen** to install the PWA.

## Environment variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `YNAB_ACCESS_TOKEN` | ✅ | — | YNAB personal access token |
| `ANTHROPIC_API_KEY` | ✅* | — | Anthropic API key |
| `GEMINI_API_KEY` | ✅* | — | Google AI API key |
| `PROVIDER` | | `anthropic` | `anthropic` or `gemini` |
| `PORT` | | `3000` | HTTP port |

\* One of `ANTHROPIC_API_KEY` or `GEMINI_API_KEY` is required depending on `PROVIDER`.

## Updating

The Docker image is built and published to `ghcr.io/dukko/ynab-receipt-scanner` automatically on every push to `main`. To pull the latest on your server:

```bash
docker compose pull && docker compose up -d
```

## How it works

1. Photo is compressed client-side (max 1600px, JPEG 85%) before upload
2. Your YNAB categories are pre-fetched in the background when the app loads
3. The image + your category list are sent to the AI, which returns grouped splits with exact category names
4. You review and adjust on the confirmation screen
5. Single-category receipts create a standard YNAB transaction; multi-category receipts use YNAB subtransactions

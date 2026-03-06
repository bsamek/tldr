# Readwise Reader Auto-Summarizer

A Cloudflare Worker that automatically summarizes articles saved to your Readwise Reader "Later" list and emails you the summary.

## How it works

```
Readwise Reader → Webhook → Cloudflare Worker → Claude → Email via Resend
```

When you move an article to "Later" in Reader, the worker receives a webhook, fetches the article content, generates a 3-5 paragraph summary using Claude, and emails it to you within seconds.

## Setup

### 1. Deploy the worker

```sh
npm install
npx wrangler login
npx wrangler deploy
```

### 2. Set secrets

```sh
npx wrangler secret put READWISE_TOKEN      # https://readwise.io/access_token
npx wrangler secret put ANTHROPIC_API_KEY    # Claude API key
npx wrangler secret put RESEND_API_KEY       # https://resend.com
npx wrangler secret put EMAIL_TO             # your email address
```

### 3. Configure the webhook

In Readwise Reader settings, create a webhook:
- **URL:** `https://readwise-summary.<your-subdomain>.workers.dev/webhook`
- **Event:** "Reader Document Moved To Later"

### 4. Test

Save an article to "Later" in Reader. You should receive a summary email within seconds.

Use `npx wrangler tail` to stream live logs if you need to debug.

## Tear down

```sh
npx wrangler delete
```

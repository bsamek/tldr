# Readwise Reader Inbox Summarizer

A Cloudflare Worker that automatically summarizes articles added to your Readwise Reader Inbox and emails you the summary, with one-click buttons to move the story to Later or archive it.

## How it works

```
Readwise Reader → Webhook → Cloudflare Worker → Claude → Email via Resend
```

When an article lands in your Reader Inbox, the worker receives a webhook, fetches the article content, generates a 3-5 paragraph summary using Claude, and emails it to you within seconds. Each email includes `Add to Later` and `Archive in Readwise` buttons so you can decide whether to keep the article for later reading or clear it out immediately.

## Setup

### 1. Deploy the worker

```sh
npm install
npx wrangler login
npm run deploy
```

### 2. Set secrets

```sh
npx wrangler secret put READWISE_TOKEN      # https://readwise.io/access_token
npx wrangler secret put READWISE_WEBHOOK_SECRET  # must match the webhook secret configured in Readwise
npx wrangler secret put ANTHROPIC_API_KEY    # Claude API key
npx wrangler secret put RESEND_API_KEY       # https://resend.com
npx wrangler secret put EMAIL_TO             # your email address
npx wrangler secret put ARCHIVE_LINK_SECRET  # random signing secret for Later/archive action URLs
```

### 3. Configure the webhook

In Readwise Reader settings, create a webhook:
- **URL:** `https://readwise-summary.<your-subdomain>.workers.dev/webhook`
- **Secret:** use the same value you stored in `READWISE_WEBHOOK_SECRET`
- **Events:**
  - `Reader Non-Feed Document Created`
  - `Reader Document Moved To Inbox`

If you want to summarize feed items too, use `Reader Any Document Created` instead of `Reader Non-Feed Document Created`.

Readwise's webhook/API payloads label Inbox items as `location: "new"`, even though the UI says "Inbox". This worker treats both `new` and `moved_to_inbox` as Inbox events.

### 4. Test

Add an article to Reader Inbox, or move one back into Inbox. You should receive a summary email within seconds. Use `Add to Later` if you want to read it later, or `Archive in Readwise` if the summary was enough.

Use `npx wrangler tail` to stream live logs if you need to debug.

## Tear down

```sh
npx wrangler delete
```

# Newsletter Email Summarizer

A Cloudflare Worker that summarizes forwarded newsletter emails and RSS feed articles, then sends per-item summaries back to your Gmail inbox.

## How It Works

```text
Gmail Filter -> Cloudflare Email Routing -> Worker -> OpenAI -> Resend -> Gmail
Cron (every 30 min)  -> RSS Feeds        -> Worker -> OpenAI -> Resend -> Gmail
Chrome Extension -> Readability.js       -> Worker -> OpenAI -> Resend -> Gmail
```

**Email path:** Gmail keeps the original newsletter in your inbox. A Gmail filter forwards matching senders to a Cloudflare-managed email address, the Worker parses the message body, asks OpenAI `gpt-5.4` for a 3-5 paragraph summary with `reasoning.effort` set to `none`, and Resend sends the summary back to you.

**RSS path:** A Cloudflare Cron Trigger runs every 30 minutes, fetches configured RSS/Atom feeds, extracts new articles, summarizes them with the same OpenAI pipeline, and emails the summaries via Resend. Already-processed items are skipped using the same KV dedup store.

**Chrome extension path:** A Manifest V3 Chrome extension lets you save any article — including paywalled pages you're logged into — by clicking "Summarize This Page." The extension uses Mozilla's Readability.js to extract the article content in-browser, then POSTs it to the Worker's `POST /api/save` endpoint with Bearer token auth. The Worker deduplicates, summarizes, and emails the result.

## Setup

### 1. Install and deploy

```sh
npm install
npx wrangler login
```

Create the KV namespaces and copy the returned IDs into `wrangler.toml`:

```sh
npx wrangler kv namespace create PROCESSED_EMAILS
npx wrangler kv namespace create PROCESSED_EMAILS --preview
```

Then deploy:

```sh
npm run deploy
```

### 2. Set Worker secrets

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_TO
npx wrangler secret put SUMMARY_FROM
npx wrangler secret put API_KEY
```

- `API_KEY`: shared Bearer token for the Chrome extension. Generate one with `openssl rand -hex 32`.

- `EMAIL_TO`: the Gmail address that should receive summary emails.
- `SUMMARY_FROM`: a verified Resend sender on your domain. The Worker sends `Newsletter Summary <SUMMARY_FROM>`.
- The Worker currently truncates extracted email text to 80,000 characters before summarization and caps model output at 1,024 tokens. Those are application guardrails for cost and latency, not GPT-5.4 model limits.

### 3. Configure RSS feeds (optional)

Set the `RSS_FEEDS` environment variable to a JSON array of feed configs:

```sh
npx wrangler secret put RSS_FEEDS
# Enter: [{"url":"https://example.com/feed.xml","name":"Example Blog"}]
```

Or set it in `wrangler.toml` under `[vars]` for non-sensitive feeds. The cron trigger runs every 30 minutes and processes up to 5 new items per feed per run.

### 4. Configure Cloudflare Email Routing

You need a domain using Cloudflare as the authoritative nameserver.

1. Enable Email Routing for the domain in Cloudflare.
2. Create an address such as `newsletters@your-domain.com` and route it to this Worker.
3. Make sure `EMAIL_TO` is also a verified Cloudflare Email Routing destination address. The Worker forwards Gmail's forwarding-confirmation email there instead of trying to summarize it.

### 5. Configure Gmail forwarding and filters

1. In Gmail settings, add the Cloudflare address such as `newsletters@your-domain.com` as a forwarding address.
2. Wait for Gmail's forwarding confirmation email to arrive in `EMAIL_TO`, then approve the forwarding address in Gmail.
3. Create one or more Gmail filters for newsletter senders and choose `Forward it to` the Cloudflare address.
4. Keep the filters narrow enough that they do not match the summary emails coming back from `SUMMARY_FROM`, or you will create a loop.

### 6. Local development

```sh
npm run dev
```

In local development, Cloudflare exposes the email handler at `/cdn-cgi/handler/email`. You can post a raw `.eml` file to it or trigger the cron manually:

```sh
curl "http://localhost:8787/__scheduled?cron=*/30+*+*+*+*"
```

For email testing:

```sh
curl -X POST http://127.0.0.1:8787/cdn-cgi/handler/email \
  --url-query 'from=sender@example.com' \
  --url-query 'to=newsletters@your-domain.com' \
  -H 'Content-Type: message/rfc822' \
  --data-binary @sample.eml
```

Run the automated checks with:

```sh
npm run typecheck
npm test
```

### 7. Install the Chrome extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory.
3. Click the extension icon, enter your Worker URL (e.g. `https://readwise-summary.your-domain.workers.dev`) and the `API_KEY` you set above, then click **Save Settings**.
4. Navigate to any article page and click **Summarize This Page**.

### 8. Manual test

Forward one newsletter sender to the Cloudflare address and confirm:

- the original newsletter stays in Gmail
- one summary email arrives from Resend
- the summary email has no action buttons

Use `npx wrangler tail` to stream Worker logs while testing.

## Backlog

- Remove Readwise completely later.
- Add a Safari share sheet flow on iOS.

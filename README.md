# TLDR

A Cloudflare Worker that summarizes forwarded newsletter emails, RSS feed articles, and web pages, then sends per-item summaries back to your Gmail inbox.

## How It Works

```text
Gmail Filter     -> Cloudflare Email Routing -> Worker -> Anthropic -> [OpenAI TTS] -> Resend -> Gmail
Cron (every 30 min)  -> RSS Feeds           -> Worker -> Anthropic -> [OpenAI TTS] -> Resend -> Gmail
Chrome Extension -> Readability.js          -> Worker -> Anthropic -> [OpenAI TTS] -> Resend -> Gmail
iOS Shortcut     -> Safari JS extraction    -> Worker -> Anthropic -> [OpenAI TTS] -> Resend -> Gmail
```

**Email path:** Gmail keeps the original newsletter in your inbox. A Gmail filter forwards matching senders to a Cloudflare-managed email address, the Worker parses the message body, summarizes with `claude-sonnet-4-6`, and Resend sends the summary back to you.

**RSS path:** A Cloudflare Cron Trigger runs every 30 minutes, fetches configured RSS/Atom feeds, extracts new articles, summarizes them, and emails the summaries via Resend. Already-processed items are skipped using the same KV dedup store.

**Chrome extension path:** A Manifest V3 Chrome extension lets you save any article — including paywalled pages you're logged into — by clicking "Summarize This Page." The extension uses Mozilla's Readability.js to extract the article content in-browser, then POSTs it to the Worker's `POST /api/save` endpoint with Bearer token auth. The Worker deduplicates, summarizes, and emails the result.

**iOS Shortcut path:** An iOS Shortcut appears in Safari's share sheet, runs JavaScript on the current page to extract the article text (works with paywalled content since it runs in your authenticated session), and POSTs it to the same `POST /api/save` endpoint. No app or extension to install — just a Shortcut.

**Article links:** Summary emails from RSS feeds, the Chrome extension, and iOS Shortcuts include a "Read original" link back to the source article. Forwarded email summaries omit the link since newsletters don't have a single canonical URL. When Pushover is configured, tapping a push notification opens the original article directly.

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
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put EMAIL_TO
npx wrangler secret put SUMMARY_FROM
npx wrangler secret put API_KEY
```

- `API_KEY`: shared Bearer token for the Chrome extension. Generate one with `openssl rand -hex 32`.

- `EMAIL_TO`: the Gmail address that should receive summary emails.
- `SUMMARY_FROM`: a verified Resend sender on your domain. The Worker sends emails from `Newsletter Summary <SUMMARY_FROM>` for forwarded emails or `Blog Post Summary <SUMMARY_FROM>` for RSS feed items.
- The Worker currently truncates extracted email text to 80,000 characters before summarization and caps model output at 1,024 tokens.

### 3. Configure Pushover notifications (optional)

To receive an iOS push notification whenever a summary email is sent, set up [Pushover](https://pushover.net):

1. Create a Pushover account and install the [Pushover iOS app](https://pushover.net/clients/ios) ($5 one-time purchase).
2. Create an application in the [Pushover dashboard](https://pushover.net/apps/build) to get an API token.
3. Set both secrets:

```sh
npx wrangler secret put PUSHOVER_USER_KEY
npx wrangler secret put PUSHOVER_API_TOKEN
```

When both are configured, each summary email will also trigger a push notification with the article title and summary. If either secret is missing, notifications are silently skipped.

### 4. Configure text-to-speech audio (optional)

To receive a linked MP3 audio version of each summary in the email, enable [OpenAI TTS](https://platform.openai.com/docs/guides/text-to-speech) and set up a Cloudflare R2 bucket for audio storage:

```sh
# Create the R2 bucket
npx wrangler r2 bucket create tldr-tts-audio
```

Enable public access on the bucket via the Cloudflare Dashboard (R2 > tldr-tts-audio > Settings > Public access) using either a custom domain or the r2.dev subdomain.

Optionally, add a lifecycle rule to auto-delete audio files after 90 days: R2 > tldr-tts-audio > Settings > Object lifecycle rules > Add rule > Delete objects after 90 days.

Then set the secrets:

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put TTS_ENABLED
# Enter: true
npx wrangler secret put TTS_AUDIO_PUBLIC_URL
# Enter: https://your-r2-public-domain.com (the public base URL of the bucket)
```

Optionally set a playback speed (0.25–4.0, default 1.0):

```sh
npx wrangler secret put TTS_SPEED
# Enter: 1.2
```

When configured, each summary email will include a "🎧 Listen to summary" link next to the "🔗 Read original" link at the top of the email. The default voice is `alloy` — you can change it by modifying the `TTS_VOICE` constant in `src/worker.ts` (options: alloy, echo, fable, onyx, nova, shimmer). Pricing is ~$0.00005 per summary ($15 per 1M characters). If TTS generation or upload fails, the email is still sent without the audio link.

### 5. Configure RSS feeds (optional)

Set the `RSS_FEEDS` environment variable to a JSON array of feed configs:

```sh
npx wrangler secret put RSS_FEEDS
# Enter: [{"url":"https://example.com/feed.xml","name":"Example Blog"}]
```

**Do not** put your feed list in `wrangler.toml` — use `wrangler secret put` so it stays out of version control. The cron trigger runs every 30 minutes and processes up to 5 new items per feed per run.

### 6. Configure Cloudflare Email Routing

You need a domain using Cloudflare as the authoritative nameserver.

1. Enable Email Routing for the domain in Cloudflare.
2. Create an address such as `newsletters@your-domain.com` and route it to this Worker.
3. Make sure `EMAIL_TO` is also a verified Cloudflare Email Routing destination address. The Worker forwards Gmail's forwarding-confirmation email there instead of trying to summarize it.

### 7. Configure Gmail forwarding and filters

1. In Gmail settings, add the Cloudflare address such as `newsletters@your-domain.com` as a forwarding address.
2. Wait for Gmail's forwarding confirmation email to arrive in `EMAIL_TO`, then approve the forwarding address in Gmail.
3. Create one or more Gmail filters for newsletter senders and choose `Forward it to` the Cloudflare address.
4. Keep the filters narrow enough that they do not match the summary emails coming back from `SUMMARY_FROM`, or you will create a loop.

### 8. Local development

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

### 9. Install the Chrome extension

1. Open `chrome://extensions` and enable **Developer mode**.
2. Click **Load unpacked** and select the `extension/` directory.
3. Click the extension icon, enter your Worker URL (e.g. `https://tldr.your-domain.workers.dev`) and the `API_KEY` you set above, then click **Save Settings**.
4. Navigate to any article page and click **Summarize This Page**.

### 10. Set up the iOS Shortcut (optional)

This adds a "Summarize This Page" option to Safari's share sheet on iOS. Because the JavaScript runs inside your Safari session, it can extract full article text from paywalled pages you're logged into.

1. Open the **Shortcuts** app on your iPhone or iPad.
2. Tap **+** to create a new shortcut. Tap the name at the top and choose **Rename** to give it a name like "Summarize This Page."
3. Tap the name again and choose **Add to Share Sheet**. Under **Share Sheet Types**, deselect everything except **Safari web pages**.
4. Add a **Run JavaScript on Safari Web Page** action and paste this script:

   ```javascript
   const article = {
     url: document.URL,
     title: document.title,
     content: document.body.innerText.substring(0, 80000),
     siteName:
       (document.querySelector('meta[property="og:site_name"]') || {}).content ||
       window.location.hostname
   };
   completion(article);
   ```

5. Add a **Get Contents of URL** action and configure it:
   - **URL:** `https://tldr.your-domain.workers.dev/api/save` (your Worker URL)
   - **Method:** POST
   - **Headers:** add `Authorization` with value `Bearer <your API_KEY>`
   - **Request Body:** JSON — add keys `url`, `title`, `content`, and `siteName`, setting each value to the corresponding field from the **Run JavaScript on Safari Web Page** output (use the variable picker).

6. Optionally add a **Show Notification** action with the text "Summary sent!" so you get confirmation.

To use it: open any article in Safari, tap the **Share** button, and select **Summarize This Page** from the share sheet.

### 11. Manual test

Forward one newsletter sender to the Cloudflare address and confirm:

- the original newsletter stays in Gmail
- one summary email arrives from Resend
- the summary email has no action buttons

Use `npx wrangler tail` to stream Worker logs while testing.
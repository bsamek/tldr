# Newsletter Email Summarizer

A Cloudflare Worker that summarizes forwarded newsletter emails and sends a per-email summary back to your Gmail inbox.

## How It Works

```text
Gmail Filter -> Cloudflare Email Routing -> Worker -> OpenAI -> Resend -> Gmail
```

Gmail keeps the original newsletter in your inbox. A Gmail filter forwards matching senders to a Cloudflare-managed email address, the Worker parses the message body, asks OpenAI `gpt-5.4` for a 3-5 paragraph summary with `reasoning.effort` set to `none`, and Resend sends the summary back to you. Each summary email includes a link to the original article URL when the Worker can extract one confidently.

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
```

- `EMAIL_TO`: the Gmail address that should receive summary emails.
- `SUMMARY_FROM`: a verified Resend sender on your domain. The Worker sends `Newsletter Summary <SUMMARY_FROM>`.
- The Worker currently truncates extracted email text to 80,000 characters before summarization and caps model output at 1,024 tokens. Those are application guardrails for cost and latency, not GPT-5.4 model limits.

### 3. Configure Cloudflare Email Routing

You need a domain using Cloudflare as the authoritative nameserver.

1. Enable Email Routing for the domain in Cloudflare.
2. Create an address such as `newsletters@your-domain.com` and route it to this Worker.
3. Make sure `EMAIL_TO` is also a verified Cloudflare Email Routing destination address. The Worker forwards Gmail's forwarding-confirmation email there instead of trying to summarize it.

### 4. Configure Gmail forwarding and filters

1. In Gmail settings, add the Cloudflare address such as `newsletters@your-domain.com` as a forwarding address.
2. Wait for Gmail's forwarding confirmation email to arrive in `EMAIL_TO`, then approve the forwarding address in Gmail.
3. Create one or more Gmail filters for newsletter senders and choose `Forward it to` the Cloudflare address.
4. Keep the filters narrow enough that they do not match the summary emails coming back from `SUMMARY_FROM`, or you will create a loop.

### 5. Local development

```sh
npm run dev
```

In local development, Cloudflare exposes the email handler at `/cdn-cgi/handler/email`. You can post a raw `.eml` file to it:

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

### 6. Manual test

Forward one newsletter sender to the Cloudflare address and confirm:

- the original newsletter stays in Gmail
- one summary email arrives from Resend
- the summary email has no action buttons
- the summary email includes a source URL only when the Worker found a confident non-tracking article link

Use `npx wrangler tail` to stream Worker logs while testing.

## Backlog

- Replace the Readwise RSS path later, likely via polling.
- Remove Readwise completely later.
- Add a Safari share sheet flow on iOS.
- Add a Chrome extension on desktop.

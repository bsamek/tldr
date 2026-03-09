import PostalMime, { type Address, type Email as ParsedEmail } from "postal-mime";

export interface Env {
	ANTHROPIC_API_KEY: string;
	RESEND_API_KEY: string;
	EMAIL_TO: string;
	SUMMARY_FROM: string;
	PROCESSED_EMAILS: KVNamespace;
}

export interface EmailMetadata {
	messageId: string;
	subject: string;
	fromName: string;
	fromAddress: string;
	date?: string;
	html?: string;
	text?: string;
}

const HEALTH_PATH = "/healthz";
const MAX_SUMMARY_CHARS = 80_000;
const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7;
const MAX_URL_UNWRAPS = 3;
const SUMMARY_PREFIX = "Newsletter Summary";

const FOOTER_BREAK_PATTERNS = [
	/^\s*unsubscribe\b/i,
	/^\s*manage preferences\b/i,
	/^\s*update your preferences\b/i,
	/^\s*privacy policy\b/i,
	/^\s*terms of service\b/i,
	/^\s*mailing address\b/i,
	/^\s*you received this email\b/i,
	/^\s*to stop receiving these emails\b/i,
];

const INLINE_SKIP_PATTERNS = [
	/^\s*view in browser\b/i,
	/^\s*read online\b/i,
	/^\s*open in browser\b/i,
	/^\s*share this email\b/i,
	/^\s*was this email forwarded to you\?\b/i,
];

const QUOTED_REPLY_PATTERNS = [/^\s*on .+ wrote:\s*$/i, /^\s*>+/, /^\s*from:\s+/i];

const IGNORED_URL_HOSTS = new Set([
	"facebook.com",
	"help.instagram.com",
	"instagram.com",
	"linkedin.com",
	"list-manage.com",
	"mailchi.mp",
	"mailchimpapp.net",
	"mailto",
	"twitter.com",
	"x.com",
	"youtube.com",
]);

const IGNORED_URL_PATH_PATTERNS = [
	/unsubscribe/i,
	/manage-?preferences/i,
	/privacy/i,
	/share/i,
	/social/i,
	"open.spotify.com",
];

const TRACKING_HOST_PATTERNS = [
	/^click\./i,
	/^email\./i,
	/^links?\./i,
	/^newsletters?\./i,
	/^trk\./i,
];

const REDIRECT_QUERY_PARAMS = [
	"url",
	"u",
	"q",
	"redirect",
	"redirect_url",
	"destination",
	"dest",
	"target",
];

const GMAIL_FORWARDING_FROM = "forwarding-noreply@google.com";
const GMAIL_FORWARDING_SUBJECT = /gmail forwarding confirmation/i;

export default {
	async fetch(request: Request): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === HEALTH_PATH) {
			return jsonResponse({
				ok: true,
				service: "newsletter-summary-worker",
				ingress: "email-routing",
			});
		}

		return new Response("Not found", { status: 404 });
	},

	async email(
		message: ForwardableEmailMessage,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		if (isGmailForwardingConfirmation(message.headers)) {
			ctx.waitUntil(
				handleGmailForwardingConfirmation(message, env).catch((error) => {
					console.error("Gmail forwarding confirmation handling failed:", error);
				}),
			);
			return;
		}

		ctx.waitUntil(
			processIncomingEmail(message, env).catch((error) => {
				console.error("Email processing failed:", error);
			}),
		);
	},
};

export async function handleGmailForwardingConfirmation(
	message: ForwardableEmailMessage,
	env: Env,
): Promise<void> {
	try {
		await message.forward(env.EMAIL_TO);
		return;
	} catch (error) {
		console.error(
			"Native forward failed for Gmail confirmation email; falling back to Resend.",
			error,
		);
	}

	const raw = await new Response(message.raw).arrayBuffer();
	const parsed = await PostalMime.parse(raw);
	const subject = sanitizeSubject(
		sanitizeHeaderValue(parsed.subject || message.headers.get("subject")) ||
			"Gmail Forwarding Confirmation",
	);
	const sender = parsed.from
		? formatMailbox(selectMailbox(parsed.from))
		: sanitizeHeaderValue(message.headers.get("from")) || GMAIL_FORWARDING_FROM;
	const html = parsed.html?.trim();
	const text = parsed.text?.trim() || stripHtml(html || "").trim();

	await sendResendEmail(
		{
			from: formatSummaryFrom(env.SUMMARY_FROM),
			to: env.EMAIL_TO,
			subject: `Fwd: ${subject}`,
			html: renderForwardingConfirmationHtml({
				subject,
				sender,
				html,
				text,
			}),
			text: renderForwardingConfirmationText({
				subject,
				sender,
				text,
			}),
		},
		env.RESEND_API_KEY,
	);
}

export async function processIncomingEmail(
	message: ForwardableEmailMessage,
	env: Env,
): Promise<void> {
	const raw = await new Response(message.raw).arrayBuffer();
	const parsed = await PostalMime.parse(raw);
	const metadata = getEmailMetadata(message, parsed);
	const dedupeKey = await createDedupeKey(metadata);

	if (await hasProcessedEmail(dedupeKey, env.PROCESSED_EMAILS)) {
		console.log("Skipping duplicate email", {
			messageId: metadata.messageId,
			subject: metadata.subject,
		});
		return;
	}

	const content = extractSummaryContent(metadata);
	if (!content) {
		await recordProcessedEmail(dedupeKey, env.PROCESSED_EMAILS, {
			status: "skipped_empty",
			subject: metadata.subject,
		});
		console.log("Skipping email with no usable content", {
			messageId: metadata.messageId,
			subject: metadata.subject,
		});
		return;
	}

	const sourceUrl = extractOriginalArticleUrl(metadata.html, metadata.text);
	const summary = await summarizeEmail(
		{
			subject: metadata.subject,
			sender: formatSender(metadata),
			sourceUrl,
			content,
		},
		env.ANTHROPIC_API_KEY,
	);

	await sendSummaryEmail(
		{
			subject: metadata.subject,
			sender: formatSender(metadata),
			summary,
			sourceUrl,
		},
		env,
		dedupeKey,
	);

	await recordProcessedEmail(dedupeKey, env.PROCESSED_EMAILS, {
		status: "sent",
		subject: metadata.subject,
		sourceUrl,
	});
}

export function isGmailForwardingConfirmation(headers: Headers): boolean {
	const from = headers.get("from") || "";
	const subject = headers.get("subject") || "";
	return (
		from.toLowerCase().includes(GMAIL_FORWARDING_FROM) &&
		GMAIL_FORWARDING_SUBJECT.test(subject)
	);
}

export function getEmailMetadata(
	message: ForwardableEmailMessage,
	parsed: ParsedEmail,
): EmailMetadata {
	const mailbox = selectMailbox(parsed.from);
	const subject = sanitizeHeaderValue(parsed.subject || message.headers.get("subject"));
	const messageId = sanitizeHeaderValue(
		parsed.messageId || message.headers.get("message-id"),
	);
	const fromAddress = mailbox.address || sanitizeHeaderValue(message.headers.get("from"));

	return {
		messageId:
			messageId ||
			`synthetic:${subject}:${sanitizeHeaderValue(message.headers.get("date"))}`,
		subject: subject || "Untitled newsletter",
		fromName: mailbox.name || "",
		fromAddress,
		date: sanitizeHeaderValue(parsed.date || message.headers.get("date")),
		html: parsed.html,
		text: parsed.text,
	};
}

export function extractSummaryContent(metadata: EmailMetadata): string {
	const baseText = normalizeText(metadata.text || stripHtml(metadata.html || ""));
	if (!baseText) {
		return "";
	}

	const lines = baseText.split("\n");
	const cleaned: string[] = [];

	for (const line of lines) {
		const trimmed = line.trim();

		if (!trimmed) {
			cleaned.push("");
			continue;
		}

		if (INLINE_SKIP_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			continue;
		}

		if (QUOTED_REPLY_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			break;
		}

		if (FOOTER_BREAK_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			break;
		}

		cleaned.push(trimmed);
	}

	return collapseWhitespace(cleaned.join("\n")).slice(0, MAX_SUMMARY_CHARS);
}

export function extractOriginalArticleUrl(
	html?: string,
	text?: string,
): string | undefined {
	const candidates = [
		...extractUrlsFromHtml(html || ""),
		...extractUrlsFromText(text || ""),
	];

	for (const candidate of candidates) {
		const normalized = unwrapTrackingUrl(candidate);
		if (!normalized) {
			continue;
		}

		if (isLikelyArticleUrl(normalized)) {
			return normalized;
		}
	}

	return undefined;
}

export function unwrapTrackingUrl(rawUrl: string): string | undefined {
	let current = normalizeCandidateUrl(rawUrl);
	if (!current) {
		return undefined;
	}

	for (let depth = 0; depth < MAX_URL_UNWRAPS; depth += 1) {
		const url = safeUrl(current);
		if (!url) {
			return undefined;
		}

		const redirectTarget = REDIRECT_QUERY_PARAMS
			.map((key) => url.searchParams.get(key))
			.find((value) => value && /^https?:\/\//i.test(value));

		if (!redirectTarget) {
			return url.toString();
		}

		current = normalizeCandidateUrl(redirectTarget);
		if (!current) {
			return undefined;
		}
	}

	return current;
}

export function isLikelyArticleUrl(candidate: string): boolean {
	const url = safeUrl(candidate);
	if (!url || !/^https?:$/.test(url.protocol)) {
		return false;
	}

	const hostname = normalizeHostname(url.hostname);
	if (
		IGNORED_URL_HOSTS.has(hostname) ||
		TRACKING_HOST_PATTERNS.some((pattern) => pattern.test(hostname))
	) {
		return false;
	}

	const fullPath = `${url.pathname}${url.search}${url.hash}`;
	return !IGNORED_URL_PATH_PATTERNS.some((pattern) =>
		typeof pattern === "string"
			? `${hostname}${fullPath}`.includes(pattern)
			: pattern.test(fullPath),
	);
}

export async function createDedupeKey(metadata: EmailMetadata): Promise<string> {
	const basis = [
		metadata.messageId,
		metadata.fromAddress,
		metadata.subject,
		metadata.date || "",
	]
		.filter(Boolean)
		.join("|");
	return `email:${await sha256Hex(basis)}`;
}

export async function hasProcessedEmail(
	key: string,
	namespace: KVNamespace,
): Promise<boolean> {
	return (await namespace.get(key)) !== null;
}

export async function recordProcessedEmail(
	key: string,
	namespace: KVNamespace,
	value: Record<string, unknown>,
): Promise<void> {
	await namespace.put(key, JSON.stringify(value), {
		expirationTtl: DEDUPE_TTL_SECONDS,
	});
}

export async function summarizeEmail(
	input: {
		subject: string;
		sender: string;
		sourceUrl?: string;
		content: string;
	},
	apiKey: string,
): Promise<string> {
	const resp = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"content-type": "application/json",
		},
		body: JSON.stringify({
			model: "claude-sonnet-4-6",
			max_tokens: 1024,
			messages: [
				{
					role: "user",
					content: `Summarize the following forwarded newsletter or article email in 3-5 concise prose paragraphs. Write in plain prose with no headers, no labels, and no bullet points.

Email subject: ${input.subject}
Email sender: ${input.sender}
Original article URL: ${input.sourceUrl || "Unavailable"}

Email content:
${input.content.slice(0, MAX_SUMMARY_CHARS)}`,
				},
			],
		}),
	});

	if (!resp.ok) {
		throw new Error(`Claude API error: ${resp.status} ${await resp.text()}`);
	}

	const data = (await resp.json()) as {
		content: { type: string; text: string }[];
	};
	const summary = data.content.find((item) => item.type === "text")?.text?.trim();

	if (!summary) {
		throw new Error("Claude API returned no text content");
	}

	return summary;
}

export async function sendSummaryEmail(
	input: {
		subject: string;
		sender: string;
		summary: string;
		sourceUrl?: string;
	},
	env: Env,
	dedupeKey: string,
): Promise<void> {
	await sendResendEmail(
		{
			from: formatSummaryFrom(env.SUMMARY_FROM),
			to: env.EMAIL_TO,
			subject: `${SUMMARY_PREFIX}: ${sanitizeSubject(input.subject)}`,
			html: renderSummaryHtml(input),
			text: renderSummaryText(input),
		},
		env.RESEND_API_KEY,
		dedupeKey,
	);
}

export function renderSummaryHtml(input: {
	subject: string;
	sender: string;
	summary: string;
	sourceUrl?: string;
}): string {
	const summaryParagraphs = input.summary
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map(
			(paragraph) =>
				`<p style="margin:0 0 16px; line-height:1.7; color:#1f2937;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
		)
		.join("");

	const sourceLink = input.sourceUrl
		? `<p style="margin:0; line-height:1.6;"><a href="${escapeHtml(input.sourceUrl)}" style="color:#0f4c81;">Open original article</a></p>`
		: `<p style="margin:0; line-height:1.6; color:#6b7280;">Original article URL unavailable.</p>`;

	return `<!doctype html>
<html lang="en">
  <body style="margin:0; padding:24px; background:#f4f1ea; font-family: Georgia, 'Times New Roman', serif; color:#111827;">
    <div style="max-width:680px; margin:0 auto; background:#fffdf8; border:1px solid #e5dccf; border-radius:16px; padding:32px;">
      <p style="margin:0 0 12px; font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:#9a6b2f;">${SUMMARY_PREFIX}</p>
      <h1 style="margin:0 0 12px; font-size:30px; line-height:1.2; color:#111827;">${escapeHtml(input.subject)}</h1>
      <p style="margin:0 0 24px; line-height:1.6; color:#4b5563;">From ${escapeHtml(input.sender)}</p>
      ${summaryParagraphs}
      <div style="margin-top:24px;">${sourceLink}</div>
    </div>
  </body>
</html>`;
}

export function renderSummaryText(input: {
	subject: string;
	sender: string;
	summary: string;
	sourceUrl?: string;
}): string {
	const lines = [
		input.summary.trim(),
		"",
		"---",
		`From: ${input.sender}`,
	];

	if (input.sourceUrl) {
		lines.push(`Original article: ${input.sourceUrl}`);
	}

	return lines.join("\n");
}

export function renderForwardingConfirmationHtml(input: {
	subject: string;
	sender: string;
	html?: string;
	text?: string;
}): string {
	const originalContent = input.html
		? input.html
		: `<pre style="margin:0; white-space:pre-wrap; line-height:1.6; color:#1f2937;">${escapeHtml(input.text || "")}</pre>`;

	return `<!doctype html>
<html lang="en">
  <body style="margin:0; padding:24px; background:#f4f1ea; font-family: Georgia, 'Times New Roman', serif; color:#111827;">
    <div style="max-width:680px; margin:0 auto; background:#fffdf8; border:1px solid #e5dccf; border-radius:16px; padding:32px;">
      <p style="margin:0 0 12px; font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:#9a6b2f;">Forwarding Confirmation</p>
      <h1 style="margin:0 0 12px; font-size:30px; line-height:1.2; color:#111827;">${escapeHtml(input.subject)}</h1>
      <p style="margin:0 0 24px; line-height:1.6; color:#4b5563;">Originally sent by ${escapeHtml(input.sender)}</p>
      <p style="margin:0 0 24px; line-height:1.7; color:#1f2937;">Cloudflare forwarding failed for the original Gmail confirmation email, so this copy was resent through Resend. Use the confirmation link or code below to finish Gmail forwarding setup.</p>
      <div style="line-height:1.6; color:#1f2937;">${originalContent}</div>
    </div>
  </body>
</html>`;
}

export function renderForwardingConfirmationText(input: {
	subject: string;
	sender: string;
	text?: string;
}): string {
	return [
		"Cloudflare forwarding failed for the original Gmail confirmation email, so this copy was resent through Resend.",
		"Use the confirmation link or code below to finish Gmail forwarding setup.",
		"",
		`Subject: ${input.subject}`,
		`From: ${input.sender}`,
		"",
		input.text?.trim() || "(No text content was available in the original email.)",
	].join("\n");
}

function jsonResponse(data: Record<string, unknown>, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
		},
	});
}

function selectMailbox(address?: Address): { name: string; address: string } {
	if (!address) {
		return { name: "", address: "" };
	}

	if ("group" in address) {
		const mailbox = address.group?.[0];
		return {
			name: mailbox?.name || "",
			address: mailbox?.address || "",
		};
	}

	return {
		name: address.name || "",
		address: address.address || "",
	};
}

function formatSender(metadata: EmailMetadata): string {
	if (metadata.fromName && metadata.fromAddress) {
		return `${metadata.fromName} <${metadata.fromAddress}>`;
	}

	return metadata.fromName || metadata.fromAddress || "Unknown sender";
}

function formatMailbox(mailbox: { name: string; address: string }): string {
	if (mailbox.name && mailbox.address) {
		return `${mailbox.name} <${mailbox.address}>`;
	}

	return mailbox.name || mailbox.address || "Unknown sender";
}

function formatSummaryFrom(summaryFrom: string): string {
	return /<.+>/.test(summaryFrom)
		? summaryFrom
		: `Newsletter Summary <${summaryFrom}>`;
}

function sanitizeHeaderValue(value: string | null | undefined): string {
	return (value || "").replace(/\s+/g, " ").trim();
}

function sanitizeSubject(subject: string): string {
	return sanitizeHeaderValue(subject).replace(/[\r\n]+/g, " ");
}

function normalizeText(value: string): string {
	return value
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/\u00a0/g, " ")
		.replace(/\u200b/g, "");
}

function stripHtml(html: string): string {
	return decodeHtmlEntities(
		html
			.replace(/<style[\s\S]*?<\/style>/gi, " ")
			.replace(/<script[\s\S]*?<\/script>/gi, " ")
			.replace(/<br\s*\/?>/gi, "\n")
			.replace(/<\/(p|div|section|article|li|h[1-6])>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	);
}

function collapseWhitespace(value: string): string {
	return value
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
}

function extractUrlsFromHtml(html: string): string[] {
	const matches = html.matchAll(/href\s*=\s*(['"])(.*?)\1/gi);
	return Array.from(matches, (match) => decodeHtmlEntities(match[2]));
}

function extractUrlsFromText(text: string): string[] {
	const matches = text.match(/https?:\/\/[^\s<>"')]+/gi);
	return matches ? matches.map((match) => match.trim()) : [];
}

function normalizeCandidateUrl(rawUrl: string): string | undefined {
	const trimmed = decodeHtmlEntities(rawUrl)
		.trim()
		.replace(/[)>.,]+$/g, "");
	return /^https?:\/\//i.test(trimmed) ? trimmed : undefined;
}

function safeUrl(candidate: string): URL | undefined {
	try {
		return new URL(candidate);
	} catch {
		return undefined;
	}
}

function normalizeHostname(hostname: string): string {
	return hostname.replace(/^www\./i, "").toLowerCase();
}

function decodeHtmlEntities(value: string): string {
	return value
		.replace(/&amp;/gi, "&")
		.replace(/&quot;/gi, '"')
		.replace(/&#39;/gi, "'")
		.replace(/&apos;/gi, "'")
		.replace(/&lt;/gi, "<")
		.replace(/&gt;/gi, ">");
}

async function sha256Hex(value: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(value),
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0"),
	).join("");
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

async function sendResendEmail(
	input: {
		from: string;
		to: string;
		subject: string;
		html: string;
		text: string;
	},
	apiKey: string,
	idempotencyKey?: string,
): Promise<void> {
	const headers: Record<string, string> = {
		Authorization: `Bearer ${apiKey}`,
		"Content-Type": "application/json",
	};

	if (idempotencyKey) {
		headers["Idempotency-Key"] = idempotencyKey;
	}

	const resp = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers,
		body: JSON.stringify(input),
	});

	if (!resp.ok) {
		throw new Error(`Resend API error: ${resp.status} ${await resp.text()}`);
	}
}

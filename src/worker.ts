import { XMLParser } from "fast-xml-parser";
import PostalMime, { type Address, type Email as ParsedEmail } from "postal-mime";

export interface Env {
	ANTHROPIC_API_KEY: string;
	RESEND_API_KEY: string;
	EMAIL_TO: string;
	SUMMARY_FROM: string;
	PROCESSED_EMAILS: KVNamespace;
	RSS_FEEDS: string;
	API_KEY: string;
	PUSHOVER_USER_KEY?: string;
	PUSHOVER_API_TOKEN?: string;
	OPENAI_API_KEY?: string;
	TTS_ENABLED?: string;
	TTS_AUDIO_BUCKET?: R2Bucket;
	TTS_AUDIO_PUBLIC_URL?: string;
}

export interface RssFeedConfig {
	url: string;
	name: string;
}

export interface RssItem {
	title: string;
	link: string;
	guid: string;
	content: string;
	pubDate?: string;
	feedName: string;
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

const RSS_DEDUPE_PREFIX = "rss:";
const EXT_DEDUPE_PREFIX = "ext:";
const RSS_FETCH_TIMEOUT_MS = 10_000;
const RSS_MAX_ITEMS_PER_FEED = 5;

const HEALTH_PATH = "/healthz";
const MAX_SUMMARY_INPUT_CHARS = 80_000;
const DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7;
const NEWSLETTER_SUMMARY_PREFIX = "Newsletter Summary";
const BLOG_POST_SUMMARY_PREFIX = "Blog Post Summary";
const SUMMARY_MODEL = "claude-sonnet-4-6";
const SUMMARY_MAX_OUTPUT_TOKENS = 1024;
const TTS_MODEL = "tts-1";
const TTS_VOICE = "alloy";

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

const QUOTED_REPLY_PATTERNS = [/^\s*on .+ wrote:\s*$/i, /^\s*>+/];

const FORWARDED_MESSAGE_PATTERNS = [
	/^\s*-{2,}\s*forwarded message\s*-{2,}\s*$/i,
	/^\s*begin forwarded message:?$/i,
];

const FORWARDED_HEADER_PATTERNS = [
	/^\s*from:\s+/i,
	/^\s*date:\s+/i,
	/^\s*subject:\s+/i,
	/^\s*to:\s+/i,
	/^\s*cc:\s+/i,
	/^\s*reply-to:\s+/i,
	/^\s*sent:\s+/i,
];

const FORWARDED_SUBJECT_PATTERNS = [/^\s*fwd:\s+/i, /^\s*fw:\s+/i];

const GMAIL_FORWARDING_FROM = "forwarding-noreply@google.com";
const GMAIL_FORWARDING_SUBJECT = /gmail forwarding confirmation/i;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method === "GET" && url.pathname === HEALTH_PATH) {
			return jsonResponse({
				ok: true,
				service: "newsletter-summary-worker",
				ingress: "email-routing",
			});
		}

		if (request.method === "POST" && url.pathname === "/api/save") {
			return handleApiSave(request, env);
		}

		return new Response("Not found", { status: 404 });
	},

	async scheduled(
		_event: ScheduledEvent,
		env: Env,
		ctx: ExecutionContext,
	): Promise<void> {
		ctx.waitUntil(processRssFeeds(env).catch(console.error));
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

async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const keyData = encoder.encode("timing-safe-compare");
	const key = await crypto.subtle.importKey(
		"raw",
		keyData,
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const [macA, macB] = await Promise.all([
		crypto.subtle.sign("HMAC", key, encoder.encode(a)),
		crypto.subtle.sign("HMAC", key, encoder.encode(b)),
	]);
	if (macA.byteLength !== macB.byteLength) return false;
	const viewA = new Uint8Array(macA);
	const viewB = new Uint8Array(macB);
	let diff = 0;
	for (let i = 0; i < viewA.length; i++) {
		diff |= viewA[i] ^ viewB[i];
	}
	return diff === 0;
}

export async function handleApiSave(
	request: Request,
	env: Env,
): Promise<Response> {
	const authHeader = request.headers.get("Authorization") || "";
	const token = authHeader.startsWith("Bearer ")
		? authHeader.slice(7)
		: "";

	if (!token || !env.API_KEY || !(await timingSafeEqual(token, env.API_KEY))) {
		return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
	}

	let body: { url?: string; title?: string; content?: string; siteName?: string };
	try {
		body = await request.json();
	} catch {
		return jsonResponse({ ok: false, error: "Invalid JSON" }, 400);
	}

	if (!body.url || !body.title || !body.content) {
		return jsonResponse(
			{ ok: false, error: "Missing required fields: url, title, content" },
			400,
		);
	}

	const dedupeKey = `${EXT_DEDUPE_PREFIX}${await sha256Hex(body.url)}`;

	if (await hasProcessedEmail(dedupeKey, env.PROCESSED_EMAILS)) {
		return jsonResponse({ ok: true, status: "duplicate" });
	}

	const truncatedContent = body.content.slice(0, MAX_SUMMARY_INPUT_CHARS);
	const sender = body.siteName || new URL(body.url).hostname;

	const summary = await summarizeWithClaude(
		{
			subject: body.title,
			sender,
			content: truncatedContent,
		},
		env.ANTHROPIC_API_KEY,
	);

	await sendSummaryEmail(
		{
			subject: body.title,
			sender,
			summary,
			articleUrl: body.url,
		},
		env,
		dedupeKey,
	);

	await recordProcessedEmail(dedupeKey, env.PROCESSED_EMAILS, {
		status: "sent",
		title: body.title,
		url: body.url,
		source: "extension",
	});

	return jsonResponse({ ok: true, status: "sent" });
}

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

	const summary = await summarizeWithClaude(
		{
			subject: metadata.subject,
			sender: formatSender(metadata),
			content,
		},
		env.ANTHROPIC_API_KEY,
	);

	await sendSummaryEmail(
		{
			subject: metadata.subject,
			sender: formatSender(metadata),
			summary,
		},
		env,
		dedupeKey,
	);

	await recordProcessedEmail(dedupeKey, env.PROCESSED_EMAILS, {
		status: "sent",
		subject: metadata.subject,
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
	const candidates = [metadata.text || "", stripHtml(metadata.html || "")]
		.map((value) => cleanSummaryText(value, metadata.subject))
		.filter(Boolean)
		.sort((left, right) => right.length - left.length);

	return (candidates[0] || "").slice(0, MAX_SUMMARY_INPUT_CHARS);
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

export async function summarizeWithClaude(
	input: {
		subject: string;
		sender: string;
		content: string;
	},
	apiKey: string,
): Promise<string> {
	const resp = await fetch("https://api.anthropic.com/v1/messages", {
		method: "POST",
		headers: {
			"x-api-key": apiKey,
			"anthropic-version": "2023-06-01",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: SUMMARY_MODEL,
			max_tokens: SUMMARY_MAX_OUTPUT_TOKENS,
			system:
				"Summarize the following forwarded newsletter or article email in 3-5 concise prose paragraphs. Write in plain prose with no headers, no labels, and no bullet points.",
			messages: [
				{
					role: "user",
					content: `Email subject: ${input.subject}\nEmail sender: ${input.sender}\n\nEmail content:\n${input.content.slice(0, MAX_SUMMARY_INPUT_CHARS)}`,
				},
			],
		}),
	});

	if (!resp.ok) {
		throw new Error(
			`Anthropic Messages API error: ${resp.status} ${await resp.text()}`,
		);
	}

	const data = (await resp.json()) as {
		content?: { type: string; text?: string }[];
	};
	const summary = data.content
		?.find((block) => block.type === "text")
		?.text?.trim();

	if (!summary) {
		throw new Error("Anthropic Messages API returned no text content");
	}

	return summary;
}

export async function sendSummaryEmail(
	input: {
		subject: string;
		sender: string;
		summary: string;
		articleUrl?: string;
	},
	env: Env,
	dedupeKey: string,
	summaryPrefix: string = NEWSLETTER_SUMMARY_PREFIX,
): Promise<void> {
	let audioUrl: string | undefined;

	if (env.TTS_ENABLED === "true" && env.OPENAI_API_KEY) {
		try {
			const audioBuffer = await generateTtsAudio(
				input.summary,
				env.OPENAI_API_KEY,
			);
			if (env.TTS_AUDIO_BUCKET && env.TTS_AUDIO_PUBLIC_URL) {
				audioUrl = await uploadTtsAudio(
					audioBuffer,
					env.TTS_AUDIO_BUCKET,
					env.TTS_AUDIO_PUBLIC_URL,
				);
			}
		} catch (error) {
			console.error("TTS audio generation failed:", error);
		}
	}

	await sendResendEmail(
		{
			from: formatSummaryFrom(env.SUMMARY_FROM, summaryPrefix),
			to: env.EMAIL_TO,
			subject: `${summaryPrefix}: ${sanitizeSubject(input.subject)}`,
			html: renderSummaryHtml({ ...input, audioUrl }, summaryPrefix),
			text: renderSummaryText({ ...input, audioUrl }),
		},
		env.RESEND_API_KEY,
		dedupeKey,
	);

	if (env.PUSHOVER_USER_KEY && env.PUSHOVER_API_TOKEN) {
		await sendPushoverNotification(
			{
				title: `${summaryPrefix}: ${sanitizeSubject(input.subject)}`,
				message: input.summary.slice(0, 1024),
				url: input.articleUrl,
			},
			env.PUSHOVER_USER_KEY,
			env.PUSHOVER_API_TOKEN,
		).catch((error) => {
			console.error("Pushover notification failed:", error);
		});
	}
}

export async function sendPushoverNotification(
	input: { title: string; message: string; url?: string },
	userKey: string,
	apiToken: string,
): Promise<void> {
	const body: Record<string, string> = {
		token: apiToken,
		user: userKey,
		title: input.title,
		message: input.message,
	};
	if (input.url) {
		body.url = input.url;
	}
	const resp = await fetch("https://api.pushover.net/1/messages.json", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});

	if (!resp.ok) {
		throw new Error(
			`Pushover API error: ${resp.status} ${await resp.text()}`,
		);
	}
}

export async function uploadTtsAudio(
	audioBuffer: ArrayBuffer,
	bucket: R2Bucket,
	publicBaseUrl: string,
): Promise<string> {
	const key = `${Date.now()}-${crypto.randomUUID()}.mp3`;
	await bucket.put(key, audioBuffer, {
		httpMetadata: { contentType: "audio/mpeg" },
	});
	return `${publicBaseUrl.replace(/\/+$/, "")}/${key}`;
}

export async function generateTtsAudio(
	text: string,
	apiKey: string,
): Promise<ArrayBuffer> {
	const resp = await fetch("https://api.openai.com/v1/audio/speech", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			model: TTS_MODEL,
			voice: TTS_VOICE,
			input: text,
			response_format: "mp3",
		}),
	});

	if (!resp.ok) {
		throw new Error(
			`OpenAI TTS API error: ${resp.status} ${await resp.text()}`,
		);
	}

	return resp.arrayBuffer();
}

export function renderSummaryHtml(input: {
	subject: string;
	sender: string;
	summary: string;
	articleUrl?: string;
	audioUrl?: string;
}, summaryPrefix: string = NEWSLETTER_SUMMARY_PREFIX): string {
	const renderParagraphs = (text: string) =>
		text
			.split(/\n\s*\n/)
			.map((paragraph) => paragraph.trim())
			.filter(Boolean)
			.map(
				(paragraph) =>
					`<p style="margin:0 0 16px; line-height:1.7; color:#1f2937;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
			)
			.join("");

	const audioLink = input.audioUrl
		? ` · <a href="${escapeHtml(input.audioUrl)}" style="color:#9a6b2f;">&#x1F3A7; Listen to summary</a>`
		: "";
	const articleLink = input.articleUrl
		? `<p style="margin:0 0 24px; line-height:1.6; color:#4b5563;">From ${escapeHtml(input.sender)} · <a href="${escapeHtml(input.articleUrl)}" style="color:#9a6b2f;">&#x1F517; Read original</a>${audioLink}</p>`
		: `<p style="margin:0 0 24px; line-height:1.6; color:#4b5563;">From ${escapeHtml(input.sender)}${audioLink}</p>`;

	return `<!doctype html>
<html lang="en">
  <body style="margin:0; padding:24px; background:#f4f1ea; font-family: Georgia, 'Times New Roman', serif; color:#111827;">
    <div style="max-width:680px; margin:0 auto; background:#fffdf8; border:1px solid #e5dccf; border-radius:16px; padding:32px;">
      <p style="margin:0 0 12px; font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:#9a6b2f;">${summaryPrefix}</p>
      <h1 style="margin:0 0 12px; font-size:30px; line-height:1.2; color:#111827;">${escapeHtml(input.subject)}</h1>
      ${articleLink}
      ${renderParagraphs(input.summary)}
    </div>
  </body>
</html>`;
}

export function renderSummaryText(input: {
	subject: string;
	sender: string;
	summary: string;
	articleUrl?: string;
	audioUrl?: string;
}): string {
	const header = input.articleUrl
		? `From: ${input.sender} | Link: ${input.articleUrl}`
		: `From: ${input.sender}`;
	const lines = [
		header,
		"---",
		"",
		input.summary.trim(),
	];
	if (input.audioUrl) {
		lines.push("", `Listen: ${input.audioUrl}`);
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

function formatSummaryFrom(summaryFrom: string, summaryPrefix: string = NEWSLETTER_SUMMARY_PREFIX): string {
	return /<.+>/.test(summaryFrom)
		? summaryFrom
		: `${summaryPrefix} <${summaryFrom}>`;
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
			.replace(/<\/(p|div|section|article|li|h[1-6]|tr|table|tbody|thead|blockquote)>/gi, "\n")
			.replace(/<[^>]+>/g, " "),
	);
}

function cleanSummaryText(value: string, subject: string): string {
	const baseText = normalizeText(value);
	if (!baseText) {
		return "";
	}

	const lines = baseText.split("\n");
	const cleaned: string[] = [];

	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();

		if (!trimmed) {
			cleaned.push("");
			continue;
		}

		if (FORWARDED_MESSAGE_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			index = skipForwardedHeaderBlock(lines, index + 1);
			continue;
		}

		if (
			isLikelyForwardedHeaderBlockStart(lines, index, subject, cleaned.length > 0)
		) {
			index = skipForwardedHeaderBlock(lines, index);
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

	return collapseWhitespace(cleaned.join("\n"));
}

function isLikelyForwardedHeaderBlockStart(
	lines: string[],
	startIndex: number,
	subject: string,
	hasCollectedContent: boolean,
): boolean {
	if (
		hasCollectedContent &&
		!FORWARDED_SUBJECT_PATTERNS.some((pattern) => pattern.test(subject))
	) {
		return false;
	}

	let headerCount = 0;

	for (
		let index = startIndex;
		index < lines.length && index < startIndex + 8;
		index += 1
	) {
		const rawLine = lines[index];
		const trimmed = rawLine.trim();

		if (!trimmed) {
			break;
		}

		if (FORWARDED_HEADER_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			headerCount += 1;
			continue;
		}

		if (/^[ \t]+/.test(rawLine) && headerCount > 0) {
			continue;
		}

		break;
	}

	return headerCount >= 2;
}

function skipForwardedHeaderBlock(lines: string[], startIndex: number): number {
	let sawHeader = false;

	for (let index = startIndex; index < lines.length; index += 1) {
		const rawLine = lines[index];
		const trimmed = rawLine.trim();

		if (!trimmed) {
			return sawHeader ? index : startIndex - 1;
		}

		if (FORWARDED_HEADER_PATTERNS.some((pattern) => pattern.test(trimmed))) {
			sawHeader = true;
			continue;
		}

		if (/^[ \t]+/.test(rawLine) && sawHeader) {
			continue;
		}

		return sawHeader ? index - 1 : startIndex - 1;
	}

	return lines.length;
}

function collapseWhitespace(value: string): string {
	return value
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.replace(/[ \t]{2,}/g, " ")
		.trim();
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

export function parseRssFeeds(env: Env): RssFeedConfig[] {
	if (!env.RSS_FEEDS) return [];
	const feeds = JSON.parse(env.RSS_FEEDS) as RssFeedConfig[];
	return feeds.filter((f) => f.url && f.name);
}

export async function fetchFeed(config: RssFeedConfig): Promise<string> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), RSS_FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(config.url, {
			headers: { "User-Agent": "tldr-worker/1.0" },
			signal: controller.signal,
		});
		if (!resp.ok) {
			throw new Error(`Feed fetch failed: ${resp.status} ${config.url}`);
		}
		return await resp.text();
	} finally {
		clearTimeout(timeout);
	}
}

export function parseFeedItems(xml: string, feedName: string): RssItem[] {
	const parser = new XMLParser({
		ignoreAttributes: false,
		trimValues: true,
	});
	const doc = parser.parse(xml);

	const items: RssItem[] = [];

	// RSS 2.0
	const rssItems = doc?.rss?.channel?.item;
	if (rssItems) {
		const list = Array.isArray(rssItems) ? rssItems : [rssItems];
		for (const entry of list.slice(0, RSS_MAX_ITEMS_PER_FEED)) {
			const rawContent =
				entry["content:encoded"] || entry.description || "";
			items.push({
				title: entry.title || "Untitled",
				link: entry.link || "",
				guid: entry.guid?.["#text"] || entry.guid || entry.link || "",
				content: collapseWhitespace(stripHtml(String(rawContent))),
				pubDate: entry.pubDate,
				feedName,
			});
		}
		return items;
	}

	// Atom
	const atomEntries = doc?.feed?.entry;
	if (atomEntries) {
		const list = Array.isArray(atomEntries) ? atomEntries : [atomEntries];
		for (const entry of list.slice(0, RSS_MAX_ITEMS_PER_FEED)) {
			const rawContent =
				entry.content?.["#text"] ||
				entry.content ||
				entry.summary?.["#text"] ||
				entry.summary ||
				"";
			const link =
				(Array.isArray(entry.link)
					? entry.link.find(
							(l: Record<string, string>) =>
								l["@_rel"] === "alternate" || !l["@_rel"],
						)?.["@_href"]
					: entry.link?.["@_href"]) || "";
			items.push({
				title: entry.title?.["#text"] || entry.title || "Untitled",
				link,
				guid: entry.id || link || "",
				content: collapseWhitespace(stripHtml(String(rawContent))),
				pubDate: entry.published || entry.updated,
				feedName,
			});
		}
	}

	return items;
}

export async function createRssDedupeKey(item: RssItem): Promise<string> {
	return `${RSS_DEDUPE_PREFIX}${await sha256Hex(item.guid || item.link)}`;
}

export async function processRssFeeds(env: Env): Promise<void> {
	const feeds = parseRssFeeds(env);
	if (feeds.length === 0) return;

	for (const feedConfig of feeds) {
		try {
			const xml = await fetchFeed(feedConfig);
			const items = parseFeedItems(xml, feedConfig.name);

			for (const item of items) {
				if (!item.content) continue;

				const dedupeKey = await createRssDedupeKey(item);
				if (await hasProcessedEmail(dedupeKey, env.PROCESSED_EMAILS)) {
					console.log("Skipping already-processed RSS item", {
						title: item.title,
						feed: item.feedName,
					});
					continue;
				}

				const summary = await summarizeWithClaude(
					{
						subject: item.title,
						sender: item.feedName,
						content: item.content,
					},
					env.ANTHROPIC_API_KEY,
				);

				await sendSummaryEmail(
					{
						subject: item.title,
						sender: item.feedName,
						summary,
						articleUrl: item.link,
					},
					env,
					dedupeKey,
					BLOG_POST_SUMMARY_PREFIX,
				);

				await recordProcessedEmail(dedupeKey, env.PROCESSED_EMAILS, {
					status: "sent",
					title: item.title,
					feed: item.feedName,
				});
			}
		} catch (error) {
			console.error(`Error processing feed ${feedConfig.name}:`, error);
		}
	}
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

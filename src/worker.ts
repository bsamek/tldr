interface Env {
	READWISE_TOKEN: string;
	READWISE_WEBHOOK_SECRET: string;
	ANTHROPIC_API_KEY: string;
	RESEND_API_KEY: string;
	EMAIL_TO: string;
	ARCHIVE_LINK_SECRET: string;
}

type ReaderLocation = "new" | "later" | "archive" | "feed" | "shortlist" | "inbox";
type ActionableLocation = "later" | "archive";

interface WebhookPayload {
	id: string;
	title: string;
	url: string;
	source_url: string;
	location: ReaderLocation;
	category: string;
	author: string;
	event_type?: string;
	summary?: string;
	secret?: string;
}

interface ReaderDocument {
	id: string;
	title: string;
	url: string;
	source_url: string;
	content: string;
	html_content: string;
	summary: string;
	author: string;
	location?: ReaderLocation;
}

interface DocumentUpdateResult {
	success: boolean;
	alreadyInLocation?: boolean;
	status?: number;
	body?: string;
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/webhook") {
			if (request.method !== "POST") {
				return new Response("Method not allowed", { status: 405 });
			}

			return handleWebhook(request, env);
		}

		if (url.pathname === "/archive" || url.pathname === "/later") {
			if (request.method !== "GET") {
				return new Response("Method not allowed", { status: 405 });
			}

			return handleDocumentAction(
				url,
				env,
				url.pathname === "/later" ? "later" : "archive",
			);
		}

		return new Response("Not found", { status: 404 });
	},
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
	try {
		let payload: WebhookPayload;
		try {
			payload = (await request.json()) as WebhookPayload;
		} catch {
			return new Response("OK", { status: 200 });
		}

		if (
			!payload.secret ||
			!constantTimeEqual(payload.secret, env.READWISE_WEBHOOK_SECRET)
		) {
			console.warn("Webhook rejected: invalid secret", payload.id);
			return new Response("Forbidden", { status: 403 });
		}

		const { secret: _ignoredSecret, ...loggablePayload } = payload;
		console.log("Webhook payload:", JSON.stringify(loggablePayload));

		if (!shouldSummarizeInboxDocument(payload)) {
			return new Response("Ignored: not an inbox document", { status: 200 });
		}

		const article = await fetchArticle(payload.id, env.READWISE_TOKEN);
		const content =
			article?.content || article?.html_content || article?.summary || payload.summary || "";
		if (!content) {
			return new Response("No content to summarize", { status: 200 });
		}

		const title = article?.title || payload.title;
		const readerUrl = article?.url || payload.url || payload.source_url;
		const summary = await summarize(title, content, env.ANTHROPIC_API_KEY);

		await sendEmail(payload.id, title, readerUrl, summary, request.url, env);

		return new Response("OK", { status: 200 });
	} catch (err) {
		console.error("Webhook processing failed:", err);
		return new Response("Internal error", { status: 500 });
	}
}

async function handleDocumentAction(
	url: URL,
	env: Env,
	targetLocation: ActionableLocation,
): Promise<Response> {
	const documentId = url.searchParams.get("id");
	const signature = url.searchParams.get("sig");

	if (!documentId || !signature) {
		return htmlResponse(
			renderResultPage({
				title: `Invalid ${getActionLabel(targetLocation)} link`,
				message: `This ${getActionLabel(targetLocation).toLowerCase()} link is missing required information.`,
			}),
			400,
		);
	}

	const expectedSignature = await createActionSignature(
		documentId,
		env.ARCHIVE_LINK_SECRET,
	);
	if (!constantTimeEqual(expectedSignature, signature)) {
		console.warn("Document action rejected: invalid signature", {
			documentId,
			targetLocation,
		});
		return htmlResponse(
			renderResultPage({
				title: `Invalid ${getActionLabel(targetLocation)} link`,
				message: `This ${getActionLabel(targetLocation).toLowerCase()} link could not be verified.`,
			}),
			403,
		);
	}

	const result = await updateArticleLocation(
		documentId,
		env.READWISE_TOKEN,
		targetLocation,
	);
	if (result.success) {
		const labels = getActionResultCopy(
			targetLocation,
			Boolean(result.alreadyInLocation),
		);
		return htmlResponse(
			renderResultPage({
				title: labels.title,
				message: labels.message,
			}),
		);
	}

	console.error(
		"Document action failed:",
		JSON.stringify({
			documentId,
			targetLocation,
			status: result.status,
			body: result.body,
		}),
	);
	return htmlResponse(
		renderResultPage({
			title: `${getActionLabel(targetLocation)} failed`,
			message: `Readwise Reader did not accept the ${getActionLabel(targetLocation).toLowerCase()} request. Try again from the email later.`,
		}),
		502,
	);
}

async function fetchArticle(id: string, token: string): Promise<ReaderDocument | null> {
	const resp = await fetch(`https://readwise.io/api/v3/list/?id=${encodeURIComponent(id)}`, {
		headers: { Authorization: `Token ${token}` },
	});

	if (!resp.ok) {
		console.error(`Reader API error: ${resp.status} ${await resp.text()}`);
		return null;
	}

	const data = (await resp.json()) as { results: ReaderDocument[] };
	return data.results?.[0] ?? null;
}

async function updateArticleLocation(
	id: string,
	token: string,
	targetLocation: ActionableLocation,
): Promise<DocumentUpdateResult> {
	const resp = await fetch(
		`https://readwise.io/api/v3/update/${encodeURIComponent(id)}/`,
		{
			method: "PATCH",
			headers: {
				Authorization: `Token ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ location: targetLocation }),
		},
	);

	if (resp.ok) {
		return { success: true };
	}

	const body = await resp.text();
	const article = await fetchArticle(id, token);
	if (normalizeLocation(article?.location) === targetLocation) {
		return { success: true, alreadyInLocation: true };
	}

	return {
		success: false,
		status: resp.status,
		body,
	};
}

async function summarize(title: string, content: string, apiKey: string): Promise<string> {
	// Truncate to ~80k chars to stay within token limits
	const truncated = content.slice(0, 80_000);

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
					content: `Summarize the following article in 3-5 concise prose paragraphs. Write in plain prose — no headers, no bold labels, no bullet points. Just flowing paragraphs.

Article title: ${title}

Article content:
${truncated}`,
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
	return data.content[0].text;
}

async function sendEmail(
	documentId: string,
	title: string,
	articleUrl: string,
	summary: string,
	requestUrl: string,
	env: Env,
) {
	const laterUrl = await buildActionUrl(
		"/later",
		requestUrl,
		documentId,
		env.ARCHIVE_LINK_SECRET,
	);
	const archiveUrl = await buildActionUrl(
		"/archive",
		requestUrl,
		documentId,
		env.ARCHIVE_LINK_SECRET,
	);
	const resp = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: "Readwise Summary <summary@resend.dev>",
			to: env.EMAIL_TO,
			subject: `Inbox Summary: ${title}`,
			html: renderEmailHtml(title, summary, articleUrl, laterUrl, archiveUrl),
			text: `${summary}\n\n---\nAdd to Later: ${laterUrl}\nArchive in Readwise: ${archiveUrl}\nRead the full article: ${articleUrl}`,
		}),
	});

	if (!resp.ok) {
		throw new Error(`Resend API error: ${resp.status} ${await resp.text()}`);
	}
}

async function buildActionUrl(
	pathname: "/later" | "/archive",
	requestUrl: string,
	documentId: string,
	secret: string,
): Promise<string> {
	const actionUrl = new URL(pathname, requestUrl);
	actionUrl.searchParams.set("id", documentId);
	actionUrl.searchParams.set(
		"sig",
		await createActionSignature(documentId, secret),
	);
	return actionUrl.toString();
}

async function createActionSignature(
	documentId: string,
	secret: string,
): Promise<string> {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(documentId),
	);
	return encodeBase64Url(new Uint8Array(signature));
}

function encodeBase64Url(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
	if (left.length !== right.length) {
		return false;
	}

	let mismatch = 0;
	for (let i = 0; i < left.length; i += 1) {
		mismatch |= left.charCodeAt(i) ^ right.charCodeAt(i);
	}

	return mismatch === 0;
}

function renderEmailHtml(
	title: string,
	summary: string,
	articleUrl: string,
	laterUrl: string,
	archiveUrl: string,
): string {
	const escapedTitle = escapeHtml(title);
	const escapedArticleUrl = escapeHtml(articleUrl);
	const escapedLaterUrl = escapeHtml(laterUrl);
	const escapedArchiveUrl = escapeHtml(archiveUrl);
	const summaryParagraphs = summary
		.split(/\n\s*\n/)
		.map((paragraph) => paragraph.trim())
		.filter(Boolean)
		.map(
			(paragraph) =>
				`<p style="margin:0 0 16px; line-height:1.7; color:#1f2937;">${escapeHtml(paragraph).replace(/\n/g, "<br>")}</p>`,
		)
		.join("");

	return `<!doctype html>
<html lang="en">
  <body style="margin:0; padding:24px; background:#f4f1ea; font-family: Georgia, 'Times New Roman', serif; color:#111827;">
    <div style="max-width:680px; margin:0 auto; background:#fffdf8; border:1px solid #e5dccf; border-radius:16px; padding:32px;">
      <p style="margin:0 0 12px; font-size:12px; letter-spacing:0.12em; text-transform:uppercase; color:#9a6b2f;">Readwise Inbox Summary</p>
      <h1 style="margin:0 0 24px; font-size:30px; line-height:1.2; color:#111827;">${escapedTitle}</h1>
      ${summaryParagraphs}
      <p style="margin:0 0 24px; line-height:1.7; color:#4b5563;">This story is still in your Reader Inbox. Save it to Later if you want to read it, or archive it if the summary was enough.</p>
      <div style="margin:32px 0 20px;">
        <a href="${escapedLaterUrl}" style="display:inline-block; margin:0 12px 12px 0; background:#0f4c81; color:#fffdf8; text-decoration:none; font-weight:700; padding:14px 20px; border-radius:999px;">Add to Later</a>
        <a href="${escapedArchiveUrl}" style="display:inline-block; margin:0 12px 12px 0; background:#a34f1a; color:#fffdf8; text-decoration:none; font-weight:700; padding:14px 20px; border-radius:999px;">Archive in Readwise</a>
      </div>
      <p style="margin:0; line-height:1.6; color:#4b5563;">
        <a href="${escapedArticleUrl}" style="color:#0f4c81;">Read the full article</a>
      </p>
    </div>
  </body>
</html>`;
}

function renderResultPage({
	title,
	message,
}: {
	title: string;
	message: string;
}): string {
	return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
  </head>
  <body style="margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center; background:linear-gradient(135deg, #f4f1ea 0%, #ede5d6 100%); padding:24px; font-family: Georgia, 'Times New Roman', serif; color:#1f2937;">
    <main style="max-width:560px; background:#fffdf8; border:1px solid #e5dccf; border-radius:18px; padding:32px; box-shadow:0 18px 45px rgba(91, 57, 24, 0.12);">
      <p style="margin:0 0 12px; font-size:12px; letter-spacing:0.14em; text-transform:uppercase; color:#9a6b2f;">Readwise Reader</p>
      <h1 style="margin:0 0 16px; font-size:32px; line-height:1.2;">${escapeHtml(title)}</h1>
      <p style="margin:0; line-height:1.7; color:#4b5563;">${escapeHtml(message)}</p>
    </main>
  </body>
</html>`;
}

function htmlResponse(html: string, status = 200): Response {
	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
		},
	});
}

function shouldSummarizeInboxDocument(payload: WebhookPayload): boolean {
	return isInboxLocation(payload.location) || payload.event_type === "reader.document.moved_to_inbox";
}

function isInboxLocation(location?: ReaderLocation): boolean {
	// Readwise labels Inbox documents as "new" in API and webhook payloads.
	return normalizeLocation(location) === "new";
}

function normalizeLocation(location?: ReaderLocation): ReaderLocation | "" {
	if (!location) {
		return "";
	}

	return location === "inbox" ? "new" : location;
}

function getActionLabel(targetLocation: ActionableLocation): string {
	return targetLocation === "later" ? "Add to Later" : "Archive";
}

function getActionResultCopy(
	targetLocation: ActionableLocation,
	alreadyInLocation: boolean,
): { title: string; message: string } {
	if (targetLocation === "later") {
		return alreadyInLocation
			? {
					title: "Already in Later",
					message: "This story was already in your Readwise Reader Later list.",
				}
			: {
					title: "Saved to Later",
					message: "This story is now in your Readwise Reader Later list.",
				};
	}

	return alreadyInLocation
		? {
				title: "Already archived",
				message: "This story was already archived in Readwise Reader.",
			}
		: {
				title: "Story archived",
				message: "This story has been archived in Readwise Reader.",
			};
}

function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

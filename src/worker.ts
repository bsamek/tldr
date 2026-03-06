interface Env {
	READWISE_TOKEN: string;
	ANTHROPIC_API_KEY: string;
	RESEND_API_KEY: string;
	EMAIL_TO: string;
}

interface WebhookPayload {
	id: string;
	title: string;
	url: string;
	source_url: string;
	location: string;
	category: string;
	author: string;
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
}

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);

		if (request.method !== "POST") {
			return new Response("Method not allowed", { status: 405 });
		}

		if (url.pathname !== "/webhook") {
			return new Response("Not found", { status: 404 });
		}

		try {
			let payload: WebhookPayload;
			try {
				payload = (await request.json()) as WebhookPayload;
			} catch {
				return new Response("OK", { status: 200 });
			}

			console.log("Webhook payload:", JSON.stringify(payload));

			if (payload.location !== "later") {
				return new Response("Ignored: not a 'later' document", { status: 200 });
			}

			// Fetch full article content from Reader API
			const article = await fetchArticle(payload.id, env.READWISE_TOKEN);

			const content =
				article?.content || article?.html_content || (payload as any).summary || "";
			if (!content) {
				return new Response("No content to summarize", { status: 200 });
			}

			const title = article?.title || payload.title;
			const readerUrl = payload.url;

			// Summarize with Claude
			const summary = await summarize(title, content, env.ANTHROPIC_API_KEY);

			// Email the summary
			await sendEmail(title, readerUrl, summary, env);

			return new Response("OK", { status: 200 });
		} catch (err) {
			console.error("Webhook processing failed:", err);
			return new Response("Internal error", { status: 500 });
		}
	},
};

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

async function sendEmail(title: string, articleUrl: string, summary: string, env: Env) {
	const resp = await fetch("https://api.resend.com/emails", {
		method: "POST",
		headers: {
			Authorization: `Bearer ${env.RESEND_API_KEY}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			from: "Readwise Summary <summary@resend.dev>",
			to: env.EMAIL_TO,
			subject: `Summary: ${title}`,
			text: `${summary}\n\n---\nRead the full article: ${articleUrl}`,
		}),
	});

	if (!resp.ok) {
		throw new Error(`Resend API error: ${resp.status} ${await resp.text()}`);
	}
}

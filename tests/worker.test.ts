import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	createRssDedupeKey,
	extractSummaryContent,
	handleApiSave,
	handleGmailForwardingConfirmation,
	isGmailForwardingConfirmation,
	parseFeedItems,
	processIncomingEmail,
	processRssFeeds,
	type EmailMetadata,
	type Env,
	type RssItem,
} from "../src/worker";

class MemoryKVNamespace {
	private readonly store = new Map<string, string>();

	async get(key: string): Promise<string | null> {
		return this.store.get(key) ?? null;
	}

	async put(key: string, value: string): Promise<void> {
		this.store.set(key, value);
	}
}

function createRawEmail(overrides?: {
	subject?: string;
	messageId?: string;
	html?: string;
	from?: string;
	date?: string;
}): string {
	const subject = overrides?.subject || "Monday Briefing";
	const messageId = overrides?.messageId || "<newsletter-1@example.com>";
	const from = overrides?.from || "Example Writer <author@example.com>";
	const date = overrides?.date || "Sun, 08 Mar 2026 09:00:00 -0400";
	const html =
		overrides?.html ||
		`<html><body><p>Today we looked at how companies rethink pricing.</p><p><a href="https://click.example.net/track?url=https%3A%2F%2Fexample.com%2Fstory">Read story</a></p><p>Unsubscribe</p></body></html>`;

	return [
		`From: ${from}`,
		"To: newsletters@example.com",
		`Subject: ${subject}`,
		`Message-ID: ${messageId}`,
		`Date: ${date}`,
		"MIME-Version: 1.0",
		'Content-Type: text/html; charset="UTF-8"',
		"",
		html,
	].join("\r\n");
}

function createForwardableEmailMessage(rawEmail: string): ForwardableEmailMessage {
	const encoder = new TextEncoder();
	const bytes = encoder.encode(rawEmail);
	const headers = new Headers();

	for (const line of rawEmail.split(/\r?\n/)) {
		if (!line.trim()) {
			break;
		}

		const separator = line.indexOf(":");
		if (separator === -1) {
			continue;
		}

		headers.append(
			line.slice(0, separator),
			line.slice(separator + 1).trim(),
		);
	}

	return {
		from: "gmail-forwarder@example.com",
		to: "newsletters@example.com",
		raw: new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(bytes);
				controller.close();
			},
		}),
		headers,
		rawSize: bytes.byteLength,
		setReject: vi.fn(),
		forward: vi.fn(async () => ({ messageId: "forwarded" })),
		reply: vi.fn(async () => ({ messageId: "replied" })),
	};
}

function createEnv(overrides?: Partial<Env>): Env {
	return {
		OPENAI_API_KEY: "openai-test-key",
		ANTHROPIC_API_KEY: "anthropic-test-key",
		RESEND_API_KEY: "resend-test-key",
		EMAIL_TO: "me@example.com",
		SUMMARY_FROM: "summary@example.com",
		PROCESSED_EMAILS: new MemoryKVNamespace() as unknown as KVNamespace,
		RSS_FEEDS: "[]",
		API_KEY: "test-api-key-1234",
		...overrides,
	};
}

function createSaveRequest(
	body: Record<string, unknown>,
	token?: string,
): Request {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token !== undefined) {
		headers["Authorization"] = `Bearer ${token}`;
	}
	return new Request("https://worker.example.com/api/save", {
		method: "POST",
		headers,
		body: JSON.stringify(body),
	});
}

describe("email content extraction", () => {
	it("removes boilerplate and quoted replies", () => {
		const metadata: EmailMetadata = {
			messageId: "<1@example.com>",
			subject: "Daily Note",
			fromName: "Author",
			fromAddress: "author@example.com",
			text: [
				"Main point of the newsletter.",
				"",
				"Second paragraph with more detail.",
				"",
				"View in browser",
				"",
				"Unsubscribe",
				"",
				"On Tue, someone wrote:",
				"> quoted content",
			].join("\n"),
		};

		expect(extractSummaryContent(metadata)).toBe(
			"Main point of the newsletter.\n\nSecond paragraph with more detail.",
		);
	});

	it("returns empty string when content is only boilerplate", () => {
		const metadata: EmailMetadata = {
			messageId: "<2@example.com>",
			subject: "Boilerplate",
			fromName: "Author",
			fromAddress: "author@example.com",
			text: ["View in browser", "", "Unsubscribe"].join("\n"),
		};

		expect(extractSummaryContent(metadata)).toBe("");
	});

	it("skips forwarded headers and keeps the forwarded body", () => {
		const metadata: EmailMetadata = {
			messageId: "<3@example.com>",
			subject: "Fwd: Japan can be America's arsenal",
			fromName: "Brian Samek",
			fromAddress: "brian@example.com",
			text: [
				"---------- Forwarded message ---------",
				"From: Example Writer <author@example.com>",
				"Date: Sun, 8 Mar 2026 09:00:00 -0400",
				"Subject: Japan can be America's arsenal",
				"To: Brian Samek <brian@example.com>",
				"",
				"Japan's factories could help absorb allied defense demand.",
				"",
				"That depends on production scale, export policy, and coordination.",
				"",
				"Unsubscribe",
			].join("\n"),
		};

		expect(extractSummaryContent(metadata)).toBe(
			"Japan's factories could help absorb allied defense demand.\n\nThat depends on production scale, export policy, and coordination.",
		);
	});

	it("prefers richer HTML content when the text part is sparse", () => {
		const metadata: EmailMetadata = {
			messageId: "<4@example.com>",
			subject: "Fwd: Japan can be America's arsenal",
			fromName: "Brian Samek",
			fromAddress: "brian@example.com",
			text: [
				"---------- Forwarded message ---------",
				"From: Example Writer <author@example.com>",
				"Subject: Japan can be America's arsenal",
				"",
				"https://example.com/story",
			].join("\n"),
			html: [
				"<table>",
				"<tr><td>From:</td><td>Example Writer &lt;author@example.com&gt;</td></tr>",
				"<tr><td>Subject:</td><td>Japan can be America's arsenal</td></tr>",
				"</table>",
				"<p>Japan's factories could help absorb allied defense demand.</p>",
				"<p>That depends on production scale, export policy, and coordination.</p>",
				"<p>Unsubscribe</p>",
			].join(""),
		};

		const content = extractSummaryContent(metadata);

		expect(content).toContain(
			"Japan's factories could help absorb allied defense demand.",
		);
		expect(content).toContain(
			"That depends on production scale, export policy, and coordination.",
		);
		expect(content).not.toContain("From:");
		expect(content).not.toContain("Subject:");
	});
});

describe("gmail forwarding detection", () => {
	it("recognizes gmail forwarding confirmation messages", () => {
		const headers = new Headers({
			From: "Gmail Team <forwarding-noreply@google.com>",
			Subject: "Gmail Forwarding Confirmation - Receive Mail from another address",
		});

		expect(isGmailForwardingConfirmation(headers)).toBe(true);
	});

	it("falls back to Resend when native forwarding fails", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);

		fetchMock.mockResolvedValue(
			new Response(JSON.stringify({ id: "email_123" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);

		const message = createForwardableEmailMessage(
			createRawEmail({
				from: "Gmail Team <forwarding-noreply@google.com>",
				subject: "Gmail Forwarding Confirmation - Receive Mail from another address",
				html: `<p>Click this link to confirm forwarding:</p><p><a href="https://mail-settings.google.com/mail/vf-confirm?token=abc">Confirm</a></p>`,
			}),
		);
		message.forward = vi.fn(async () => {
			throw new Error("forward failed");
		});

		await handleGmailForwardingConfirmation(message, createEnv());

		expect(message.forward).toHaveBeenCalledWith("me@example.com");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [url, init] = fetchMock.mock.calls[0];
		expect(url).toBe("https://api.resend.com/emails");
		expect(init?.method).toBe("POST");
		expect(init?.body).toEqual(
			expect.stringContaining("Gmail Forwarding Confirmation"),
		);
		expect(init?.body).toEqual(
			expect.stringContaining("mail-settings.google.com"),
		);
	});
});

describe("dedupe processing", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("processes the same email only once", async () => {
		fetchMock.mockImplementation(async (input) => {
			if (typeof input === "string" && input.includes("api.openai.com")) {
				return new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								content: [
									{ type: "output_text", text: "A concise summary." },
								],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (typeof input === "string" && input.includes("api.anthropic.com")) {
				return new Response(
					JSON.stringify({
						content: [{ type: "text", text: "A Claude summary." }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}

			if (typeof input === "string" && input.includes("resend.com")) {
				return new Response(JSON.stringify({ id: "email_123" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}

			throw new Error(`Unexpected fetch call: ${String(input)}`);
		});

		const env = createEnv();
		const rawEmail = createRawEmail();
		const messageOne = createForwardableEmailMessage(rawEmail);
		const messageTwo = createForwardableEmailMessage(rawEmail);

		await processIncomingEmail(messageOne, env);
		await processIncomingEmail(messageTwo, env);

		// OpenAI + Anthropic + Resend = 3 calls (second email is deduped)
		expect(fetchMock).toHaveBeenCalledTimes(3);

		const resendCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("resend.com"),
		);
		expect(resendCall).toBeTruthy();
		expect(resendCall?.[1]?.headers).toMatchObject({
			"Idempotency-Key": expect.stringMatching(/^email:[a-f0-9]{64}$/),
		});

		const openAiCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("api.openai.com"),
		);
		expect(openAiCall).toBeTruthy();
		expect(openAiCall?.[1]?.body).toEqual(
			expect.stringContaining('"model":"gpt-5.4"'),
		);

		const anthropicCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("api.anthropic.com"),
		);
		expect(anthropicCall).toBeTruthy();
		expect(anthropicCall?.[1]?.body).toEqual(
			expect.stringContaining('"model":"claude-sonnet-4-6"'),
		);
	});
});

describe("RSS feed parsing", () => {
	it("parses RSS 2.0 items", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Test Blog</title>
    <item>
      <title>First Post</title>
      <link>https://example.com/first</link>
      <guid>https://example.com/first</guid>
      <description>Short description of the first post.</description>
      <pubDate>Mon, 09 Mar 2026 10:00:00 GMT</pubDate>
    </item>
    <item>
      <title>Second Post</title>
      <link>https://example.com/second</link>
      <guid>https://example.com/second</guid>
      <description>Short description of the second post.</description>
    </item>
  </channel>
</rss>`;

		const items = parseFeedItems(xml, "Test Blog");
		expect(items).toHaveLength(2);
		expect(items[0].title).toBe("First Post");
		expect(items[0].link).toBe("https://example.com/first");
		expect(items[0].content).toContain("Short description of the first post.");
		expect(items[0].feedName).toBe("Test Blog");
		expect(items[1].title).toBe("Second Post");
	});

	it("parses Atom feed entries", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom Blog</title>
  <entry>
    <title>Atom Post</title>
    <link rel="alternate" href="https://example.com/atom-post" />
    <id>tag:example.com,2026:atom-post</id>
    <summary>Summary of the atom post.</summary>
    <published>2026-03-09T10:00:00Z</published>
  </entry>
</feed>`;

		const items = parseFeedItems(xml, "Atom Blog");
		expect(items).toHaveLength(1);
		expect(items[0].title).toBe("Atom Post");
		expect(items[0].link).toBe("https://example.com/atom-post");
		expect(items[0].guid).toBe("tag:example.com,2026:atom-post");
		expect(items[0].content).toContain("Summary of the atom post.");
		expect(items[0].feedName).toBe("Atom Blog");
	});

	it("prefers content:encoded over description", () => {
		const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <item>
      <title>Rich Post</title>
      <link>https://example.com/rich</link>
      <description>Short teaser.</description>
      <content:encoded><![CDATA[<p>Full rich content of the post with <strong>HTML</strong>.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

		const items = parseFeedItems(xml, "Blog");
		expect(items).toHaveLength(1);
		expect(items[0].content).toContain("Full rich content of the post");
		expect(items[0].content).not.toContain("Short teaser");
	});

	it("caps items at RSS_MAX_ITEMS_PER_FEED (5)", () => {
		const itemsXml = Array.from({ length: 10 }, (_, i) =>
			`<item><title>Post ${i}</title><link>https://example.com/${i}</link><description>Content ${i}</description></item>`
		).join("\n");

		const xml = `<?xml version="1.0"?><rss version="2.0"><channel>${itemsXml}</channel></rss>`;
		const items = parseFeedItems(xml, "Blog");
		expect(items).toHaveLength(5);
	});
});

describe("RSS dedup key", () => {
	it("uses rss: prefix", async () => {
		const item: RssItem = {
			title: "Test",
			link: "https://example.com/test",
			guid: "https://example.com/test",
			content: "Content",
			feedName: "Blog",
		};
		const key = await createRssDedupeKey(item);
		expect(key).toMatch(/^rss:[a-f0-9]{64}$/);
	});
});

describe("RSS feed processing", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("skips already-processed items", async () => {
		const feedXml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>Old Post</title>
    <link>https://example.com/old</link>
    <description>Already seen content.</description>
  </item>
</channel></rss>`;

		fetchMock.mockImplementation(async (input) => {
			if (typeof input === "string" && input.includes("example.com/feed")) {
				return new Response(feedXml, { status: 200 });
			}
			throw new Error(`Unexpected fetch: ${String(input)}`);
		});

		const env = createEnv({
			RSS_FEEDS: JSON.stringify([{ url: "https://example.com/feed.xml", name: "Blog" }]),
		});

		// Pre-populate the dedup key
		const item: RssItem = {
			title: "Old Post",
			link: "https://example.com/old",
			guid: "https://example.com/old",
			content: "Already seen content.",
			feedName: "Blog",
		};
		const key = await createRssDedupeKey(item);
		await env.PROCESSED_EMAILS.put(key, JSON.stringify({ status: "sent" }));

		await processRssFeeds(env);

		// Should only have fetched the feed itself, not called OpenAI or Resend
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("gracefully handles empty feed list", async () => {
		const env = createEnv({ RSS_FEEDS: "[]" });
		await processRssFeeds(env);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("processes new RSS items end-to-end", async () => {
		const feedXml = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title>New Post</title>
    <link>https://example.com/new</link>
    <description>Fresh content to summarize.</description>
  </item>
</channel></rss>`;

		fetchMock.mockImplementation(async (input) => {
			if (typeof input === "string" && input.includes("example.com/feed")) {
				return new Response(feedXml, { status: 200 });
			}
			if (typeof input === "string" && input.includes("api.openai.com")) {
				return new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "A summary of the new post." }],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (typeof input === "string" && input.includes("api.anthropic.com")) {
				return new Response(
					JSON.stringify({
						content: [{ type: "text", text: "A Claude summary of the new post." }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (typeof input === "string" && input.includes("resend.com")) {
				return new Response(JSON.stringify({ id: "email_rss" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch: ${String(input)}`);
		});

		const env = createEnv({
			RSS_FEEDS: JSON.stringify([{ url: "https://example.com/feed.xml", name: "Test Blog" }]),
		});

		await processRssFeeds(env);

		// Feed fetch + OpenAI + Anthropic + Resend = 4 calls
		expect(fetchMock).toHaveBeenCalledTimes(4);

		const resendCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("resend.com"),
		);
		expect(resendCall).toBeTruthy();
		const body = JSON.parse(resendCall![1]!.body as string);
		expect(body.subject).toContain("New Post");
	});
});

describe("POST /api/save", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("returns 401 when Authorization header is missing", async () => {
		const env = createEnv();
		const req = new Request("https://worker.example.com/api/save", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ url: "https://example.com", title: "Test", content: "Body" }),
		});

		const resp = await handleApiSave(req, env);
		expect(resp.status).toBe(401);
		const data = await resp.json();
		expect(data).toMatchObject({ ok: false, error: "Unauthorized" });
	});

	it("returns 401 when API key is wrong", async () => {
		const env = createEnv();
		const req = createSaveRequest(
			{ url: "https://example.com", title: "Test", content: "Body" },
			"wrong-key",
		);

		const resp = await handleApiSave(req, env);
		expect(resp.status).toBe(401);
	});

	it("returns 400 when required fields are missing", async () => {
		const env = createEnv();
		const req = createSaveRequest(
			{ url: "https://example.com", title: "Test" },
			"test-api-key-1234",
		);

		const resp = await handleApiSave(req, env);
		expect(resp.status).toBe(400);
		const data = await resp.json();
		expect(data.error).toContain("Missing required fields");
	});

	it("returns duplicate on second save of same URL", async () => {
		fetchMock.mockImplementation(async (input) => {
			if (typeof input === "string" && input.includes("api.openai.com")) {
				return new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "A summary." }],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (typeof input === "string" && input.includes("api.anthropic.com")) {
				return new Response(
					JSON.stringify({
						content: [{ type: "text", text: "A Claude summary." }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (typeof input === "string" && input.includes("resend.com")) {
				return new Response(JSON.stringify({ id: "email_ext" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch: ${String(input)}`);
		});

		const env = createEnv();
		const payload = {
			url: "https://example.com/article",
			title: "Great Article",
			content: "Full article text here.",
			siteName: "Example Blog",
		};

		const resp1 = await handleApiSave(
			createSaveRequest(payload, "test-api-key-1234"),
			env,
		);
		expect(resp1.status).toBe(200);
		const data1 = await resp1.json();
		expect(data1).toMatchObject({ ok: true, status: "sent" });

		const resp2 = await handleApiSave(
			createSaveRequest(payload, "test-api-key-1234"),
			env,
		);
		expect(resp2.status).toBe(200);
		const data2 = await resp2.json();
		expect(data2).toMatchObject({ ok: true, status: "duplicate" });

		// Only one OpenAI + Anthropic + Resend call set
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("calls OpenAI, Anthropic, and Resend with correct content", async () => {
		fetchMock.mockImplementation(async (input) => {
			if (typeof input === "string" && input.includes("api.openai.com")) {
				return new Response(
					JSON.stringify({
						output: [
							{
								type: "message",
								content: [{ type: "output_text", text: "GPT summary of the article." }],
							},
						],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (typeof input === "string" && input.includes("api.anthropic.com")) {
				return new Response(
					JSON.stringify({
						content: [{ type: "text", text: "Claude summary of the article." }],
					}),
					{ status: 200, headers: { "Content-Type": "application/json" } },
				);
			}
			if (typeof input === "string" && input.includes("resend.com")) {
				return new Response(JSON.stringify({ id: "email_ext_2" }), {
					status: 200,
					headers: { "Content-Type": "application/json" },
				});
			}
			throw new Error(`Unexpected fetch: ${String(input)}`);
		});

		const env = createEnv();
		const req = createSaveRequest(
			{
				url: "https://example.com/paywalled",
				title: "Paywalled Article",
				content: "The full paywalled content extracted from browser.",
				siteName: "Premium News",
			},
			"test-api-key-1234",
		);

		const resp = await handleApiSave(req, env);
		expect(resp.status).toBe(200);

		const openAiCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("api.openai.com"),
		);
		expect(openAiCall).toBeTruthy();
		const openAiBody = JSON.parse(openAiCall![1]!.body as string);
		expect(openAiBody.input[0].content[0].text).toContain("Paywalled Article");
		expect(openAiBody.input[0].content[0].text).toContain("Premium News");

		const anthropicCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("api.anthropic.com"),
		);
		expect(anthropicCall).toBeTruthy();
		const anthropicBody = JSON.parse(anthropicCall![1]!.body as string);
		expect(anthropicBody.messages[0].content).toContain("Paywalled Article");
		expect(anthropicBody.messages[0].content).toContain("Premium News");

		const resendCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("resend.com"),
		);
		expect(resendCall).toBeTruthy();
		const resendBody = JSON.parse(resendCall![1]!.body as string);
		expect(resendBody.subject).toContain("Paywalled Article");
		expect(resendBody.to).toBe("me@example.com");
		expect(resendBody.html).toContain("GPT-5.4");
		expect(resendBody.html).toContain("Sonnet 4.6");
	});
});

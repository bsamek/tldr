import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	extractOriginalArticleUrl,
	extractSummaryContent,
	isGmailForwardingConfirmation,
	processIncomingEmail,
	type EmailMetadata,
	type Env,
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
		ANTHROPIC_API_KEY: "anthropic-test-key",
		RESEND_API_KEY: "resend-test-key",
		EMAIL_TO: "me@example.com",
		SUMMARY_FROM: "summary@example.com",
		PROCESSED_EMAILS: new MemoryKVNamespace() as unknown as KVNamespace,
		...overrides,
	};
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
});

describe("article URL extraction", () => {
	it("prefers a non-tracking article URL", () => {
		const html = `
			<p><a href="https://example.com/unsubscribe">Unsubscribe</a></p>
			<p><a href="https://click.example.net/track?url=https%3A%2F%2Fexample.com%2Fstory">Read story</a></p>
		`;

		expect(extractOriginalArticleUrl(html)).toBe("https://example.com/story");
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
});

describe("dedupe processing", () => {
	const fetchMock = vi.fn<typeof fetch>();

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal("fetch", fetchMock);
	});

	it("processes the same email only once", async () => {
		fetchMock.mockImplementation(async (input) => {
			if (typeof input === "string" && input.includes("anthropic.com")) {
				return new Response(
					JSON.stringify({
						content: [{ type: "text", text: "A concise summary." }],
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

		expect(fetchMock).toHaveBeenCalledTimes(2);

		const resendCall = fetchMock.mock.calls.find(
			([input]) => typeof input === "string" && input.includes("resend.com"),
		);
		expect(resendCall).toBeTruthy();
		expect(resendCall?.[1]?.headers).toMatchObject({
			"Idempotency-Key": expect.stringMatching(/^email:[a-f0-9]{64}$/),
		});
	});
});

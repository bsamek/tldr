// Service worker — orchestrates content extraction and API calls.

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.action === "summarize") {
    handleSummarize().then(sendResponse).catch((err) => {
      sendResponse({ error: err.message || "Unknown error" });
    });
    return true; // keep message channel open for async response
  }
});

async function handleSummarize() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  if (!tab?.id) {
    return { error: "No active tab found." };
  }

  // Inject Readability.js then content.js into the active tab
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["lib/Readability.js", "content.js"],
  });

  const extraction = results?.[results.length - 1]?.result;

  if (!extraction || extraction.error) {
    return { error: extraction?.error || "Extraction returned no result." };
  }

  // Get settings from storage
  const settings = await chrome.storage.sync.get(["workerUrl", "apiKey"]);

  if (!settings.workerUrl || !settings.apiKey) {
    return { error: "Please configure Worker URL and API key in settings." };
  }

  const apiUrl = settings.workerUrl.replace(/\/+$/, "") + "/api/save";

  const resp = await fetch(apiUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${settings.apiKey}`,
    },
    body: JSON.stringify({
      url: extraction.url,
      title: extraction.title,
      content: extraction.content,
      siteName: extraction.siteName,
    }),
  });

  if (!resp.ok) {
    const text = await resp.text();
    return { error: `Worker error: ${resp.status} ${text}` };
  }

  return await resp.json();
}

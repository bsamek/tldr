const statusEl = document.getElementById("status");
const summarizeBtn = document.getElementById("summarize");
const saveBtn = document.getElementById("save");
const workerUrlInput = document.getElementById("workerUrl");
const apiKeyInput = document.getElementById("apiKey");

// Load saved settings
chrome.storage.sync.get(["workerUrl", "apiKey"], (settings) => {
  if (settings.workerUrl) workerUrlInput.value = settings.workerUrl;
  if (settings.apiKey) apiKeyInput.value = settings.apiKey;
});

// Save settings
saveBtn.addEventListener("click", () => {
  const workerUrl = workerUrlInput.value.trim();
  const apiKey = apiKeyInput.value.trim();

  if (!workerUrl || !apiKey) {
    setStatus("Both fields are required.", "error");
    return;
  }

  chrome.storage.sync.set({ workerUrl, apiKey }, () => {
    setStatus("Settings saved.", "success");
  });
});

// Summarize current page
summarizeBtn.addEventListener("click", () => {
  summarizeBtn.disabled = true;
  setStatus("Extracting and sending...", "info");

  chrome.runtime.sendMessage({ action: "summarize" }, (response) => {
    summarizeBtn.disabled = false;

    if (chrome.runtime.lastError) {
      setStatus(chrome.runtime.lastError.message, "error");
      return;
    }

    if (!response) {
      setStatus("No response from background.", "error");
      return;
    }

    if (response.error) {
      setStatus(response.error, "error");
      return;
    }

    if (response.status === "duplicate") {
      setStatus("Already summarized.", "info");
    } else if (response.status === "sent") {
      setStatus("Summary sent!", "success");
    } else {
      setStatus("Done.", "success");
    }
  });
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = cls || "";
}

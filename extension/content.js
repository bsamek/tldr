// Injected on-demand by background.js after Readability.js is loaded.
// Runs in the context of the active tab, extracts article content.
(() => {
  try {
    const clone = document.cloneNode(true);
    const reader = new Readability(clone);
    const article = reader.parse();

    if (!article || !article.textContent) {
      return { error: "Could not extract article from this page." };
    }

    return {
      url: document.location.href,
      title: article.title || document.title,
      content: article.textContent,
      siteName: article.siteName || "",
    };
  } catch (err) {
    return { error: err.message || "Extraction failed." };
  }
})();

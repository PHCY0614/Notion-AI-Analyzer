(function attachAnalyzerShared(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.AnalyzerShared = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function createAnalyzerShared() {
  "use strict";

  function cleanText(value) {
    return String(value ?? "")
      .replace(/\r\n?/g, "\n")
      .replace(/[\t\u00a0]+/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  }

  function normalizeUuid(hex) {
    const compact = String(hex ?? "").replace(/-/g, "").toLowerCase();
    if (!/^[0-9a-f]{32}$/.test(compact)) return "";
    return [
      compact.slice(0, 8),
      compact.slice(8, 12),
      compact.slice(12, 16),
      compact.slice(16, 20),
      compact.slice(20)
    ].join("-");
  }

  function extractNotionId(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return "";
    const match = raw.match(/[0-9a-fA-F]{8}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{4}-?[0-9a-fA-F]{12}/);
    return match ? normalizeUuid(match[0]) : "";
  }

  function visibleLength(value) {
    return Array.from(String(value ?? "").replace(/\s/gu, "")).length;
  }

  function normalizeModelName(value) {
    const name = String(value ?? "").trim().replace(/^models\//, "");
    return /^[A-Za-z0-9._-]+$/.test(name) ? name : "";
  }

  function truncateMessage(value, maxLength = 300) {
    const text = cleanText(value);
    if (text.length <= maxLength) return text;
    return `${text.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function sleep(milliseconds) {
    return new Promise(resolve => setTimeout(resolve, milliseconds));
  }

  function chunkText(value, maxCharacters = 78000) {
    const text = cleanText(value);
    if (!text) return [];
    if (text.length <= maxCharacters) return [text];

    const paragraphs = text.split(/\n{2,}/);
    const chunks = [];
    let current = "";

    function pushCurrent() {
      if (current) chunks.push(current);
      current = "";
    }

    for (const paragraph of paragraphs) {
      if (paragraph.length > maxCharacters) {
        pushCurrent();
        let start = 0;
        while (start < paragraph.length) {
          let end = Math.min(start + maxCharacters, paragraph.length);
          if (end < paragraph.length) {
            const searchStart = Math.max(start, end - 1200);
            const boundary = paragraph.slice(searchStart, end).search(/[。！？!?\n][^。！？!?\n]*$/u);
            if (boundary >= 0) end = searchStart + boundary + 1;
          }
          if (end <= start) end = Math.min(start + maxCharacters, paragraph.length);
          chunks.push(paragraph.slice(start, end).trim());
          start = end;
        }
        continue;
      }

      const candidate = current ? `${current}\n\n${paragraph}` : paragraph;
      if (candidate.length > maxCharacters) {
        pushCurrent();
        current = paragraph;
      } else {
        current = candidate;
      }
    }
    pushCurrent();
    return chunks.filter(Boolean);
  }

  return Object.freeze({
    chunkText,
    cleanText,
    extractNotionId,
    normalizeModelName,
    normalizeUuid,
    sleep,
    truncateMessage,
    visibleLength
  });
});

"use strict";

// MV3 service worker entry. Classic importScripts (not ES modules) loads shared
// libraries, then background/* modules into the worker global scope.
importScripts(
  "shared.js",
  "prompt.js",
  "notion.js",
  "gemini.js",
  "background/constants.js",
  "background/state.js",
  "background/transport.js",
  "background/settings.js",
  "background/analysis.js",
  "background/queue.js",
  "background/topic-organizer.js",
  "background/topic-review.js",
  "background/messages.js"
);

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(data => sendResponse({ ok: true, data }))
    .catch(error => sendResponse({
      ok: false,
      error: {
        code: error?.code || "UNEXPECTED",
        message: S.truncateMessage(error?.message || "發生未知錯誤", 600)
      }
    }));
  return true;
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === PROCESS_ALARM) void processOne();
});

chrome.runtime.onInstalled.addListener(details => {
  void initialize();
  if (details.reason === "install") void chrome.runtime.openOptionsPage();
});

chrome.runtime.onStartup.addListener(() => {
  void initialize();
});

void initialize();

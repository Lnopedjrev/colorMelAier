import {
  MESSAGE_TYPES,
  createMessage,
  isColorTweakerMessage,
} from "../shared/messages.js";

const SESSION_STORAGE_KEY = "colorTweakerTabSessions";
const sessions = new Map();
let persistQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error("Unable to configure side panel", error));
});

const sessionsReady = chrome.storage.session
  .get(SESSION_STORAGE_KEY)
  .then((result) => {
    const stored = result[SESSION_STORAGE_KEY] || {};
    for (const [tabId, session] of Object.entries(stored)) {
      sessions.set(Number(tabId), { ...session, snapshot: null });
    }
  });

function sessionSummary(session) {
  return {
    tabId: session.tabId,
    title: session.title || "",
    url: session.url || "",
    desiredAttached: Boolean(session.desiredAttached),
    connected: Boolean(session.connected),
    needsReattach: Boolean(session.needsReattach),
    error: session.error || "",
    sourceCount:
      session.snapshot?.sources?.length ?? session.sourceCount ?? 0,
    skipped: session.snapshot?.skipped ?? session.skipped ?? 0,
  };
}

function persistSessions() {
  const stored = Object.fromEntries(
    Array.from(sessions, ([tabId, session]) => [tabId, sessionSummary(session)]),
  );
  persistQueue = persistQueue
    .catch(() => {})
    .then(() => chrome.storage.session.set({ [SESSION_STORAGE_KEY]: stored }));
  return persistQueue;
}

function publicSession(session) {
  return session
    ? {
        ...sessionSummary(session),
        snapshot: session.snapshot || null,
      }
    : null;
}

function broadcastSession(session) {
  chrome.runtime
    .sendMessage(
      createMessage(MESSAGE_TYPES.SESSION_STATE, {
        session: publicSession(session),
      }),
    )
    .catch(() => {});
}

function supportedPage(urlString) {
  let url;
  try {
    url = new URL(urlString);
  } catch {
    return { supported: false, reason: "This tab does not have a valid URL." };
  }
  if (!["http:", "https:", "file:"].includes(url.protocol)) {
    return {
      supported: false,
      reason: `ColorTweaker cannot run on ${url.protocol} pages.`,
    };
  }
  if (
    url.hostname === "chromewebstore.google.com" ||
    url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore")
  ) {
    return {
      supported: false,
      reason: "Chrome does not allow extensions to inspect the Chrome Web Store.",
    };
  }
  return { supported: true };
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab is available.");
  return tab;
}

function originPattern(urlString) {
  try {
    const url = new URL(urlString);
    if (!/^https?:$/.test(url.protocol)) return null;
    return `${url.origin}/*`;
  } catch {
    return null;
  }
}

async function hasFetchAccess(resourceUrl, pageUrl) {
  try {
    if (new URL(resourceUrl).origin === new URL(pageUrl).origin) return true;
  } catch {
    return false;
  }
  const pattern = originPattern(resourceUrl);
  return pattern
    ? chrome.permissions.contains({ origins: [pattern] })
    : false;
}

function absolutizeCssUrls(css, stylesheetUrl) {
  return css.replace(
    /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
    (match, quote, value) => {
      const reference = value.trim();
      if (/^(?:data:|blob:|https?:|#)/i.test(reference)) return match;
      try {
        const absolute = new URL(reference, stylesheetUrl).href;
        return `url("${absolute}")`;
      } catch {
        return match;
      }
    },
  );
}

function closingParen(text, openIndex) {
  let depth = 0;
  for (let index = openIndex; index < text.length; index++) {
    if (text[index] === "(") depth++;
    else if (text[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function wrapImportedCss(css, condition) {
  let rest = condition;
  let layer = null;
  let supports = null;
  const layerMatch = rest.match(/\blayer(?:\(([^)]*)\))?/i);
  if (layerMatch) {
    layer = layerMatch[1]?.trim() || "";
    rest = rest.replace(layerMatch[0], " ");
  }
  const supportsMatch = /\bsupports\s*\(/i.exec(rest);
  if (supportsMatch) {
    const open = rest.indexOf("(", supportsMatch.index);
    const close = closingParen(rest, open);
    if (close >= 0) {
      supports = rest.substring(open + 1, close).trim();
      rest = rest.substring(0, supportsMatch.index) + rest.substring(close + 1);
    }
  }

  let wrapped = css;
  const media = rest.trim();
  if (media) wrapped = `@media ${media}{\n${wrapped}\n}`;
  if (supports) {
    const supportsCondition =
      supports.startsWith("(") ||
      /^(?:selector|font-tech|font-format)\(/i.test(supports)
        ? supports
        : `(${supports})`;
    wrapped = `@supports ${supportsCondition}{\n${wrapped}\n}`;
  }
  if (layer !== null) {
    wrapped = `@layer${layer ? ` ${layer}` : ""}{\n${wrapped}\n}`;
  }
  return wrapped;
}

async function fetchStylesheet(url, pageUrl, visited = new Set()) {
  const normalized = new URL(url).href;
  if (visited.has(normalized)) return "";
  visited.add(normalized);

  const response = await fetch(normalized, { credentials: "include" });
  if (!response.ok) {
    throw new Error(`Stylesheet request failed with HTTP ${response.status}.`);
  }
  const css = await response.text();
  const importRe = /@import\s+(?:url\(\s*)?["']?([^"'\)\s]+)["']?\s*\)?\s*([^;]*);/gi;
  let expanded = "";
  let cursor = 0;
  let match;

  while ((match = importRe.exec(css))) {
    expanded += css.substring(cursor, match.index);
    cursor = importRe.lastIndex;
    let importedUrl;
    try {
      importedUrl = new URL(match[1], normalized).href;
    } catch {
      expanded += match[0];
      continue;
    }
    if (!(await hasFetchAccess(importedUrl, pageUrl))) {
      expanded += `@import url("${importedUrl}") ${match[2] || ""};`;
      continue;
    }
    try {
      const imported = await fetchStylesheet(importedUrl, pageUrl, visited);
      const condition = (match[2] || "").trim();
      expanded += condition ? wrapImportedCss(imported, condition) : imported;
    } catch {
      expanded += `@import url("${importedUrl}") ${match[2] || ""};`;
    }
  }
  expanded += css.substring(cursor);
  return absolutizeCssUrls(expanded, normalized);
}

async function enrichRemoteSources(tab, currentSnapshot) {
  let nextSnapshot = currentSnapshot;
  const loaded = [];
  const failures = [];
  for (const source of currentSnapshot?.unreadableStylesheets || []) {
    if (!(await hasFetchAccess(source.href, tab.url))) continue;
    try {
      loaded.push({
        id: source.id,
        href: source.href,
        text: await fetchStylesheet(source.href, tab.url),
      });
    } catch (error) {
      failures.push({ id: source.id, href: source.href, error: error.message });
    }
  }
  if (loaded.length) {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      createMessage(MESSAGE_TYPES.REGISTER_REMOTE_SOURCES, {
        sources: loaded,
      }),
    );
    if (response?.ok && response.snapshot) nextSnapshot = response.snapshot;
  }
  return { ...nextSnapshot, remoteFailures: failures };
}

async function scanTab(tab) {
  const response = await chrome.tabs.sendMessage(
    tab.id,
    createMessage(MESSAGE_TYPES.SCAN_REQUEST),
  );
  if (!response?.ok || !response.snapshot) {
    throw new Error(response?.error || "The page controller did not return CSS sources.");
  }
  return enrichRemoteSources(tab, response.snapshot);
}

async function injectController(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["content/controller.js"],
  });
}

async function connectTab(tab, desiredAttached = true) {
  const support = supportedPage(tab.url || "");
  if (!support.supported) throw new Error(support.reason);
  try {
    await injectController(tab.id);
    const nextSnapshot = await scanTab(tab);
    const session = {
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      desiredAttached,
      connected: true,
      needsReattach: false,
      error: "",
      snapshot: nextSnapshot,
    };
    sessions.set(tab.id, session);
    await persistSessions();
    broadcastSession(session);
    return session;
  } catch (error) {
    const session = {
      ...(sessions.get(tab.id) || {}),
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      desiredAttached,
      connected: false,
      needsReattach: true,
      error:
        error.message ||
        "Chrome refused access to this page. Check the extension's site access.",
      snapshot: null,
    };
    sessions.set(tab.id, session);
    await persistSessions();
    broadcastSession(session);
    throw new Error(session.error);
  }
}

async function reconcileTabSession(tab) {
  let session = sessions.get(tab.id);
  if (!session?.desiredAttached) return session || null;
  try {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      createMessage(MESSAGE_TYPES.PING),
    );
    if (response?.ok) {
      const nextSnapshot = await scanTab(tab);
      session = {
        ...session,
        title: tab.title || "",
        url: tab.url || "",
        connected: true,
        needsReattach: false,
        error: "",
        snapshot: nextSnapshot,
      };
      sessions.set(tab.id, session);
    }
  } catch {
    session = {
      ...session,
      title: tab.title || "",
      url: tab.url || "",
      connected: false,
      needsReattach: true,
      error: "The page was reloaded or navigated. Attach ColorTweaker again.",
      snapshot: null,
    };
    sessions.set(tab.id, session);
  }
  await persistSessions();
  return session;
}

async function getActiveSession() {
  await sessionsReady;
  const tab = await activeTab();
  const session = await reconcileTabSession(tab);
  return {
    tab: { id: tab.id, title: tab.title || "", url: tab.url || "" },
    session: publicSession(session),
  };
}

async function detachTab(tabId) {
  try {
    await chrome.tabs.sendMessage(
      tabId,
      createMessage(MESSAGE_TYPES.DETACH_REQUEST),
    );
  } catch {
    // Navigation may already have destroyed the controller and its DOM.
  }
  sessions.delete(tabId);
  await chrome.storage.session.remove(`colorTweakerEdits:${tabId}`);
  await persistSessions();
  broadcastSession(null);
}

async function handlePanelMessage(message) {
  await sessionsReady;
  if (message.type === MESSAGE_TYPES.GET_ACTIVE_SESSION) {
    return { ok: true, ...(await getActiveSession()) };
  }
  if (message.type === MESSAGE_TYPES.ATTACH_REQUEST) {
    const tab = await activeTab();
    return { ok: true, session: publicSession(await connectTab(tab)) };
  }
  if (message.type === MESSAGE_TYPES.SCAN_REQUEST) {
    const tab = await activeTab();
    const session = sessions.get(tab.id);
    if (!session?.desiredAttached) throw new Error("This tab is not attached.");
    const next = {
      ...session,
      title: tab.title || "",
      url: tab.url || "",
      connected: true,
      needsReattach: false,
      error: "",
      snapshot: await scanTab(tab),
    };
    sessions.set(tab.id, next);
    await persistSessions();
    broadcastSession(next);
    return { ok: true, session: publicSession(next) };
  }
  if (message.type === MESSAGE_TYPES.APPLY_SOURCE_UPDATES) {
    const tab = await activeTab();
    const session = sessions.get(tab.id);
    if (!session?.connected) throw new Error("This tab is not connected.");
    const response = await chrome.tabs.sendMessage(tab.id, message);
    if (!response?.ok) throw new Error(response?.error || "CSS update failed.");
    session.snapshot = response.snapshot || session.snapshot;
    sessions.set(tab.id, session);
    return { ok: true };
  }
  if (message.type === MESSAGE_TYPES.DETACH_REQUEST) {
    const tab = await activeTab();
    await detachTab(tab.id);
    return { ok: true };
  }
  return null;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isColorTweakerMessage(message)) return false;

  const task = sender.tab?.id && message.type === MESSAGE_TYPES.SOURCES_CHANGED
    ? (async () => {
        await sessionsReady;
        const session = sessions.get(sender.tab.id);
        if (!session?.desiredAttached) return { ok: false };
        const nextSnapshot = await enrichRemoteSources(
          sender.tab,
          message.snapshot,
        );
        const next = {
          ...session,
          title: sender.tab.title || session.title,
          url: sender.tab.url || session.url,
          connected: true,
          error: "",
          snapshot: nextSnapshot,
        };
        sessions.set(sender.tab.id, next);
        await persistSessions();
        broadcastSession(next);
        return { ok: true };
      })()
    : handlePanelMessage(message);

  if (!task) return false;
  Promise.resolve(task)
    .then((response) => sendResponse(response))
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  await sessionsReady;
  let session = sessions.get(tabId) || null;
  if (!session?.desiredAttached || session.snapshot) {
    broadcastSession(session);
    return;
  }
  try {
    session = await reconcileTabSession(await chrome.tabs.get(tabId));
    broadcastSession(session);
  } catch {
    broadcastSession(session);
  }
});

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  await sessionsReady;
  const session = sessions.get(tabId);
  if (!session?.desiredAttached) return;

  if (changeInfo.status === "loading") {
    const nextUrl = changeInfo.url || tab.url || session.url;
    let sameOrigin = false;
    try {
      sameOrigin = new URL(nextUrl).origin === new URL(session.url).origin;
    } catch {
      // Unsupported URLs are handled when the tab finishes loading.
    }
    sessions.set(tabId, {
      ...session,
      title: tab.title || session.title,
      url: nextUrl,
      connected: false,
      needsReattach: !sameOrigin,
      error: sameOrigin
        ? "Page is reloading…"
        : "Navigation requires reattachment from the extension icon.",
      snapshot: null,
    });
    await persistSessions();
    broadcastSession(sessions.get(tabId));
    return;
  }

  if (changeInfo.status === "complete") {
    const current = sessions.get(tabId);
    if (current.needsReattach) {
      current.title = tab.title || current.title;
      current.url = tab.url || current.url;
      current.error =
        "Click the extension icon on this page, then click Reattach.";
      sessions.set(tabId, current);
      await persistSessions();
      broadcastSession(current);
      return;
    }
    try {
      await connectTab(tab, true);
    } catch {
      // connectTab records and broadcasts the actionable error.
    }
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  await sessionsReady;
  sessions.delete(tabId);
  await chrome.storage.session.remove(`colorTweakerEdits:${tabId}`);
  await persistSessions();
});

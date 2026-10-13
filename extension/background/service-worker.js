import {
  MESSAGE_TYPES,
  createMessage,
  isColorTweakerMessage,
} from "../shared/messages.js";

const SESSION_STORAGE_KEY = "colorTweakerTabSessions";
const FRAME_SOURCE_ID_RE = /^frame-(\d+)-([^:]+):(.*)$/s;
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

function externalSourceId(frameId, documentId, sourceId) {
  return `frame-${frameId}-${documentId || "current"}:${sourceId}`;
}

function sourceDocumentId(frameId, documentId) {
  return frameId === 0 ? "top" : documentId || "current";
}

function localSourceIdentity(sourceId) {
  const match = FRAME_SOURCE_ID_RE.exec(String(sourceId));
  return match
    ? {
        frameId: Number(match[1]),
        documentId: match[2],
        sourceId: match[3],
      }
    : null;
}

function remoteFailure(error, href, extra = {}) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  let kind = "network";
  if (status === 401 || status === 403) kind = "authentication";
  else if (status !== null) kind = "http";
  return {
    href,
    error: error?.message || "The stylesheet could not be loaded.",
    kind,
    status,
    ...extra,
  };
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

async function fetchStylesheet(
  url,
  pageUrl,
  visited = new Set(),
  diagnostics = { failures: [], permissionRequired: [] },
) {
  const normalized = new URL(url).href;
  if (visited.has(normalized)) return "";
  visited.add(normalized);

  const response = await fetch(normalized, { credentials: "include" });
  if (!response.ok) {
    const error = new Error(
      `Stylesheet request failed with HTTP ${response.status}.`,
    );
    error.status = response.status;
    throw error;
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
      diagnostics.permissionRequired.push({
        href: importedUrl,
        importedBy: normalized,
      });
      expanded += `@import url("${importedUrl}") ${match[2] || ""};`;
      continue;
    }
    try {
      const imported = await fetchStylesheet(
        importedUrl,
        pageUrl,
        visited,
        diagnostics,
      );
      const condition = (match[2] || "").trim();
      expanded += condition ? wrapImportedCss(imported, condition) : imported;
    } catch (error) {
      diagnostics.failures.push(
        remoteFailure(error, importedUrl, { importedBy: normalized }),
      );
      expanded += `@import url("${importedUrl}") ${match[2] || ""};`;
    }
  }
  expanded += css.substring(cursor);
  return absolutizeCssUrls(expanded, normalized);
}

async function enrichFrameSnapshot(tab, frame, currentSnapshot) {
  let nextSnapshot = currentSnapshot;
  const loaded = [];
  const failures = [];
  const permissionRequired = [];
  for (const source of currentSnapshot?.unreadableStylesheets || []) {
    if (!(await hasFetchAccess(source.href, frame.url || tab.url))) continue;
    try {
      const diagnostics = { failures: [], permissionRequired: [] };
      loaded.push({
        id: source.id,
        href: source.href,
        text: await fetchStylesheet(
          source.href,
          frame.url || tab.url,
          new Set(),
          diagnostics,
        ),
      });
      failures.push(
        ...diagnostics.failures.map((failure) => ({
          ...failure,
          sourceId: source.id,
        })),
      );
      permissionRequired.push(...diagnostics.permissionRequired);
    } catch (error) {
      failures.push(
        remoteFailure(error, source.href, { sourceId: source.id }),
      );
    }
  }
  if (loaded.length) {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      createMessage(MESSAGE_TYPES.REGISTER_REMOTE_SOURCES, {
        sources: loaded,
      }),
      { frameId: frame.frameId },
    );
    if (response?.ok && response.snapshot) nextSnapshot = response.snapshot;
  }
  return {
    frameId: frame.frameId,
    documentId: sourceDocumentId(frame.frameId, frame.documentId),
    url: frame.url || tab.url || "",
    snapshot: nextSnapshot,
    remoteFailures: failures,
    permissionRequired,
  };
}

function namespaceFrameSnapshot(frameData, order) {
  const frameId = frameData.frameId;
  const documentId = frameData.documentId || "current";
  const frameName = frameId === 0 ? "" : `[frame ${frameId}] `;
  return {
    sources: (frameData.snapshot?.sources || []).map((source) => ({
      ...source,
      id: externalSourceId(frameId, documentId, source.id),
      name: `${frameName}${source.name}`,
      order: order.value++,
    })),
    unreadableStylesheets: (
      frameData.snapshot?.unreadableStylesheets || []
    ).map((source) => ({
      ...source,
      id: externalSourceId(frameId, documentId, source.id),
      name: `${frameName}${source.name}`,
      frameId,
      frameUrl: frameData.url,
    })),
    permissionRequired: (frameData.permissionRequired || []).map((item) => ({
      ...item,
      frameId,
      frameUrl: frameData.url,
    })),
    remoteFailures: (frameData.remoteFailures || []).map((failure) => ({
      ...failure,
      id: failure.sourceId
        ? externalSourceId(frameId, documentId, failure.sourceId)
        : null,
      frameId,
      frameUrl: frameData.url,
    })),
  };
}

function aggregateFrameSnapshots(frameSnapshots, inaccessibleFrames = []) {
  const result = {
    sources: [],
    skipped: 0,
    unreadableStylesheets: [],
    permissionRequired: [],
    inaccessibleFrames,
    remoteFailures: inaccessibleFrames.map((frame) => ({
      href: frame.url,
      error: frame.error,
      kind: "frame-access",
      frameId: frame.frameId,
      frameUrl: frame.url,
    })),
  };
  const order = { value: 0 };
  for (const frameData of Array.from(frameSnapshots.values()).sort(
    (left, right) => left.frameId - right.frameId,
  )) {
    const namespaced = namespaceFrameSnapshot(frameData, order);
    result.sources.push(...namespaced.sources);
    result.unreadableStylesheets.push(...namespaced.unreadableStylesheets);
    result.permissionRequired.push(...namespaced.permissionRequired);
    result.remoteFailures.push(...namespaced.remoteFailures);
    result.skipped += frameData.snapshot?.skipped || 0;
  }
  return result;
}

async function scanFrame(tab, frame) {
  const response = await chrome.tabs.sendMessage(
    tab.id,
    createMessage(MESSAGE_TYPES.SCAN_REQUEST),
    { frameId: frame.frameId },
  );
  if (!response?.ok || !response.snapshot) {
    throw new Error(response?.error || "The page controller did not return CSS sources.");
  }
  return enrichFrameSnapshot(tab, frame, response.snapshot);
}

async function injectController(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  await chrome.scripting.executeScript({
    target,
    world: "MAIN",
    files: ["content/page-hooks.js"],
  });
  await chrome.scripting.executeScript({
    target,
    files: ["content/controller.js"],
  });
}

async function tabFrames(tab) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id });
  return frames?.length
    ? frames
    : [{ frameId: 0, parentFrameId: -1, url: tab.url || "" }];
}

async function scanTab(tab) {
  const frameSnapshots = new Map();
  const inaccessibleFrames = [];
  const frames = await tabFrames(tab);
  for (const frame of frames) {
    try {
      await injectController(tab.id, frame.frameId);
      frameSnapshots.set(frame.frameId, await scanFrame(tab, frame));
    } catch (error) {
      if (frame.frameId === 0) throw error;
      inaccessibleFrames.push({
        frameId: frame.frameId,
        url: frame.url || "",
        error:
          error.message ||
          "Chrome did not allow ColorTweaker to inspect this frame.",
      });
    }
  }
  return {
    frameSnapshots,
    inaccessibleFrames,
    snapshot: aggregateFrameSnapshots(frameSnapshots, inaccessibleFrames),
  };
}

async function connectTab(tab, desiredAttached = true) {
  const support = supportedPage(tab.url || "");
  if (!support.supported) throw new Error(support.reason);
  try {
    const scan = await scanTab(tab);
    const session = {
      tabId: tab.id,
      title: tab.title || "",
      url: tab.url || "",
      desiredAttached,
      connected: true,
      needsReattach: false,
      error: "",
      snapshot: scan.snapshot,
      frameSnapshots: scan.frameSnapshots,
      inaccessibleFrames: scan.inaccessibleFrames,
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
      { frameId: 0 },
    );
    if (response?.ok) {
      const scan = await scanTab(tab);
      session = {
        ...session,
        title: tab.title || "",
        url: tab.url || "",
        connected: true,
        needsReattach: false,
        error: "",
        snapshot: scan.snapshot,
        frameSnapshots: scan.frameSnapshots,
        inaccessibleFrames: scan.inaccessibleFrames,
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
  const session = sessions.get(tabId);
  const frameIds = session?.frameSnapshots?.size
    ? Array.from(session.frameSnapshots.keys())
    : [0];
  await Promise.allSettled(
    frameIds.map((frameId) =>
      chrome.tabs.sendMessage(
        tabId,
        createMessage(MESSAGE_TYPES.DETACH_REQUEST),
        { frameId },
      ),
    ),
  );
  sessions.delete(tabId);
  await chrome.storage.session.remove(`colorTweakerEdits:${tabId}`);
  await persistSessions();
  broadcastSession(null);
}

async function applyUpdatesToFrames(tab, session, updates) {
  const updatesByFrame = new Map();
  for (const update of updates || []) {
    const identity = localSourceIdentity(update?.id);
    if (!identity) continue;
    const currentDocumentId =
      session.frameSnapshots?.get(identity.frameId)?.documentId || "current";
    if (identity.documentId !== currentDocumentId) continue;
    if (!updatesByFrame.has(identity.frameId)) {
      updatesByFrame.set(identity.frameId, []);
    }
    updatesByFrame.get(identity.frameId).push({
      ...update,
      id: identity.sourceId,
    });
  }

  for (const [frameId, frameUpdates] of updatesByFrame) {
    const response = await chrome.tabs.sendMessage(
      tab.id,
      createMessage(MESSAGE_TYPES.APPLY_SOURCE_UPDATES, {
        updates: frameUpdates,
      }),
      { frameId },
    );
    if (!response?.ok || !response.snapshot) {
      throw new Error(response?.error || `CSS update failed in frame ${frameId}.`);
    }
    const previous = session.frameSnapshots?.get(frameId);
    if (previous) {
      session.frameSnapshots.set(frameId, {
        ...previous,
        snapshot: response.snapshot,
      });
    }
  }

  session.snapshot = aggregateFrameSnapshots(
    session.frameSnapshots || new Map(),
    session.inaccessibleFrames || [],
  );
  return session.snapshot;
}

async function setInspectorInFrames(tabId, session, message) {
  const frameIds = session.frameSnapshots?.size
    ? Array.from(session.frameSnapshots.keys())
    : [0];
  const results = await Promise.allSettled(
    frameIds.map((frameId) =>
      chrome.tabs.sendMessage(tabId, message, { frameId }),
    ),
  );
  const topFrameIndex = frameIds.indexOf(0);
  const topFrameResult = results[topFrameIndex >= 0 ? topFrameIndex : 0];
  if (topFrameResult?.status === "rejected") throw topFrameResult.reason;
  if (topFrameResult?.value && !topFrameResult.value.ok) {
    throw new Error(topFrameResult.value.error || "Inspector update failed.");
  }
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
    const scan = await scanTab(tab);
    const next = {
      ...session,
      title: tab.title || "",
      url: tab.url || "",
      connected: true,
      needsReattach: false,
      error: "",
      snapshot: scan.snapshot,
      frameSnapshots: scan.frameSnapshots,
      inaccessibleFrames: scan.inaccessibleFrames,
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
    const nextSnapshot = await applyUpdatesToFrames(
      tab,
      session,
      message.updates,
    );
    sessions.set(tab.id, session);
    return { ok: true, snapshot: nextSnapshot };
  }
  if (
    message.type === MESSAGE_TYPES.INSPECT_START ||
    message.type === MESSAGE_TYPES.INSPECT_STOP
  ) {
    const tab =
      message.type === MESSAGE_TYPES.INSPECT_STOP &&
      Number.isInteger(message.tabId)
        ? await chrome.tabs.get(message.tabId)
        : await activeTab();
    const session = sessions.get(tab.id);
    if (!session?.connected) throw new Error("This tab is not connected.");
    await setInspectorInFrames(tab.id, session, message);
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

  let task;
  if (sender.tab?.id && message.type === MESSAGE_TYPES.SOURCES_CHANGED) {
    task = (async () => {
        await sessionsReady;
        const session = sessions.get(sender.tab.id);
        if (!session?.desiredAttached) return { ok: false };
        if (message.rescanFrames || !(session.frameSnapshots instanceof Map)) {
          const scan = await scanTab(sender.tab);
          session.frameSnapshots = scan.frameSnapshots;
          session.inaccessibleFrames = scan.inaccessibleFrames;
          session.snapshot = scan.snapshot;
        } else {
          const frameId = sender.frameId ?? 0;
          const frameData = await enrichFrameSnapshot(
            sender.tab,
            {
              frameId,
              documentId: sender.documentId || "current",
              url: sender.url || sender.tab.url || "",
            },
            message.snapshot,
          );
          session.frameSnapshots.set(frameId, frameData);
          session.inaccessibleFrames = (
            session.inaccessibleFrames || []
          ).filter((frame) => frame.frameId !== frameId);
          session.snapshot = aggregateFrameSnapshots(
            session.frameSnapshots,
            session.inaccessibleFrames,
          );
        }
        const next = {
          ...session,
          title: sender.tab.title || session.title,
          url: sender.tab.url || session.url,
          connected: true,
          error: "",
        };
        sessions.set(sender.tab.id, next);
        await persistSessions();
        broadcastSession(next);
        return { ok: true };
      })();
  } else if (sender.tab?.id && message.type === MESSAGE_TYPES.INSPECT_RESULT) {
    task = chrome.runtime
      .sendMessage(
        createMessage(MESSAGE_TYPES.INSPECT_RESULT, {
          tabId: sender.tab.id,
          candidates: Array.isArray(message.candidates)
            ? message.candidates
            : [],
        }),
      )
      .then(() => ({ ok: true }));
  } else {
    task = handlePanelMessage(message);
  }

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

async function prepareCommittedFrame(details) {
  if (details.frameId === 0) return;
  await sessionsReady;
  const session = sessions.get(details.tabId);
  if (!session?.desiredAttached) return;
  session.frameSnapshots?.delete(details.frameId);
  session.inaccessibleFrames = (session.inaccessibleFrames || []).filter(
    (frame) => frame.frameId !== details.frameId,
  );
  try {
    await injectController(details.tabId, details.frameId);
  } catch (error) {
    session.inaccessibleFrames.push({
      frameId: details.frameId,
      url: details.url || "",
      error:
        error.message ||
        "Chrome did not allow ColorTweaker to inspect this frame.",
    });
  }
  session.snapshot = aggregateFrameSnapshots(
    session.frameSnapshots || new Map(),
    session.inaccessibleFrames,
  );
  sessions.set(details.tabId, session);
}

async function scanCommittedFrame(details) {
  if (details.frameId === 0) return;
  await sessionsReady;
  const session = sessions.get(details.tabId);
  if (!session?.desiredAttached) return;
  try {
    const tab = await chrome.tabs.get(details.tabId);
    await injectController(details.tabId, details.frameId);
    if (!(session.frameSnapshots instanceof Map)) session.frameSnapshots = new Map();
    session.frameSnapshots.set(
      details.frameId,
      await scanFrame(tab, {
        frameId: details.frameId,
        documentId: details.documentId || "current",
        url: details.url || "",
      }),
    );
    session.inaccessibleFrames = (session.inaccessibleFrames || []).filter(
      (frame) => frame.frameId !== details.frameId,
    );
  } catch (error) {
    session.frameSnapshots?.delete(details.frameId);
    session.inaccessibleFrames = (session.inaccessibleFrames || []).filter(
      (frame) => frame.frameId !== details.frameId,
    );
    session.inaccessibleFrames.push({
      frameId: details.frameId,
      url: details.url || "",
      error:
        error.message ||
        "Chrome did not allow ColorTweaker to inspect this frame.",
    });
  }
  session.snapshot = aggregateFrameSnapshots(
    session.frameSnapshots || new Map(),
    session.inaccessibleFrames,
  );
  sessions.set(details.tabId, session);
  await persistSessions();
  broadcastSession(session);
}

chrome.webNavigation.onCommitted.addListener((details) => {
  prepareCommittedFrame(details).catch(() => {});
});

chrome.webNavigation.onDOMContentLoaded.addListener((details) => {
  scanCommittedFrame(details).catch(() => {});
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

import { createBrowserColorAdapter } from "../shared/browser-color.js";
import { createCssParser } from "../shared/css-parser.js";
import { createCssSourceStore } from "../shared/css-sources.js";
import { createColorTweakerState } from "../shared/state.js";
import {
  MESSAGE_TYPES,
  createMessage,
  isColorTweakerMessage,
} from "../shared/messages.js";

const colorAdapter = createBrowserColorAdapter(document);
const parser = createCssParser(colorAdapter);
const tabStores = new Map();
let activeTab = null;
let activeSession = null;
let renderSequence = 0;
let applyTimer = null;

const elements = {
  tabTitle: document.getElementById("tab-title"),
  tabUrl: document.getElementById("tab-url"),
  attach: document.getElementById("attach"),
  refresh: document.getElementById("refresh"),
  detach: document.getElementById("detach"),
  status: document.getElementById("status"),
  grantAccess: document.getElementById("grant-access"),
  sourceCount: document.getElementById("source-count"),
  colorCount: document.getElementById("color-count"),
  skippedCount: document.getElementById("skipped-count"),
  reset: document.getElementById("reset"),
  colorList: document.getElementById("color-list"),
  sourceList: document.getElementById("source-list"),
};

function editStorageKey(tabId) {
  return `colorTweakerEdits:${tabId}`;
}

async function createTabStore(tabId) {
  const state = createColorTweakerState({ cssMode: "tab" });
  const sourceStore = createCssSourceStore({
    state,
    buildColorEntries: parser.buildColorEntries,
    extractAlpha: colorAdapter.extractAlpha,
    hexToRgba: colorAdapter.hexToRgba,
  });
  const saved = await chrome.storage.session.get(editStorageKey(tabId));
  const edits = saved[editStorageKey(tabId)] || {};
  for (const [entryId, value] of Object.entries(edits.replacements || {})) {
    state.replacements.set(entryId, value);
  }
  for (const [entryId, value] of Object.entries(edits.alphaOverrides || {})) {
    state.alphaOverrides.set(entryId, value);
  }
  return { state, sourceStore };
}

async function storeForTab(tabId) {
  if (!tabStores.has(tabId)) {
    tabStores.set(tabId, createTabStore(tabId));
  }
  return tabStores.get(tabId);
}

async function persistEdits(tabId, state) {
  await chrome.storage.session.set({
    [editStorageKey(tabId)]: {
      replacements: Object.fromEntries(state.replacements),
      alphaOverrides: Object.fromEntries(state.alphaOverrides),
    },
  });
}

async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage(createMessage(type, payload));
  if (!response?.ok) throw new Error(response?.error || "ColorTweaker request failed.");
  return response;
}

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.className = `status${kind ? ` ${kind}` : ""}`;
}

function setBusy(busy) {
  elements.attach.disabled = busy;
  elements.refresh.disabled = busy || !activeSession?.connected;
  elements.detach.disabled = busy || !activeSession?.desiredAttached;
}

function originPatterns(unreadableStylesheets) {
  const patterns = new Set();
  for (const source of unreadableStylesheets || []) {
    try {
      const url = new URL(source.href);
      if (/^https?:$/.test(url.protocol)) patterns.add(`${url.origin}/*`);
    } catch {
      // Invalid stylesheet URLs are already counted as skipped.
    }
  }
  return Array.from(patterns);
}

function renderSources(snapshot) {
  elements.sourceList.replaceChildren();
  for (const source of snapshot?.sources || []) {
    const row = document.createElement("div");
    row.className = "source-row";
    const kind = document.createElement("span");
    kind.className = "source-kind";
    kind.textContent = source.kind;
    const name = document.createElement("span");
    name.className = "source-name";
    name.textContent = source.name;
    name.title = source.href || source.name;
    row.append(kind, name);
    elements.sourceList.append(row);
  }
}

function renderColors(tabId, store) {
  const { state } = store;
  elements.colorList.replaceChildren();
  elements.colorList.classList.toggle("empty", !state.colorEntries.length);
  if (!state.colorEntries.length) {
    elements.colorList.textContent = activeSession?.connected
      ? "No editable colors were found."
      : "Attach to a page to scan its colors.";
    return;
  }

  for (const entry of state.colorEntries) {
    const row = document.createElement("label");
    row.className = "color-row";
    row.title = Array.from(entry.originals).join(", ");

    const input = document.createElement("input");
    input.type = "color";
    input.value = state.replacements.get(entry.id) || entry.hex6;
    input.addEventListener("input", () => {
      state.replacements.set(entry.id, input.value);
      persistEdits(tabId, state).catch(() => {});
      scheduleApply(store);
    });

    const copy = document.createElement("span");
    copy.className = "color-copy";
    const title = document.createElement("strong");
    title.textContent = entry.name || Array.from(entry.originals)[0] || entry.hex6;
    const value = document.createElement("span");
    value.textContent = entry.canonical;
    copy.append(title, value);

    const count = document.createElement("span");
    count.className = "color-count";
    count.textContent = `×${entry.count}`;
    row.append(input, copy, count);
    elements.colorList.append(row);
  }
}

async function applyStore(store) {
  if (!activeSession?.connected || activeSession.tabId !== activeTab?.id) return;
  try {
    await request(MESSAGE_TYPES.APPLY_SOURCE_UPDATES, {
      updates: store.sourceStore.getCssSourceUpdates(),
    });
    setStatus("Changes applied to the current tab.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function scheduleApply(store) {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => applyStore(store), 60);
}

async function reconcileSnapshot(tabId, snapshot) {
  const store = await storeForTab(tabId);
  store.state.cssSources = [];
  for (const source of snapshot?.sources || []) {
    store.sourceStore.registerCssSource(source);
  }
  store.sourceStore.rebuildColorEntries();
  renderColors(tabId, store);
  renderSources(snapshot);
  elements.colorCount.textContent = String(store.state.colorEntries.length);
  if (store.state.replacements.size) scheduleApply(store);
  return store;
}

async function renderSession(session, tab = null) {
  const sequence = ++renderSequence;
  if (tab) activeTab = tab;
  if (session?.tabId && (!activeTab || activeTab.id !== session.tabId)) {
    activeTab = {
      id: session.tabId,
      title: session.title,
      url: session.url,
    };
  }
  activeSession = session;

  elements.tabTitle.textContent = activeTab?.title || session?.title || "Active tab";
  elements.tabUrl.textContent = activeTab?.url || session?.url || "";
  elements.attach.textContent = session?.needsReattach ? "Reattach" : "Attach";
  elements.attach.disabled = Boolean(session?.connected);
  elements.refresh.disabled = !session?.connected;
  elements.detach.disabled = !session?.desiredAttached;
  elements.reset.disabled = !session?.connected;

  const snapshot = session?.snapshot;
  elements.sourceCount.textContent = String(
    snapshot?.sources?.length ?? session?.sourceCount ?? 0,
  );
  elements.skippedCount.textContent = String(
    snapshot?.skipped ?? session?.skipped ?? 0,
  );

  if (session?.connected) {
    setStatus("Attached. Runtime stylesheet changes are being watched.", "success");
  } else if (session?.error) {
    setStatus(session.error, "error");
  } else {
    setStatus("Not attached.");
  }

  const patterns = originPatterns(snapshot?.unreadableStylesheets);
  elements.grantAccess.hidden = !patterns.length;
  elements.grantAccess.dataset.origins = JSON.stringify(patterns);
  elements.grantAccess.textContent = patterns.length
    ? `Allow access to ${patterns.length} stylesheet origin${patterns.length === 1 ? "" : "s"}`
    : "";

  if (session?.tabId && snapshot) {
    await reconcileSnapshot(session.tabId, snapshot);
  } else {
    elements.sourceList.replaceChildren();
    elements.colorList.className = "color-list empty";
    elements.colorList.textContent = session?.desiredAttached
      ? "Waiting for the page to reconnect."
      : "Attach to a page to scan its colors.";
    elements.colorCount.textContent = "0";
  }
  if (sequence !== renderSequence) return;
}

async function loadActiveSession() {
  try {
    const response = await request(MESSAGE_TYPES.GET_ACTIVE_SESSION);
    await renderSession(response.session, response.tab);
  } catch (error) {
    setStatus(error.message, "error");
  }
}

elements.attach.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Attaching to the current tab…");
  try {
    const response = await request(MESSAGE_TYPES.ATTACH_REQUEST);
    await renderSession(response.session);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

elements.refresh.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Scanning CSS sources…");
  try {
    const response = await request(MESSAGE_TYPES.SCAN_REQUEST);
    await renderSession(response.session);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

elements.detach.addEventListener("click", async () => {
  setBusy(true);
  try {
    await request(MESSAGE_TYPES.DETACH_REQUEST);
    if (activeTab?.id) tabStores.delete(activeTab.id);
    await renderSession(null, activeTab);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

elements.reset.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  const store = await storeForTab(activeTab.id);
  store.state.replacements.clear();
  store.state.alphaOverrides.clear();
  await chrome.storage.session.remove(editStorageKey(activeTab.id));
  renderColors(activeTab.id, store);
  await applyStore(store);
});

elements.grantAccess.addEventListener("click", async () => {
  const origins = JSON.parse(elements.grantAccess.dataset.origins || "[]");
  if (!origins.length) return;
  try {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      setStatus("Stylesheet access was not granted.", "error");
      return;
    }
    const response = await request(MESSAGE_TYPES.SCAN_REQUEST);
    await renderSession(response.session);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (!isColorTweakerMessage(message, MESSAGE_TYPES.SESSION_STATE)) return;
  chrome.tabs
    .query({ active: true, currentWindow: true })
    .then(([tab]) => {
      if (!tab?.id) return;
      if (!message.session || message.session.tabId !== tab.id) {
        if (!activeTab || activeTab.id !== tab.id) return loadActiveSession();
        return;
      }
      return renderSession(message.session, {
        id: tab.id,
        title: tab.title || message.session.title,
        url: tab.url || message.session.url,
      });
    })
    .catch((error) => setStatus(error.message, "error"));
});

loadActiveSession();

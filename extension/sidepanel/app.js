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
const selectedSourceIds = new Map();
const colorRows = new Map();
let activeTab = null;
let activeSession = null;
let inspectorMode = "off";
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
  remoteFailures: document.getElementById("remote-failures"),
  remoteFailureList: document.getElementById("remote-failure-list"),
  sourceCount: document.getElementById("source-count"),
  colorCount: document.getElementById("color-count"),
  skippedCount: document.getElementById("skipped-count"),
  inspect: document.getElementById("inspect"),
  frozenInspect: document.getElementById("frozen-inspect"),
  exportCss: document.getElementById("export-css"),
  reset: document.getElementById("reset"),
  colorList: document.getElementById("color-list"),
  sourceList: document.getElementById("source-list"),
  sourceSelect: document.getElementById("source-select"),
  sourceEditor: document.getElementById("source-editor"),
  reloadSource: document.getElementById("reload-source"),
  applySource: document.getElementById("apply-source"),
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
  return { tabId, state, sourceStore };
}

async function storeForTab(tabId) {
  if (!tabStores.has(tabId)) tabStores.set(tabId, createTabStore(tabId));
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
  if (!response?.ok) {
    throw new Error(response?.error || "ColorTweaker request failed.");
  }
  return response;
}

function setStatus(message, kind = "") {
  elements.status.textContent = message;
  elements.status.className = `status${kind ? ` ${kind}` : ""}`;
}

function setBusy(busy) {
  elements.attach.disabled = busy || Boolean(activeSession?.connected);
  elements.refresh.disabled = busy || !activeSession?.connected;
  elements.detach.disabled = busy || !activeSession?.desiredAttached;
}

function updateInspectorButtons() {
  const inspecting = inspectorMode === "inspect";
  const frozen = inspectorMode === "frozen";
  elements.inspect.classList.toggle("active", inspecting);
  elements.inspect.setAttribute("aria-pressed", String(inspecting));
  elements.inspect.textContent = inspecting ? "Inspecting…" : "Inspect";
  elements.frozenInspect.classList.toggle("active", frozen);
  elements.frozenInspect.setAttribute("aria-pressed", String(frozen));
  elements.frozenInspect.textContent = frozen ? "Frozen…" : "Frozen";
}

function clearInspectorUi() {
  inspectorMode = "off";
  updateInspectorButtons();
}

function stopInspectorForTab(tabId) {
  if (inspectorMode === "off" || !Number.isInteger(tabId)) return;
  request(MESSAGE_TYPES.INSPECT_STOP, { tabId }).catch(() => {});
  clearInspectorUi();
}

function originPatterns(unreadableStylesheets) {
  const patterns = new Set();
  for (const source of unreadableStylesheets || []) {
    try {
      const url = new URL(source.href);
      if (/^https?:$/.test(url.protocol)) patterns.add(`${url.origin}/*`);
    } catch {
      // Invalid stylesheet URLs remain reported as skipped.
    }
  }
  return Array.from(patterns);
}

function entryAlpha(entry, state) {
  if (state.alphaOverrides.has(entry.id)) {
    return state.alphaOverrides.get(entry.id);
  }
  for (const original of entry.originals) {
    const alpha = colorAdapter.extractAlpha(original);
    if (alpha !== null) return alpha;
  }
  return 1;
}

function effectiveCanonical(entry, state) {
  if (
    !state.replacements.has(entry.id) &&
    !state.alphaOverrides.has(entry.id)
  ) {
    return entry.canonical;
  }
  const hex = state.replacements.get(entry.id) || entry.hex6;
  const alpha = entryAlpha(entry, state);
  return colorAdapter.toCanonical(
    alpha < 1 ? colorAdapter.hexToRgba(hex, alpha) : hex,
  );
}

async function resetEntry(tabId, store, entryId) {
  store.state.replacements.delete(entryId);
  store.state.alphaOverrides.delete(entryId);
  await persistEdits(tabId, store.state);
  renderColors(tabId, store);
  scheduleApply(store);
}

function renderColors(tabId, store) {
  const { state } = store;
  colorRows.clear();
  elements.colorList.replaceChildren();
  elements.colorList.classList.toggle("empty", !state.colorEntries.length);
  if (!state.colorEntries.length) {
    elements.colorList.textContent = activeSession?.connected
      ? "No editable colors were found."
      : "Attach to a page to scan its colors.";
    return;
  }

  for (const entry of state.colorEntries) {
    const row = document.createElement("div");
    row.className = "color-row";
    row.title = Array.from(entry.originals).join(", ");
    colorRows.set(entry.id, row);

    const colorInput = document.createElement("input");
    colorInput.type = "color";
    colorInput.setAttribute("aria-label", `Change ${entry.name || entry.hex6}`);
    colorInput.value = state.replacements.get(entry.id) || entry.hex6;
    colorInput.addEventListener("input", () => {
      state.replacements.set(entry.id, colorInput.value);
      reset.disabled = false;
      persistEdits(tabId, state).catch(() => {});
      scheduleApply(store);
    });

    const copy = document.createElement("span");
    copy.className = "color-copy";
    const title = document.createElement("strong");
    title.textContent = entry.name || Array.from(entry.originals)[0] || entry.hex6;
    const value = document.createElement("span");
    value.textContent = `${entry.canonical} · ×${entry.count}`;
    copy.append(title, value);

    const reset = document.createElement("button");
    reset.type = "button";
    reset.className = "color-reset";
    reset.textContent = "Reset";
    reset.disabled =
      !state.replacements.has(entry.id) &&
      !state.alphaOverrides.has(entry.id);
    reset.addEventListener("click", () => {
      resetEntry(tabId, store, entry.id).catch((error) => {
        setStatus(error.message, "error");
      });
    });

    const alpha = document.createElement("label");
    alpha.className = "alpha-control";
    const alphaLabel = document.createElement("span");
    alphaLabel.textContent = "Alpha";
    const alphaInput = document.createElement("input");
    alphaInput.type = "range";
    alphaInput.min = "0";
    alphaInput.max = "100";
    alphaInput.step = "1";
    alphaInput.value = String(Math.round(entryAlpha(entry, state) * 100));
    const alphaOutput = document.createElement("output");
    alphaOutput.textContent = `${alphaInput.value}%`;
    alphaInput.addEventListener("input", () => {
      const nextAlpha = Number(alphaInput.value) / 100;
      state.alphaOverrides.set(entry.id, nextAlpha);
      if (!state.replacements.has(entry.id)) {
        state.replacements.set(entry.id, entry.hex6);
      }
      alphaOutput.textContent = `${alphaInput.value}%`;
      reset.disabled = false;
      persistEdits(tabId, state).catch(() => {});
      scheduleApply(store);
    });
    alpha.append(alphaLabel, alphaInput, alphaOutput);

    row.append(colorInput, copy, reset, alpha);
    elements.colorList.append(row);
  }
}

function renderRemoteFailures(snapshot) {
  const failures = snapshot?.remoteFailures || [];
  elements.remoteFailures.hidden = !failures.length;
  elements.remoteFailureList.replaceChildren();
  for (const failure of failures) {
    const item = document.createElement("div");
    item.className = "remote-failure";
    item.textContent = `${failure.href}: ${failure.error}`;
    elements.remoteFailureList.append(item);
  }
}

function loadSelectedSource(tabId, store) {
  const selectedId = selectedSourceIds.get(tabId);
  const source = store.state.cssSources.find((item) => item.id === selectedId);
  elements.sourceEditor.value = source?.text || "";
  const enabled = Boolean(source) && Boolean(activeSession?.connected);
  elements.sourceEditor.disabled = !enabled;
  elements.reloadSource.disabled = !enabled;
  elements.applySource.disabled = !enabled;
}

function renderSources(tabId, store) {
  const sources = store.state.cssSources;
  elements.sourceList.replaceChildren();
  elements.sourceSelect.replaceChildren();

  for (const source of sources) {
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

    const option = document.createElement("option");
    option.value = source.id;
    option.textContent = `${source.kind}: ${source.name}`;
    elements.sourceSelect.append(option);
  }

  let selectedId = selectedSourceIds.get(tabId);
  if (!sources.some((source) => source.id === selectedId)) {
    selectedId = sources[0]?.id || null;
    if (selectedId) selectedSourceIds.set(tabId, selectedId);
    else selectedSourceIds.delete(tabId);
  }
  elements.sourceSelect.disabled = !sources.length || !activeSession?.connected;
  if (selectedId) elements.sourceSelect.value = selectedId;
  loadSelectedSource(tabId, store);
}

async function applyStore(store) {
  if (
    !activeSession?.connected ||
    activeSession.tabId !== activeTab?.id ||
    store.tabId !== activeTab.id
  ) {
    return;
  }
  try {
    const response = await request(MESSAGE_TYPES.APPLY_SOURCE_UPDATES, {
      updates: store.sourceStore.getCssSourceUpdates(),
    });
    if (response.snapshot) {
      activeSession = {
        ...activeSession,
        snapshot: {
          ...response.snapshot,
          remoteFailures: activeSession.snapshot?.remoteFailures || [],
        },
      };
    }
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
  renderSources(tabId, store);
  renderRemoteFailures(snapshot);
  elements.colorCount.textContent = String(store.state.colorEntries.length);
  if (store.state.replacements.size) scheduleApply(store);
  return store;
}

async function renderSession(session, tab = null) {
  const sequence = ++renderSequence;
  const incomingTabId = tab?.id || session?.tabId || null;
  if (activeTab?.id && incomingTabId && activeTab.id !== incomingTabId) {
    stopInspectorForTab(activeTab.id);
  }
  if (tab) activeTab = tab;
  if (session?.tabId && (!activeTab || activeTab.id !== session.tabId)) {
    activeTab = {
      id: session.tabId,
      title: session.title,
      url: session.url,
    };
  }
  activeSession = session;
  if (!session?.connected) clearInspectorUi();

  elements.tabTitle.textContent = activeTab?.title || session?.title || "Active tab";
  elements.tabUrl.textContent = activeTab?.url || session?.url || "";
  elements.attach.textContent = session?.needsReattach ? "Reattach" : "Attach";
  elements.attach.disabled = Boolean(session?.connected);
  elements.refresh.disabled = !session?.connected;
  elements.detach.disabled = !session?.desiredAttached;
  elements.inspect.disabled = !session?.connected;
  elements.frozenInspect.disabled = !session?.connected;
  elements.exportCss.disabled = !session?.connected;
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
    elements.sourceSelect.replaceChildren();
    elements.sourceSelect.disabled = true;
    elements.sourceEditor.value = "";
    elements.sourceEditor.disabled = true;
    elements.reloadSource.disabled = true;
    elements.applySource.disabled = true;
    elements.remoteFailures.hidden = true;
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

async function toggleInspector(mode) {
  if (!activeSession?.connected) return;
  try {
    if (inspectorMode === mode) {
      await request(MESSAGE_TYPES.INSPECT_STOP);
      clearInspectorUi();
      setStatus("Inspector stopped.");
      return;
    }
    await request(MESSAGE_TYPES.INSPECT_START, { mode });
    inspectorMode = mode;
    updateInspectorButtons();
    setStatus(
      mode === "frozen"
        ? "Frozen inspector active. Click the page without triggering it."
        : "Inspector active. Click a rendered color in the page.",
      "success",
    );
  } catch (error) {
    clearInspectorUi();
    setStatus(error.message, "error");
  }
}

async function selectInspectedColor(candidates) {
  if (!activeTab?.id || !Array.isArray(candidates)) return;
  try {
    const store = await storeForTab(activeTab.id);
    let selected = null;
    let selectedCandidate = null;
    for (const candidate of candidates) {
      const canonical = colorAdapter.toCanonical(candidate.color);
      if (!canonical) continue;
      const matches = store.state.colorEntries.filter(
        (entry) => effectiveCanonical(entry, store.state) === canonical,
      );
      if (!matches.length) continue;
      selected = matches.sort((left, right) => {
        const leftProperty = left.occurrences.some(
          (occurrence) => occurrence.property === candidate.property,
        );
        const rightProperty = right.occurrences.some(
          (occurrence) => occurrence.property === candidate.property,
        );
        if (leftProperty !== rightProperty) return rightProperty - leftProperty;
        if ((left.type === "variable") !== (right.type === "variable")) {
          return left.type === "variable" ? -1 : 1;
        }
        return right.count - left.count;
      })[0];
      selectedCandidate = candidate;
      break;
    }

    for (const row of colorRows.values()) row.classList.remove("inspected");
    clearInspectorUi();
    if (!selected) {
      setStatus("The rendered color is not present in the editable CSS sources.", "error");
      return;
    }
    const row = colorRows.get(selected.id);
    row?.classList.add("inspected");
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
    setStatus(
      `Selected ${selectedCandidate.property}: ${selectedCandidate.color}`,
      "success",
    );
  } catch (error) {
    clearInspectorUi();
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
  stopInspectorForTab(activeTab?.id);
  try {
    await request(MESSAGE_TYPES.DETACH_REQUEST);
    if (activeTab?.id) {
      tabStores.delete(activeTab.id);
      selectedSourceIds.delete(activeTab.id);
    }
    await renderSession(null, activeTab);
  } catch (error) {
    setStatus(error.message, "error");
  } finally {
    setBusy(false);
  }
});

elements.inspect.addEventListener("click", () => toggleInspector("inspect"));
elements.frozenInspect.addEventListener("click", () =>
  toggleInspector("frozen"),
);

elements.reset.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  const store = await storeForTab(activeTab.id);
  store.state.replacements.clear();
  store.state.alphaOverrides.clear();
  await chrome.storage.session.remove(editStorageKey(activeTab.id));
  renderColors(activeTab.id, store);
  await applyStore(store);
});

elements.exportCss.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  const store = await storeForTab(activeTab.id);
  const blob = new Blob([store.sourceStore.getCombinedCss(true)], {
    type: "text/css",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  let hostname = "current-tab";
  try {
    hostname = new URL(activeTab.url).hostname || hostname;
  } catch {
    // Keep the generic filename.
  }
  anchor.href = url;
  anchor.download = `colortweaker-${hostname}.css`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

elements.sourceSelect.addEventListener("change", async () => {
  if (!activeTab?.id) return;
  selectedSourceIds.set(activeTab.id, elements.sourceSelect.value);
  loadSelectedSource(activeTab.id, await storeForTab(activeTab.id));
});

elements.reloadSource.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  loadSelectedSource(activeTab.id, await storeForTab(activeTab.id));
});

elements.applySource.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  try {
    const store = await storeForTab(activeTab.id);
    const source = store.state.cssSources.find(
      (item) => item.id === selectedSourceIds.get(activeTab.id),
    );
    if (!source) return;
    source.text = elements.sourceEditor.value;
    store.sourceStore.rebuildColorEntries();
    renderColors(activeTab.id, store);
    renderSources(activeTab.id, store);
    elements.colorCount.textContent = String(store.state.colorEntries.length);
    await applyStore(store);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.sourceEditor.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault();
  const start = elements.sourceEditor.selectionStart;
  const end = elements.sourceEditor.selectionEnd;
  elements.sourceEditor.setRangeText("  ", start, end, "end");
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
  if (isColorTweakerMessage(message, MESSAGE_TYPES.INSPECT_RESULT)) {
    if (message.tabId === activeTab?.id) selectInspectedColor(message.candidates);
    return;
  }
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

updateInspectorButtons();
loadActiveSession();

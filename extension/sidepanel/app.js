import { createBrowserColorAdapter } from "../shared/browser-color.js";
import { createCssParser } from "../shared/css-parser.js";
import { createCssSourceStore } from "../shared/css-sources.js";
import { createColorTweakerState } from "../shared/state.js";
import {
  MESSAGE_TYPES,
  createMessage,
  isColorTweakerMessage,
} from "../shared/messages.js";

const SANDBOX_TYPES = Object.freeze({
  HOST_READY: "ct:build-preview-host-ready",
  CLEAR: "ct:build-preview-clear",
  READY: "ct:sandbox-ready",
  LOAD: "ct:sandbox-load-build",
  LOADED: "ct:build-loaded",
  ERROR: "ct:build-error",
  WARNING: "ct:build-warning",
  SOURCES: "ct:build-sources",
  APPLY: "ct:build-apply-updates",
  INSPECT: "ct:build-inspector",
  INSPECT_RESULT: "ct:build-inspect-result",
});

const colorAdapter = createBrowserColorAdapter(document);
const parser = createCssParser(colorAdapter);
const tabStores = new Map();
const selectedSourceIds = new Map();
const colorRows = new Map();
let activeMode = "tab";
let activeTab = null;
let activeSession = null;
let inspectorMode = "off";
let renderSequence = 0;
let applyTimer = null;
const buildPreviewSessionId = crypto.randomUUID();
const buildPreviewChannel = new BroadcastChannel(
  `ct-build-preview:${buildPreviewSessionId}`,
);
const previewReadyWaiters = new Set();
let previewReady = false;
let previewTabId = null;
let previewHostInstanceId = null;
let previewReloading = false;
let buildLoaded = false;
let buildFiles = [];
let buildName = "uploaded-build";
const buildSourceOverrides = new Map();
let buildRequestSequence = 0;
let activeBuildRequestId = null;

const elements = {
  modeTab: document.getElementById("mode-tab"),
  modeBuild: document.getElementById("mode-build"),
  tabPanel: document.getElementById("tab-panel"),
  buildPanel: document.getElementById("build-panel"),
  buildDropZone: document.getElementById("build-drop-zone"),
  buildFilesInput: document.getElementById("build-files-input"),
  buildFileSummary: document.getElementById("build-file-summary"),
  clearBuild: document.getElementById("clear-build"),
  showBuildPreview: document.getElementById("show-build-preview"),
  loadBuild: document.getElementById("load-build"),
  buildStatus: document.getElementById("build-status"),
  tabTitle: document.getElementById("tab-title"),
  tabUrl: document.getElementById("tab-url"),
  attach: document.getElementById("attach"),
  refresh: document.getElementById("refresh"),
  detach: document.getElementById("detach"),
  status: document.getElementById("status"),
  grantAccess: document.getElementById("grant-access"),
  remoteFailures: document.getElementById("remote-failures"),
  remoteFailureList: document.getElementById("remote-failure-list"),
  scanSummary: document.getElementById("scan-summary"),
  colorsPanel: document.getElementById("colors-panel"),
  sourcesPanel: document.getElementById("sources-panel"),
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

function createStore(scope, tabId = null) {
  const state = createColorTweakerState({ cssMode: scope });
  const sourceStore = createCssSourceStore({
    state,
    buildColorEntries: parser.buildColorEntries,
    extractAlpha: colorAdapter.extractAlpha,
    hexToRgba: colorAdapter.hexToRgba,
  });
  return { scope, tabId, state, sourceStore };
}

const buildStore = createStore("build");

function editStorageKey(tabId) {
  return `colorTweakerEdits:${tabId}`;
}

async function createTabStore(tabId) {
  const store = createStore("tab", tabId);
  const saved = await chrome.storage.session.get(editStorageKey(tabId));
  const edits = saved[editStorageKey(tabId)] || {};
  for (const [entryId, value] of Object.entries(edits.replacements || {})) {
    store.state.replacements.set(entryId, value);
  }
  for (const [entryId, value] of Object.entries(edits.alphaOverrides || {})) {
    store.state.alphaOverrides.set(entryId, value);
  }
  return store;
}

async function storeForTab(tabId) {
  if (!tabStores.has(tabId)) tabStores.set(tabId, createTabStore(tabId));
  return tabStores.get(tabId);
}

async function activeStore() {
  if (activeMode === "build") return buildLoaded ? buildStore : null;
  return activeTab?.id ? storeForTab(activeTab.id) : null;
}

function storeKey(store) {
  return store.scope === "build" ? "build" : `tab:${store.tabId}`;
}

function storeIsEditable(store) {
  if (!store) return false;
  if (store.scope === "build") {
    return activeMode === "build" && buildLoaded && previewReady;
  }
  return (
    activeMode === "tab" &&
    activeSession?.connected &&
    activeSession.tabId === store.tabId &&
    activeTab?.id === store.tabId
  );
}

async function persistStoreEdits(store) {
  if (store.scope !== "tab") return;
  await chrome.storage.session.set({
    [editStorageKey(store.tabId)]: {
      replacements: Object.fromEntries(store.state.replacements),
      alphaOverrides: Object.fromEntries(store.state.alphaOverrides),
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

function setElementStatus(element, message, kind = "") {
  element.textContent = message;
  element.className = `status${kind ? ` ${kind}` : ""}`;
}

function setTabStatus(message, kind = "") {
  setElementStatus(elements.status, message, kind);
}

function setBuildStatus(message, kind = "") {
  setElementStatus(elements.buildStatus, message, kind);
}

function setStatus(message, kind = "") {
  if (activeMode === "build") setBuildStatus(message, kind);
  else setTabStatus(message, kind);
}

function setTabBusy(busy) {
  elements.attach.disabled = busy || Boolean(activeSession?.connected);
  elements.refresh.disabled = busy || !activeSession?.connected;
  elements.detach.disabled = busy || !activeSession?.desiredAttached;
}

function setEditingControls(enabled) {
  elements.inspect.disabled = !enabled;
  elements.frozenInspect.disabled = !enabled;
  elements.exportCss.disabled = !enabled;
  elements.reset.disabled = !enabled;
}

function updateInspectorButtons() {
  const inspecting = inspectorMode === "inspect";
  const frozen = inspectorMode === "frozen";
  elements.inspect.classList.toggle("active", inspecting);
  elements.inspect.setAttribute("aria-pressed", String(inspecting));
  elements.inspect.setAttribute(
    "aria-label",
    inspecting ? "Stop inspecting colors" : "Inspect a rendered element's colors",
  );
  elements.inspect.dataset.tooltip = inspecting
    ? "Stop inspecting colors"
    : "Inspect a rendered element's colors";
  elements.frozenInspect.classList.toggle("active", frozen);
  elements.frozenInspect.setAttribute("aria-pressed", String(frozen));
  elements.frozenInspect.setAttribute(
    "aria-label",
    frozen
      ? "Stop frozen inspection"
      : "Inspect without normal page interaction",
  );
  elements.frozenInspect.dataset.tooltip = frozen
    ? "Stop frozen inspection"
    : "Inspect without normal page interaction";
}

function clearInspectorUi() {
  inspectorMode = "off";
  updateInspectorButtons();
}

function postToBuildPreview(type, payload = {}) {
  if (!previewReady) throw new Error("The build preview tab is not ready.");
  buildPreviewChannel.postMessage({ type, ...payload });
}

function markPreviewReady() {
  previewReady = true;
  elements.showBuildPreview.disabled = false;
  for (const resolve of previewReadyWaiters) resolve();
  previewReadyWaiters.clear();
}

function waitForPreviewReady(timeout = 10000) {
  if (previewReady) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      previewReadyWaiters.delete(ready);
      reject(new Error("The build preview tab did not become ready."));
    }, timeout);
    const ready = () => {
      clearTimeout(timer);
      resolve();
    };
    previewReadyWaiters.add(ready);
  });
}

async function ensureBuildPreviewTab(activate = true) {
  if (previewTabId !== null) {
    try {
      await chrome.tabs.update(previewTabId, { active: activate });
      if (previewReady) return;
    } catch {
      previewTabId = null;
      previewReady = false;
    }
  }
  if (previewTabId === null) {
    previewReady = false;
    const url = chrome.runtime.getURL(
      `build-preview/index.html?session=${encodeURIComponent(buildPreviewSessionId)}`,
    );
    const tab = await chrome.tabs.create({ url, active: activate });
    previewTabId = tab.id ?? null;
  }
  await waitForPreviewReady();
}

function stopCurrentInspector() {
  if (inspectorMode === "off") return;
  if (activeMode === "build") {
    if (previewReady) {
      postToBuildPreview(SANDBOX_TYPES.INSPECT, { mode: "off" });
    }
  } else if (Number.isInteger(activeTab?.id)) {
    request(MESSAGE_TYPES.INSPECT_STOP, { tabId: activeTab.id }).catch(() => {});
  }
  clearInspectorUi();
}

function stopInspectorForTab(tabId) {
  if (
    activeMode !== "tab" ||
    inspectorMode === "off" ||
    !Number.isInteger(tabId)
  ) {
    return;
  }
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
      // Invalid stylesheet URLs remain visible in the skipped count.
    }
  }
  return Array.from(patterns);
}

function pageAccessPattern(urlString) {
  try {
    const url = new URL(urlString);
    if (/^https?:$/.test(url.protocol)) return `${url.origin}/*`;
    if (url.protocol === "file:") return "file:///*";
  } catch {
    // The background worker will report unsupported or malformed tab URLs.
  }
  return null;
}

async function requestPageAccess(urlString) {
  const pattern = pageAccessPattern(urlString);
  if (!pattern) return;
  const granted = await chrome.permissions.request({ origins: [pattern] });
  if (!granted) {
    throw new Error("Site access is required before ColorTweaker can attach to this tab.");
  }
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

async function resetEntry(store, entryId) {
  store.state.replacements.delete(entryId);
  store.state.alphaOverrides.delete(entryId);
  await persistStoreEdits(store);
  renderColors(store);
  scheduleApply(store);
}

function renderColors(store) {
  const { state } = store;
  const editable = storeIsEditable(store);
  colorRows.clear();
  elements.colorList.replaceChildren();
  elements.colorList.classList.toggle("empty", !state.colorEntries.length);
  if (!state.colorEntries.length) {
    elements.colorList.textContent = storeIsEditable(store)
      ? "No editable colors were found."
      : activeMode === "build"
        ? "Load a production build to scan its colors."
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
    colorInput.disabled = !editable;
    colorInput.setAttribute("aria-label", `Change ${entry.name || entry.hex6}`);
    colorInput.value = state.replacements.get(entry.id) || entry.hex6;

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
      !editable ||
      (!state.replacements.has(entry.id) &&
        !state.alphaOverrides.has(entry.id));

    colorInput.addEventListener("input", () => {
      state.replacements.set(entry.id, colorInput.value);
      reset.disabled = false;
      persistStoreEdits(store).catch(() => {});
      scheduleApply(store);
    });
    reset.addEventListener("click", () => {
      resetEntry(store, entry.id).catch((error) => {
        setStatus(error.message, "error");
      });
    });

    const alpha = document.createElement("label");
    alpha.className = "alpha-control";
    const alphaLabel = document.createElement("span");
    alphaLabel.textContent = "Alpha";
    const alphaInput = document.createElement("input");
    alphaInput.type = "range";
    alphaInput.disabled = !editable;
    alphaInput.min = "0";
    alphaInput.max = "100";
    alphaInput.step = "1";
    alphaInput.value = String(Math.round(entryAlpha(entry, state) * 100));
    const alphaOutput = document.createElement("output");
    alphaOutput.textContent = `${alphaInput.value}%`;
    alphaInput.addEventListener("input", () => {
      state.alphaOverrides.set(entry.id, Number(alphaInput.value) / 100);
      if (!state.replacements.has(entry.id)) {
        state.replacements.set(entry.id, entry.hex6);
      }
      alphaOutput.textContent = `${alphaInput.value}%`;
      reset.disabled = false;
      persistStoreEdits(store).catch(() => {});
      scheduleApply(store);
    });
    alpha.append(alphaLabel, alphaInput, alphaOutput);

    row.append(colorInput, copy, reset, alpha);
    elements.colorList.append(row);
  }
}

function renderRemoteFailures(snapshot) {
  const failures = snapshot?.remoteFailures || [];
  elements.remoteFailures.hidden = activeMode !== "tab" || !failures.length;
  elements.remoteFailureList.replaceChildren();
  for (const failure of failures) {
    const item = document.createElement("div");
    item.className = "remote-failure";
    item.textContent = `${failure.href}: ${failure.error}`;
    elements.remoteFailureList.append(item);
  }
}

function loadSelectedSource(store) {
  const key = storeKey(store);
  const selectedId = selectedSourceIds.get(key);
  const source = store.state.cssSources.find((item) => item.id === selectedId);
  elements.sourceEditor.value = source?.text || "";
  const enabled = Boolean(source) && storeIsEditable(store);
  elements.sourceEditor.disabled = !enabled;
  elements.reloadSource.disabled = !enabled;
  elements.applySource.disabled = !enabled;
}

function renderSources(store) {
  const sources = store.state.cssSources;
  const key = storeKey(store);
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

  let selectedId = selectedSourceIds.get(key);
  if (!sources.some((source) => source.id === selectedId)) {
    selectedId = sources[0]?.id || null;
    if (selectedId) selectedSourceIds.set(key, selectedId);
    else selectedSourceIds.delete(key);
  }
  elements.sourceSelect.disabled = !sources.length || !storeIsEditable(store);
  if (selectedId) elements.sourceSelect.value = selectedId;
  loadSelectedSource(store);
}

function clearEditor(message) {
  colorRows.clear();
  elements.sourceList.replaceChildren();
  elements.sourceSelect.replaceChildren();
  elements.sourceSelect.disabled = true;
  elements.sourceEditor.value = "";
  elements.sourceEditor.disabled = true;
  elements.reloadSource.disabled = true;
  elements.applySource.disabled = true;
  elements.colorList.className = "color-list empty";
  elements.colorList.textContent = message;
  elements.sourceCount.textContent = "0";
  elements.colorCount.textContent = "0";
  elements.skippedCount.textContent = "0";
  setEditingControls(false);
  setResultsVisibility();
}

function setResultsVisibility(store = null, skipped = 0) {
  const sourceCount = store?.state.cssSources.length || 0;
  const colorCount = store?.state.colorEntries.length || 0;
  elements.scanSummary.hidden = sourceCount === 0 && colorCount === 0 && skipped === 0;
  elements.colorsPanel.hidden = colorCount === 0;
  elements.sourcesPanel.hidden = sourceCount === 0;
}

async function applyStore(store) {
  if (!storeIsEditable(store)) return;
  try {
    const updates = store.sourceStore.getCssSourceUpdates();
    if (store.scope === "build") {
      postToBuildPreview(SANDBOX_TYPES.APPLY, { updates });
      setBuildStatus("Changes applied to the uploaded build.", "success");
      return;
    }
    const response = await request(MESSAGE_TYPES.APPLY_SOURCE_UPDATES, {
      updates,
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
    setTabStatus("Changes applied to the current tab.", "success");
  } catch (error) {
    setStatus(error.message, "error");
  }
}

function scheduleApply(store) {
  clearTimeout(applyTimer);
  applyTimer = setTimeout(() => applyStore(store), 60);
}

async function reconcileSnapshot(tabId, snapshot, render = true) {
  const store = await storeForTab(tabId);
  store.state.cssSources = [];
  for (const source of snapshot?.sources || []) {
    store.sourceStore.registerCssSource(source);
  }
  store.sourceStore.rebuildColorEntries();
  if (render && activeMode === "tab") {
    renderColors(store);
    renderSources(store);
    renderRemoteFailures(snapshot);
    elements.colorCount.textContent = String(store.state.colorEntries.length);
  }
  if (store.state.replacements.size && activeMode === "tab") scheduleApply(store);
  return store;
}

function reconcileBuildSources(sources) {
  buildStore.state.cssSources = [];
  for (const source of sources || []) {
    const registered = buildStore.sourceStore.registerCssSource(source);
    if (buildSourceOverrides.has(registered.id)) {
      registered.text = buildSourceOverrides.get(registered.id);
    }
  }
  buildStore.sourceStore.rebuildColorEntries();
  buildLoaded = true;
  if (activeMode === "build") renderBuildState();
  if (buildStore.state.replacements.size) scheduleApply(buildStore);
}

async function renderSession(session, tab = null) {
  const sequence = ++renderSequence;
  const incomingTabId = tab?.id || session?.tabId || null;
  if (
    activeMode === "tab" &&
    activeTab?.id &&
    incomingTabId &&
    activeTab.id !== incomingTabId
  ) {
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

  elements.tabTitle.textContent = activeTab?.title || session?.title || "Active tab";
  elements.tabUrl.textContent = activeTab?.url || session?.url || "";
  elements.attach.textContent = session?.needsReattach ? "Reattach" : "Attach";
  elements.attach.disabled = Boolean(session?.connected);
  elements.refresh.disabled = !session?.connected;
  elements.detach.disabled = !session?.desiredAttached;

  const snapshot = session?.snapshot;
  let store = null;
  if (session?.tabId && snapshot) {
    store = await reconcileSnapshot(session.tabId, snapshot, activeMode === "tab");
  }
  if (sequence !== renderSequence || activeMode !== "tab") return;

  setResultsVisibility(store, snapshot?.skipped || 0);

  if (!session?.connected) clearInspectorUi();
  setEditingControls(Boolean(session?.connected));
  elements.sourceCount.textContent = String(
    snapshot?.sources?.length ?? session?.sourceCount ?? 0,
  );
  elements.skippedCount.textContent = String(
    snapshot?.skipped ?? session?.skipped ?? 0,
  );

  if (session?.connected) {
    setTabStatus("Attached. Runtime stylesheet changes are being watched.", "success");
  } else if (session?.error) {
    setTabStatus(session.error, "error");
  } else {
    setTabStatus("Not attached.");
  }

  const patterns = originPatterns(snapshot?.unreadableStylesheets);
  elements.grantAccess.hidden = !patterns.length;
  elements.grantAccess.dataset.origins = JSON.stringify(patterns);
  elements.grantAccess.textContent = patterns.length
    ? `Allow access to ${patterns.length} stylesheet origin${patterns.length === 1 ? "" : "s"}`
    : "";

  if (!session?.tabId || !snapshot) {
    renderRemoteFailures(null);
    clearEditor(
      session?.desiredAttached
        ? "Waiting for the page to reconnect."
        : "Attach to a page to scan its colors.",
    );
  }
}

function renderBuildState() {
  elements.remoteFailures.hidden = true;
  elements.grantAccess.hidden = true;
  if (!buildLoaded) {
    clearEditor("Load a production build to scan its colors.");
    return;
  }
  setEditingControls(previewReady);
  renderColors(buildStore);
  renderSources(buildStore);
  elements.sourceCount.textContent = String(buildStore.state.cssSources.length);
  elements.colorCount.textContent = String(buildStore.state.colorEntries.length);
  elements.skippedCount.textContent = "0";
  setResultsVisibility(buildStore);
}

async function loadActiveSession() {
  try {
    const response = await request(MESSAGE_TYPES.GET_ACTIVE_SESSION);
    await renderSession(response.session, response.tab);
  } catch (error) {
    setTabStatus(error.message, "error");
  }
}

async function setMode(mode) {
  if (mode === activeMode) return;
  stopCurrentInspector();
  activeMode = mode;
  elements.modeTab.classList.toggle("active", mode === "tab");
  elements.modeTab.setAttribute("aria-pressed", String(mode === "tab"));
  elements.modeBuild.classList.toggle("active", mode === "build");
  elements.modeBuild.setAttribute("aria-pressed", String(mode === "build"));
  elements.tabPanel.hidden = mode !== "tab";
  elements.buildPanel.hidden = mode !== "build";
  if (mode === "build") renderBuildState();
  else await renderSession(activeSession, activeTab);
}

async function toggleInspector(mode) {
  const store = await activeStore();
  if (!storeIsEditable(store)) return;
  try {
    const nextMode = inspectorMode === mode ? "off" : mode;
    if (activeMode === "build") {
      postToBuildPreview(SANDBOX_TYPES.INSPECT, { mode: nextMode });
    } else if (nextMode === "off") {
      await request(MESSAGE_TYPES.INSPECT_STOP);
    } else {
      await request(MESSAGE_TYPES.INSPECT_START, { mode: nextMode });
    }
    inspectorMode = nextMode;
    updateInspectorButtons();
    setStatus(
      nextMode === "off"
        ? "Inspector stopped."
        : nextMode === "frozen"
          ? "Frozen inspector active. Click the preview without triggering it."
          : "Inspector active. Click a rendered color in the preview.",
      nextMode === "off" ? "" : "success",
    );
  } catch (error) {
    clearInspectorUi();
    setStatus(error.message, "error");
  }
}

async function selectInspectedColor(candidates) {
  const store = await activeStore();
  if (!store || !Array.isArray(candidates)) return;
  try {
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

function normalizeSelectedFiles(records) {
  const normalized = records
    .map(({ file, path }) => ({
      file,
      path: String(path || file.webkitRelativePath || file.name).replace(/\\/g, "/"),
    }))
    .filter(({ path }) => path && !path.endsWith("/"));
  const firstSegments = normalized.map(({ path }) => path.split("/")[0]);
  const commonRoot =
    firstSegments.length && firstSegments.every((segment) => segment === firstSegments[0])
      ? firstSegments[0]
      : "";
  buildName = commonRoot || "uploaded-build";
  return normalized.map(({ file, path }) => ({
    file,
    path: commonRoot && path.includes("/") ? path.substring(commonRoot.length + 1) : path,
  }));
}

function setBuildFiles(records) {
  buildFiles = normalizeSelectedFiles(records);
  const htmlCount = buildFiles.filter(({ path }) => /\.html?$/i.test(path)).length;
  elements.buildFileSummary.textContent = buildFiles.length
    ? `${buildFiles.length} files selected · ${htmlCount} HTML entr${htmlCount === 1 ? "y" : "ies"}`
    : "No build selected.";
  elements.loadBuild.disabled = !buildFiles.length;
  elements.clearBuild.disabled = !buildFiles.length && !buildLoaded;
  elements.showBuildPreview.disabled =
    previewTabId === null && (!buildLoaded || !buildFiles.length);
}

function readAllDirectoryEntries(reader) {
  return new Promise((resolve, reject) => {
    const entries = [];
    const readBatch = () => {
      reader.readEntries((batch) => {
        if (!batch.length) resolve(entries);
        else {
          entries.push(...batch);
          readBatch();
        }
      }, reject);
    };
    readBatch();
  });
}

async function collectDroppedEntry(entry, prefix = "") {
  if (entry.isFile) {
    const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
    return [{ file, path: `${prefix}${entry.name}` }];
  }
  if (!entry.isDirectory) return [];
  const children = await readAllDirectoryEntries(entry.createReader());
  const nested = await Promise.all(
    children.map((child) => collectDroppedEntry(child, `${prefix}${entry.name}/`)),
  );
  return nested.flat();
}

async function droppedFiles(dataTransfer) {
  const entries = Array.from(dataTransfer.items || [])
    .map((item) => item.webkitGetAsEntry?.())
    .filter(Boolean);
  if (!entries.length) {
    return Array.from(dataTransfer.files || []).map((file) => ({ file, path: file.name }));
  }
  return (await Promise.all(entries.map((entry) => collectDroppedEntry(entry)))).flat();
}

async function loadSelectedBuild({ preserveEdits = false } = {}) {
  if (!buildFiles.length) return;
  elements.loadBuild.disabled = true;
  buildLoaded = false;
  if (preserveEdits) {
    buildStore.state.cssMode = "build";
    buildStore.state.cssSources = [];
    buildStore.state.colorEntries = [];
  } else {
    buildStore.sourceStore.resetCssSources("build");
    buildSourceOverrides.clear();
  }
  selectedSourceIds.delete("build");
  renderBuildState();
  setBuildStatus("Opening the dedicated build preview tab…");
  try {
    await ensureBuildPreviewTab(true);
    setBuildStatus("Reading build files…");
    const files = await Promise.all(
      buildFiles.map(async ({ file, path }) => ({
        path,
        type: file.type,
        buffer: await file.arrayBuffer(),
      })),
    );
    const requestId = ++buildRequestSequence;
    activeBuildRequestId = requestId;
    setBuildStatus("Rewriting assets and starting the sandboxed build…");
    postToBuildPreview(SANDBOX_TYPES.LOAD, { requestId, files });
  } catch (error) {
    setBuildStatus(error.message, "error");
    elements.loadBuild.disabled = false;
  }
}

function clearBuild() {
  if (activeMode === "build") stopCurrentInspector();
  activeBuildRequestId = null;
  buildLoaded = false;
  buildFiles = [];
  buildName = "uploaded-build";
  buildStore.sourceStore.resetCssSources("build");
  buildSourceOverrides.clear();
  selectedSourceIds.delete("build");
  elements.buildFilesInput.value = "";
  elements.buildFileSummary.textContent = "No build selected.";
  elements.loadBuild.disabled = true;
  elements.clearBuild.disabled = true;
  elements.showBuildPreview.disabled = previewTabId === null;
  setBuildStatus("");
  if (previewReady) postToBuildPreview(SANDBOX_TYPES.CLEAR);
  if (activeMode === "build") renderBuildState();
}

async function showBuildPreview() {
  const reloadBuild = previewTabId === null && buildLoaded && buildFiles.length;
  try {
    await ensureBuildPreviewTab(true);
    if (reloadBuild) await loadSelectedBuild({ preserveEdits: true });
  } catch (error) {
    setBuildStatus(error.message, "error");
  }
}

elements.modeTab.addEventListener("click", () => setMode("tab"));
elements.modeBuild.addEventListener("click", () => setMode("build"));

for (const helpTip of document.querySelectorAll(".help-tip")) {
  helpTip.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  helpTip.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
  });
}

elements.buildFilesInput.addEventListener("change", () => {
  setBuildFiles(
    Array.from(elements.buildFilesInput.files || []).map((file) => ({
      file,
      path: file.webkitRelativePath || file.name,
    })),
  );
});
elements.buildDropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  elements.buildDropZone.classList.add("over");
});
elements.buildDropZone.addEventListener("dragleave", () => {
  elements.buildDropZone.classList.remove("over");
});
elements.buildDropZone.addEventListener("drop", async (event) => {
  event.preventDefault();
  elements.buildDropZone.classList.remove("over");
  try {
    setBuildFiles(await droppedFiles(event.dataTransfer));
  } catch (error) {
    setBuildStatus(error.message, "error");
  }
});
elements.loadBuild.addEventListener("click", () => loadSelectedBuild());
elements.clearBuild.addEventListener("click", clearBuild);
elements.showBuildPreview.addEventListener("click", showBuildPreview);

elements.attach.addEventListener("click", async () => {
  setTabBusy(true);
  setTabStatus("Attaching to the current tab…");
  try {
    await requestPageAccess(activeTab?.url);
    const response = await request(MESSAGE_TYPES.ATTACH_REQUEST);
    await renderSession(response.session);
  } catch (error) {
    setTabStatus(error.message, "error");
  } finally {
    setTabBusy(false);
  }
});

elements.refresh.addEventListener("click", async () => {
  setTabBusy(true);
  setTabStatus("Scanning CSS sources…");
  try {
    const response = await request(MESSAGE_TYPES.SCAN_REQUEST);
    await renderSession(response.session);
  } catch (error) {
    setTabStatus(error.message, "error");
  } finally {
    setTabBusy(false);
  }
});

elements.detach.addEventListener("click", async () => {
  setTabBusy(true);
  stopInspectorForTab(activeTab?.id);
  try {
    await request(MESSAGE_TYPES.DETACH_REQUEST);
    if (activeTab?.id) {
      tabStores.delete(activeTab.id);
      selectedSourceIds.delete(`tab:${activeTab.id}`);
    }
    await renderSession(null, activeTab);
  } catch (error) {
    setTabStatus(error.message, "error");
  } finally {
    setTabBusy(false);
  }
});

elements.inspect.addEventListener("click", () => toggleInspector("inspect"));
elements.frozenInspect.addEventListener("click", () => toggleInspector("frozen"));

elements.reset.addEventListener("click", async () => {
  const store = await activeStore();
  if (!store) return;
  store.state.replacements.clear();
  store.state.alphaOverrides.clear();
  if (store.scope === "tab") {
    await chrome.storage.session.remove(editStorageKey(store.tabId));
  }
  renderColors(store);
  await applyStore(store);
});

elements.exportCss.addEventListener("click", async () => {
  const store = await activeStore();
  if (!store) return;
  const blob = new Blob([store.sourceStore.getCombinedCss(true)], {
    type: "text/css",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  let name = buildName;
  if (store.scope === "tab") {
    name = "current-tab";
    try {
      name = new URL(activeTab.url).hostname || name;
    } catch {
      // Keep the generic current-tab filename.
    }
  }
  anchor.href = url;
  anchor.download = `colortweaker-${name}.css`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
});

elements.sourceSelect.addEventListener("change", async () => {
  const store = await activeStore();
  if (!store) return;
  selectedSourceIds.set(storeKey(store), elements.sourceSelect.value);
  loadSelectedSource(store);
});

elements.reloadSource.addEventListener("click", async () => {
  const store = await activeStore();
  if (store) loadSelectedSource(store);
});

elements.applySource.addEventListener("click", async () => {
  const store = await activeStore();
  if (!store) return;
  try {
    const source = store.state.cssSources.find(
      (item) => item.id === selectedSourceIds.get(storeKey(store)),
    );
    if (!source) return;
    source.text = elements.sourceEditor.value;
    if (store.scope === "build") {
      buildSourceOverrides.set(source.id, source.text);
    }
    store.sourceStore.rebuildColorEntries();
    renderColors(store);
    renderSources(store);
    elements.colorCount.textContent = String(store.state.colorEntries.length);
    await applyStore(store);
  } catch (error) {
    setStatus(error.message, "error");
  }
});

elements.sourceEditor.addEventListener("keydown", (event) => {
  if (event.key !== "Tab") return;
  event.preventDefault();
  elements.sourceEditor.setRangeText(
    "  ",
    elements.sourceEditor.selectionStart,
    elements.sourceEditor.selectionEnd,
    "end",
  );
});

elements.grantAccess.addEventListener("click", async () => {
  const origins = JSON.parse(elements.grantAccess.dataset.origins || "[]");
  if (!origins.length) return;
  try {
    const granted = await chrome.permissions.request({ origins });
    if (!granted) {
      setTabStatus("Stylesheet access was not granted.", "error");
      return;
    }
    const response = await request(MESSAGE_TYPES.SCAN_REQUEST);
    await renderSession(response.session);
  } catch (error) {
    setTabStatus(error.message, "error");
  }
});

buildPreviewChannel.addEventListener("message", (event) => {
  if (!event.data?.type) return;
  if (
    event.data.type === SANDBOX_TYPES.HOST_READY ||
    event.data.type === SANDBOX_TYPES.READY
  ) {
    if (event.data.type === SANDBOX_TYPES.HOST_READY) {
      const replacedHost =
        previewHostInstanceId !== null &&
        previewHostInstanceId !== event.data.hostInstanceId;
      previewHostInstanceId = event.data.hostInstanceId || previewHostInstanceId;
      if (Number.isInteger(event.data.tabId)) previewTabId = event.data.tabId;
      markPreviewReady();
      if (replacedHost && buildLoaded && buildFiles.length && !previewReloading) {
        previewReloading = true;
        loadSelectedBuild({ preserveEdits: true }).finally(() => {
          previewReloading = false;
        });
      }
      return;
    }
    markPreviewReady();
    return;
  }
  if (event.data.requestId !== activeBuildRequestId) return;
  if (event.data.type === SANDBOX_TYPES.LOADED) {
    setBuildStatus(
      `Started ${event.data.entryPath}. Waiting for runtime CSS sources…`,
    );
    elements.clearBuild.disabled = false;
    return;
  }
  if (event.data.type === SANDBOX_TYPES.SOURCES) {
    reconcileBuildSources(event.data.sources);
    elements.loadBuild.disabled = false;
    elements.clearBuild.disabled = false;
    setBuildStatus(
      `Build loaded. Found ${buildStore.state.colorEntries.length} editable color${buildStore.state.colorEntries.length === 1 ? "" : "s"}.`,
      "success",
    );
    return;
  }
  if (event.data.type === SANDBOX_TYPES.INSPECT_RESULT) {
    if (activeMode === "build") selectInspectedColor(event.data.candidates);
    return;
  }
  if (event.data.type === SANDBOX_TYPES.WARNING) {
    setBuildStatus(event.data.message || "The build reported a runtime error.", "error");
    return;
  }
  if (event.data.type === SANDBOX_TYPES.ERROR) {
    buildLoaded = false;
    elements.loadBuild.disabled = false;
    setBuildStatus(event.data.error || "Unable to load the build.", "error");
    if (activeMode === "build") renderBuildState();
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId !== previewTabId) return;
  previewReady = false;
  previewTabId = null;
  previewHostInstanceId = null;
  clearInspectorUi();
  elements.showBuildPreview.disabled = !buildLoaded || !buildFiles.length;
  setBuildStatus(
    "The build preview tab was closed. Open it again to continue editing.",
    "error",
  );
  if (activeMode === "build") renderBuildState();
});

chrome.runtime.onMessage.addListener((message) => {
  if (isColorTweakerMessage(message, MESSAGE_TYPES.INSPECT_RESULT)) {
    if (activeMode === "tab" && message.tabId === activeTab?.id) {
      selectInspectedColor(message.candidates);
    }
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
    .catch((error) => setTabStatus(error.message, "error"));
});

updateInspectorButtons();
renderBuildState();
loadActiveSession();

// Iframe preview management, CSS source scanning, and source-aware patching.

import { state } from "./state.js";
import {
  getCombinedCss,
  getCssSourceUpdates,
  getFlattenedCss,
  processedSourceText,
  rebuildColorEntries,
  rebuildChangedColorEntries,
  registerCssSource,
  setEditorCss,
} from "./css-sources.js";

let iframeEl = null;
let currentBlobUrl = null;
let previewMode = "editor";
let siteMessageOrigin = "*";
let requestSequence = 0;
let inspectorActive = false;
let inspectorDocument = null;
let frozenInspectorActive = false;
let frozenInspectorOverlay = null;
let onColorsPicked = null;
let onCssSourcesChanged = null;
let runtimeObserver = null;
let scanTimer = null;
let applyingUpdates = false;
let pendingFullScan = false;
const pendingStyleSources = new Set();
const pendingInlineSources = new Set();
let runtimeSequence = 0;
const sheetIds = new WeakMap();
const remoteAppliedTexts = new Map();

const INSPECTED_COLOR_PROPERTIES = [
  "color",
  "background-color",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "outline-color",
  "text-decoration-color",
  "column-rule-color",
  "caret-color",
  "fill",
  "stroke",
];

const IFRAME_LISTENER = `
(function(){
  function bySource(attr,id){
    return Array.from(document.querySelectorAll('['+attr+']'))
      .find(function(el){return el.getAttribute(attr)===id;});
  }
  window.addEventListener('message',function(e){
    if(!e.data||e.data.type!=='ct-source-update')return;
    (e.data.updates||[]).forEach(function(update){
      var el=update.kind==='attribute'
        ?bySource('data-ct-inline-source',update.id)
        :bySource('data-ct-source',update.id);
      if(!el)return;
      if(update.kind==='attribute')el.setAttribute('style',update.text);
      else el.textContent=update.text;
    });
  });
})();`;

export function initPreview(iframe, callbacks = {}) {
  iframeEl = iframe;
  frozenInspectorOverlay = iframe.parentElement.querySelector(
    ".frozen-inspector-overlay",
  );
  onColorsPicked = callbacks.onColorsPicked || null;
  onCssSourcesChanged = callbacks.onCssSourcesChanged || null;
  iframeEl.addEventListener("load", handleIframeLoad);
  frozenInspectorOverlay?.addEventListener("click", handleFrozenInspectedClick);
  window.addEventListener("message", handleBridgeMessage);
}

export function isLoadedPreviewActive() {
  return previewMode === "url" || previewMode === "build";
}

function getIframeDocument() {
  return iframeEl?.contentDocument || null;
}

function handleBridgeMessage(event) {
  if (!iframeEl || event.source !== iframeEl.contentWindow || !event.data)
    return;
  if (event.data.type === "ct-colors-picked") {
    if (onColorsPicked) {
      onColorsPicked(event.data.candidates || event.data.colors || []);
    }
  } else if (event.data.type === "ct-css-sources-changed") {
    installRemoteSources(event.data.sources || []);
  } else if (event.data.type === "ct-css-source-changes") {
    applyRemoteSourceChanges(
      event.data.sources || [],
      event.data.removedIds || [],
    );
  }
}

function installRemoteSources(sources) {
  state.cssMode = "url";
  state.cssSources = [];
  state.colorEntries = [];
  remoteAppliedTexts.clear();
  for (const source of sources) {
    registerCssSource({ ...source, owner: null });
    remoteAppliedTexts.set(source.id, source.text || "");
  }
  rebuildColorEntries();
  if (onCssSourcesChanged) onCssSourcesChanged();
}

function colorEntriesSignature(entries = state.colorEntries) {
  return entries
    .map(
      (entry) =>
        `${entry.id}|${entry.type}|${entry.count}|${Array.from(entry.originals).sort().join(",")}|${Array.from(entry.sourceIds).sort().join(",")}`,
    )
    .join("\n");
}

function applyRemoteSourceChanges(sources, removedIds) {
  const changedIds = new Set();
  for (const id of removedIds) {
    const index = state.cssSources.findIndex((source) => source.id === id);
    if (index < 0) continue;
    state.cssSources.splice(index, 1);
    remoteAppliedTexts.delete(id);
    changedIds.add(id);
  }
  for (const source of sources) {
    const existing = state.cssSources.find((item) => item.id === source.id);
    if (
      existing &&
      existing.text === source.text &&
      existing.name === (source.name || source.id) &&
      existing.kind === (source.kind || "inline") &&
      existing.href === (source.href || null) &&
      existing.order === (source.order ?? existing.order)
    ) {
      continue;
    }
    registerCssSource({ ...source, owner: null });
    remoteAppliedTexts.set(source.id, source.text || "");
    changedIds.add(source.id);
  }
  if (!changedIds.size) return;
  const before = colorEntriesSignature();
  rebuildChangedColorEntries(changedIds);
  if (onCssSourcesChanged) {
    onCssSourcesChanged(before !== colorEntriesSignature());
  }
}

function pointHitsText(element, clientX, clientY) {
  const doc = element.ownerDocument;
  let node = null;
  let offset = 0;
  if (doc.caretPositionFromPoint) {
    const position = doc.caretPositionFromPoint(clientX, clientY);
    node = position?.offsetNode;
    offset = position?.offset ?? 0;
  } else if (doc.caretRangeFromPoint) {
    const caretRange = doc.caretRangeFromPoint(clientX, clientY);
    node = caretRange?.startContainer;
    offset = caretRange?.startOffset ?? 0;
  }
  if (!node || node.nodeType !== 3 || !element.contains(node)) return false;

  const text = node.textContent || "";
  for (const index of [offset, offset - 1]) {
    if (index < 0 || index >= text.length || !text[index].trim()) continue;
    const range = doc.createRange();
    range.setStart(node, index);
    range.setEnd(node, index + 1);
    const hit = Array.from(range.getClientRects()).some(
      (rect) =>
        clientX >= rect.left &&
        clientX <= rect.right &&
        clientY >= rect.top &&
        clientY <= rect.bottom,
    );
    if (hit) return true;
  }
  return false;
}

function borderPropertiesAtPoint(element, computed, clientX, clientY) {
  const rect = element.getBoundingClientRect();
  const sides = [
    [
      "border-top-color",
      "border-top-width",
      "border-top-style",
      clientY - rect.top,
    ],
    [
      "border-right-color",
      "border-right-width",
      "border-right-style",
      rect.right - clientX,
    ],
    [
      "border-bottom-color",
      "border-bottom-width",
      "border-bottom-style",
      rect.bottom - clientY,
    ],
    [
      "border-left-color",
      "border-left-width",
      "border-left-style",
      clientX - rect.left,
    ],
  ];
  return sides
    .filter(([, widthProperty, styleProperty, distance]) => {
      const width = parseFloat(computed.getPropertyValue(widthProperty));
      const style = computed.getPropertyValue(styleProperty);
      return (
        width > 0 &&
        style !== "none" &&
        style !== "hidden" &&
        distance >= 0 &&
        distance <= width
      );
    })
    .sort((a, b) => a[3] - b[3])
    .map(([property]) => property);
}

function isRenderedColorProperty(element, computed, property) {
  if (property.startsWith("border-") && property.endsWith("-color")) {
    const side = property.slice(7, -6);
    return (
      parseFloat(computed.getPropertyValue(`border-${side}-width`)) > 0 &&
      !["none", "hidden"].includes(
        computed.getPropertyValue(`border-${side}-style`),
      )
    );
  }
  if (property === "outline-color") {
    return (
      parseFloat(computed.getPropertyValue("outline-width")) > 0 &&
      computed.getPropertyValue("outline-style") !== "none"
    );
  }
  if (property === "text-decoration-color") {
    return computed.getPropertyValue("text-decoration-line") !== "none";
  }
  if (property === "column-rule-color") {
    return (
      parseFloat(computed.getPropertyValue("column-rule-width")) > 0 &&
      computed.getPropertyValue("column-rule-style") !== "none"
    );
  }
  if (property === "caret-color") {
    return element.matches("input, textarea, [contenteditable]");
  }
  if (property === "fill" || property === "stroke") {
    return element.namespaceURI === "http://www.w3.org/2000/svg";
  }
  return true;
}

function collectElementColors(element, clientX, clientY) {
  const view = element.ownerDocument.defaultView;
  const computed = view.getComputedStyle(element);
  const computedStyles = new WeakMap([[element, computed]]);
  const getComputed = (owner) => {
    if (!computedStyles.has(owner)) {
      computedStyles.set(owner, view.getComputedStyle(owner));
    }
    return computedStyles.get(owner);
  };
  const isSvg = element.namespaceURI === "http://www.w3.org/2000/svg";
  const candidates = [];
  const seen = new Set();
  const addCandidate = (owner, property) => {
    const ownerComputed = getComputed(owner);
    if (!isRenderedColorProperty(owner, ownerComputed, property)) return false;
    const value = ownerComputed.getPropertyValue(property).trim();
    if (
      value &&
      value !== "none" &&
      value !== "transparent" &&
      value !== "rgba(0, 0, 0, 0)"
    ) {
      const key = `${property}:${value}`;
      if (seen.has(key)) return true;
      seen.add(key);
      candidates.push({ property, color: value });
      return true;
    }
    return false;
  };

  for (const property of borderPropertiesAtPoint(
    element,
    computed,
    clientX,
    clientY,
  )) {
    addCandidate(element, property);
  }
  if (isSvg) {
    addCandidate(element, "fill");
    addCandidate(element, "stroke");
  }

  const textHit = pointHitsText(element, clientX, clientY);
  if (textHit) addCandidate(element, "color");

  let backgroundOwner = element;
  while (backgroundOwner) {
    if (addCandidate(backgroundOwner, "background-color")) break;
    const root = backgroundOwner.getRootNode();
    backgroundOwner = backgroundOwner.parentElement || root.host || null;
  }

  if (!textHit) addCandidate(element, "color");
  for (const property of INSPECTED_COLOR_PROPERTIES) {
    addCandidate(element, property);
  }
  return candidates;
}

function handleInspectedClick(event) {
  if (!inspectorActive) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (onColorsPicked) {
    onColorsPicked(
      collectElementColors(event.target, event.clientX, event.clientY),
    );
  }
}

function handleFrozenInspectedClick(event) {
  if (!frozenInspectorActive || !iframeEl?.contentWindow) return;
  event.preventDefault();
  event.stopImmediatePropagation();

  const rect = iframeEl.getBoundingClientRect();
  const clientX = event.clientX - rect.left;
  const clientY = event.clientY - rect.top;
  const doc = getIframeDocument();
  if (doc) {
    const element = doc.elementFromPoint(clientX, clientY);
    if (element && onColorsPicked) {
      onColorsPicked(collectElementColors(element, clientX, clientY));
    }
    return;
  }

  iframeEl.contentWindow.postMessage(
    { type: "ct-inspect-point", x: clientX, y: clientY },
    siteMessageOrigin,
  );
}

function setInspectorCursor(doc, active) {
  let style = doc.getElementById("__ct-inspector");
  if (active && !style) {
    style = doc.createElement("style");
    style.id = "__ct-inspector";
    style.textContent = "*{cursor:crosshair!important}";
    (doc.head || doc.documentElement).appendChild(style);
  } else if (!active && style) {
    style.remove();
  }
}

function syncInspector() {
  if (inspectorDocument) {
    inspectorDocument.removeEventListener("click", handleInspectedClick, true);
    setInspectorCursor(inspectorDocument, false);
    inspectorDocument = null;
  }

  const doc = getIframeDocument();
  if (doc) {
    inspectorDocument = doc;
    if (inspectorActive) {
      doc.addEventListener("click", handleInspectedClick, true);
      setInspectorCursor(doc, true);
    }
    return;
  }
  iframeEl.contentWindow.postMessage(
    { type: "ct-inspect-mode", active: inspectorActive },
    siteMessageOrigin,
  );
}

export function setPreviewInspector(active) {
  inspectorActive = active;
  syncInspector();
}

export function setFrozenPreviewInspector(active) {
  frozenInspectorActive = active;
  if (frozenInspectorOverlay) frozenInspectorOverlay.hidden = !active;
}

export function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

function serializeStyleSheet(sheet, visited = new Set()) {
  if (!sheet || visited.has(sheet)) return { text: "", skipped: 0 };
  visited.add(sheet);
  const chunks = [];
  let skipped = 0;
  try {
    for (const rule of Array.from(sheet.cssRules)) {
      if (rule.type === 3 && rule.styleSheet) {
        const imported = serializeStyleSheet(rule.styleSheet, visited);
        let importedText = imported.text;
        if (rule.supportsText) {
          importedText = `@supports ${rule.supportsText}{\n${importedText}\n}`;
        }
        if (rule.media?.mediaText && rule.media.mediaText !== "all") {
          importedText = `@media ${rule.media.mediaText}{\n${importedText}\n}`;
        }
        if (rule.layerName !== undefined && rule.layerName !== null) {
          importedText = `@layer${rule.layerName ? ` ${rule.layerName}` : ""}{\n${importedText}\n}`;
        }
        chunks.push(importedText);
        skipped += imported.skipped;
      } else {
        chunks.push(rule.cssText);
      }
    }
  } catch (error) {
    skipped++;
  }
  return { text: chunks.filter(Boolean).join("\n"), skipped };
}

function ensureNodeSourceId(node, prefix) {
  const attribute =
    prefix === "attribute" ? "data-ct-inline-source" : "data-ct-source";
  let id = node.getAttribute(attribute);
  if (id) id = id.replace(/[^a-zA-Z0-9_.:-]+/g, "-");
  if (
    !id ||
    state.cssSources.some(
      (source) => source.id === id && source.owner && source.owner !== node,
    )
  ) {
    do {
      id = `${prefix}-${++runtimeSequence}`;
    } while (state.cssSources.some((source) => source.id === id));
  }
  node.setAttribute(attribute, id);
  return id;
}

function scanRoot(root, orderRef, result) {
  const query = (selector) => Array.from(root.querySelectorAll(selector));

  for (const style of query("style")) {
    if (
      style.id === "__ct-inspector" ||
      style.type === "importmap" ||
      style.dataset.ctManaged === "true"
    ) {
      continue;
    }
    const id = ensureNodeSourceId(style, "style");
    result.seen.add(id);
    const existing = state.cssSources.find((source) => source.id === id);
    const serialized = /@import\b/i.test(style.textContent)
      ? serializeStyleSheet(style.sheet)
      : null;
    result.skipped += serialized?.skipped || 0;
    const discoveredText = serialized?.text || style.textContent;
    const isAppliedText =
      existing?.lastAppliedText !== undefined &&
      existing.lastAppliedText === discoveredText;
    registerCssSource({
      id,
      name: style.dataset.ctName || id,
      kind: existing?.kind || "runtime",
      text:
        existing && state.replacements.size && isAppliedText
          ? existing.text
          : discoveredText,
      order: orderRef.value++,
      owner: style,
    });
  }

  for (const link of query('link[rel="stylesheet"]')) {
    const id = ensureNodeSourceId(link, "linked");
    const existing = state.cssSources.find((source) => source.id === id);
    const hrefChanged = existing?.href && existing.href !== link.href;
    if (hrefChanged && link.__ctPatch) {
      link.__ctPatch.remove();
      link.__ctPatch = null;
      link.disabled = false;
    }
    const serialized = serializeStyleSheet(link.sheet);
    result.skipped += serialized.skipped;
    result.seen.add(id);
    if (!serialized.text) {
      link.addEventListener("load", scheduleRuntimeScan, { once: true });
      continue;
    }
    registerCssSource({
      id,
      name: link.getAttribute("href") || id,
      kind: "linked",
      text:
        existing && !hrefChanged && (state.replacements.size || link.__ctPatch)
          ? existing.text
          : serialized.text,
      order: orderRef.value++,
      href: link.href,
      owner: link,
    });
  }

  for (const element of query("[style]")) {
    if (element.id === "__ct-inspector") continue;
    const id = ensureNodeSourceId(element, "attribute");
    result.seen.add(id);
    const existing = state.cssSources.find((source) => source.id === id);
    const text = element.getAttribute("style") || "";
    const isAppliedText =
      existing?.lastAppliedText !== undefined &&
      existing.lastAppliedText === text;
    registerCssSource({
      id,
      name: `${element.tagName.toLowerCase()}[style]`,
      kind: "attribute",
      text:
        existing && state.replacements.size && isAppliedText
          ? existing.text
          : text,
      order: orderRef.value++,
      owner: element,
    });
  }

  if (root.adoptedStyleSheets) {
    for (const sheet of root.adoptedStyleSheets) {
      let id = sheetIds.get(sheet);
      if (!id) {
        id = `adopted-${++runtimeSequence}`;
        sheetIds.set(sheet, id);
      }
      const serialized = serializeStyleSheet(sheet);
      result.skipped += serialized.skipped;
      if (!serialized.text) continue;
      result.seen.add(id);
      const existing = state.cssSources.find((source) => source.id === id);
      const isAppliedText =
        existing?.lastAppliedText !== undefined &&
        existing.lastAppliedText === serialized.text;
      registerCssSource({
        id,
        name: id,
        kind: "adopted",
        text:
          existing && state.replacements.size && isAppliedText
            ? existing.text
            : serialized.text,
        order: orderRef.value++,
        owner: sheet,
      });
    }
  }

  for (const element of query("*")) {
    if (element.shadowRoot) scanRoot(element.shadowRoot, orderRef, result);
  }
}

function scanDocumentSources(doc, notify = true) {
  const result = { skipped: 0, seen: new Set() };
  scanRoot(doc, { value: 0 }, result);
  state.cssSources = state.cssSources.filter((source) =>
    result.seen.has(source.id),
  );
  rebuildColorEntries();
  if (notify && onCssSourcesChanged) onCssSourcesChanged();
  return result;
}

function isTrackableStyle(element) {
  return (
    element?.nodeType === 1 &&
    element.tagName === "STYLE" &&
    element.id !== "__ct-inspector" &&
    element.type !== "importmap" &&
    element.dataset.ctManaged !== "true"
  );
}

function isStylesheetLink(element) {
  return (
    element?.nodeType === 1 &&
    element.tagName === "LINK" &&
    element.relList?.contains("stylesheet")
  );
}

function subtreeContainsCssSource(node) {
  if (node?.nodeType !== 1) return false;
  if (
    isTrackableStyle(node) ||
    isStylesheetLink(node) ||
    (node.hasAttribute("style") && node.id !== "__ct-inspector") ||
    node.shadowRoot
  ) {
    return true;
  }
  if (
    Array.from(node.querySelectorAll("style")).some(isTrackableStyle) ||
    node.querySelector('link[rel~="stylesheet"], [style]')
  ) {
    return true;
  }
  return Array.from(node.querySelectorAll("*")).some(
    (element) => element.shadowRoot,
  );
}

function scheduleRuntimeScan(records) {
  if (applyingUpdates) return;
  if (!Array.isArray(records)) {
    pendingFullScan = true;
  } else {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.attributeName === "href" && isStylesheetLink(record.target)) {
          pendingFullScan = true;
        } else if (
          record.attributeName === "style" &&
          record.target.id !== "__ct-inspector"
        ) {
          pendingInlineSources.add(record.target);
        }
        continue;
      }
      if (record.type !== "childList") continue;
      if (isTrackableStyle(record.target)) {
        pendingStyleSources.add(record.target);
        continue;
      }
      if (
        [...record.addedNodes, ...record.removedNodes].some(
          subtreeContainsCssSource,
        )
      ) {
        pendingFullScan = true;
      }
    }
  }
  if (
    !pendingFullScan &&
    !pendingStyleSources.size &&
    !pendingInlineSources.size
  ) {
    return;
  }
  window.clearTimeout(scanTimer);
  scanTimer = window.setTimeout(flushRuntimeMutations, 300);
}

function updateRuntimeStyleSource(style) {
  if (!style.isConnected || !isTrackableStyle(style)) return null;
  const id = ensureNodeSourceId(style, "style");
  const existing = state.cssSources.find((source) => source.id === id);
  const serialized = /@import\b/i.test(style.textContent)
    ? serializeStyleSheet(style.sheet)
    : null;
  const text = serialized?.text || style.textContent;
  if (
    existing &&
    (existing.text === text || existing.lastAppliedText === text)
  ) {
    return null;
  }
  if (existing) delete existing.lastAppliedText;
  registerCssSource({
    id,
    name: style.dataset.ctName || id,
    kind: existing?.kind || "runtime",
    text,
    order: existing?.order ?? state.cssSources.length,
    owner: style,
  });
  return id;
}

function updateRuntimeInlineSource(element) {
  const id = element.getAttribute("data-ct-inline-source");
  const existing =
    state.cssSources.find((source) => source.owner === element) ||
    state.cssSources.find((source) => source.id === id);
  if (!element.isConnected || !element.hasAttribute("style")) {
    if (!existing) return null;
    state.cssSources = state.cssSources.filter(
      (source) => source !== existing,
    );
    return existing.id;
  }
  const sourceId = ensureNodeSourceId(element, "attribute");
  const text = element.getAttribute("style") || "";
  if (
    existing &&
    (existing.text === text || existing.lastAppliedText === text)
  ) {
    return null;
  }
  if (existing) delete existing.lastAppliedText;
  registerCssSource({
    id: sourceId,
    name: `${element.tagName.toLowerCase()}[style]`,
    kind: "attribute",
    text,
    order: existing?.order ?? state.cssSources.length,
    owner: element,
  });
  return sourceId;
}

function flushRuntimeMutations() {
  scanTimer = null;
  const doc = getIframeDocument();
  const fullScan = pendingFullScan;
  const styles = Array.from(pendingStyleSources);
  const inlineElements = Array.from(pendingInlineSources);
  pendingFullScan = false;
  pendingStyleSources.clear();
  pendingInlineSources.clear();
  if (!doc) return;
  if (fullScan) {
    scanDocumentSources(doc);
    return;
  }
  const changedIds = new Set();
  for (const style of styles) {
    const id = updateRuntimeStyleSource(style);
    if (id) changedIds.add(id);
  }
  for (const element of inlineElements) {
    const id = updateRuntimeInlineSource(element);
    if (id) changedIds.add(id);
  }
  if (!changedIds.size) return;
  const before = colorEntriesSignature();
  rebuildChangedColorEntries(changedIds);
  if (onCssSourcesChanged) {
    onCssSourcesChanged(before !== colorEntriesSignature());
  }
}

function observeRuntimeSources(doc) {
  if (runtimeObserver) runtimeObserver.disconnect();
  runtimeObserver = new MutationObserver(scheduleRuntimeScan);
  runtimeObserver.observe(doc.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["style", "href"],
  });
}

function handleIframeLoad() {
  syncInspector();
  const doc = getIframeDocument();
  if (!doc) {
    if (runtimeObserver) runtimeObserver.disconnect();
    return;
  }
  if (previewMode !== "url") scanDocumentSources(doc);
  observeRuntimeSources(doc);
}

function navigateIframe(html, mode = "editor") {
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  const blob = new Blob([html], { type: "text/html" });
  currentBlobUrl = URL.createObjectURL(blob);
  previewMode = mode;
  iframeEl.src = currentBlobUrl;
}

export function loadSiteUrl(url) {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  previewMode = "url";
  siteMessageOrigin = "*";

  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("The site did not finish loading within 15 seconds."));
    }, 15000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      iframeEl.removeEventListener("load", onLoad);
      iframeEl.removeEventListener("error", onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("The site could not be loaded in the iframe."));
    };
    iframeEl.addEventListener("load", onLoad, { once: true });
    iframeEl.addEventListener("error", onError, { once: true });
    iframeEl.src = url;
  });
}

function requestSiteCss() {
  return new Promise((resolve, reject) => {
    const requestId = `ct-css-${Date.now()}-${++requestSequence}`;
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(
        new Error(
          "The site is cross-origin and did not answer the CSS query. Add color-tweaker-bridge.js to its index.html.",
        ),
      );
    }, 3000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
    };
    const onMessage = (event) => {
      if (event.source !== iframeEl.contentWindow) return;
      if (!event.data || event.data.type !== "ct-css-response") return;
      if (event.data.requestId !== requestId) return;
      if (event.data.protocol !== 2 || !Array.isArray(event.data.sources)) return;
      cleanup();
      siteMessageOrigin = event.origin;
      const sources = event.data.sources;
      installRemoteSources(sources);
      resolve({
        skipped: Number(event.data.skipped) || 0,
      });
    };
    window.addEventListener("message", onMessage);
    iframeEl.contentWindow.postMessage(
      { protocol: 2, type: "ct-css-request", requestId },
      "*",
    );
  });
}

export async function readSiteCss() {
  const doc = getIframeDocument();
  if (!doc) return requestSiteCss();

  const result = scanDocumentSources(doc);
  observeRuntimeSources(doc);
  return { skipped: result.skipped };
}

export function getProcessedCss(rawCss = "") {
  if (!state.cssSources.length) return rawCss;
  if (state.cssSources.length === 1 && state.cssSources[0].kind === "editor") {
    return processedSourceText(state.cssSources[0]);
  }
  return getCombinedCss(true);
}

export function updatePreview(rawHtml, rawCss, rawJs) {
  if (state.cssMode !== "editor") setEditorCss(getFlattenedCss(true));
  else if (!state.cssSources.length) setEditorCss(rawCss);
  const css = getProcessedCss(rawCss);
  const doc =
    '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style data-ct-source="editor">' +
    css +
    "</style>" +
    "<script>" +
    IFRAME_LISTENER +
    "<\/script>" +
    "</head><body>" +
    rawHtml +
    "<script>" +
    rawJs +
    "<\/script></body></html>";
  navigateIframe(doc, "editor");
}

function findBySource(doc, attribute, id) {
  return Array.from(doc.querySelectorAll(`[${attribute}]`)).find(
    (element) => element.getAttribute(attribute) === id,
  );
}

function applyDirectUpdates(doc, updates) {
  if (runtimeObserver) runtimeObserver.disconnect();
  applyingUpdates = true;
  try {
    for (const update of updates) {
      const source = state.cssSources.find((item) => item.id === update.id);
      if (!source) continue;
      if (update.text === (source.lastAppliedText ?? source.text)) continue;
      if (source.kind === "attribute") {
        const element =
          source.owner || findBySource(doc, "data-ct-inline-source", update.id);
        if (element) element.setAttribute("style", update.text);
        source.lastAppliedText = element?.getAttribute("style") || update.text;
      } else if (source.kind === "adopted" && source.owner?.replaceSync) {
        source.owner.replaceSync(update.text);
        source.lastAppliedText = serializeStyleSheet(source.owner).text;
      } else {
        const node =
          source.owner || findBySource(doc, "data-ct-source", update.id);
        if (!node) continue;
        if (node.tagName === "LINK") {
          let patch = node.__ctPatch;
          if (!patch) {
            patch = doc.createElement("style");
            patch.dataset.ctManaged = "true";
            node.after(patch);
            node.disabled = true;
            node.__ctPatch = patch;
          }
          patch.textContent = update.text;
          source.lastAppliedText = patch.textContent;
        } else {
          node.textContent = update.text;
          source.lastAppliedText = node.textContent;
        }
      }
    }
  } finally {
    applyingUpdates = false;
    observeRuntimeSources(doc);
  }
}

export function patchCss() {
  if (!iframeEl?.contentWindow) return;
  const updates = getCssSourceUpdates();
  const doc = getIframeDocument();
  if (doc) {
    applyDirectUpdates(doc, updates);
    return;
  }
  const changedUpdates = updates.filter(
    (update) => remoteAppliedTexts.get(update.id) !== update.text,
  );
  if (!changedUpdates.length) return;
  for (const update of changedUpdates) {
    remoteAppliedTexts.set(update.id, update.text);
  }
  iframeEl.contentWindow.postMessage(
    { protocol: 2, type: "ct-source-update", updates: changedUpdates },
    siteMessageOrigin,
  );
}

export function loadBuildHtml(html) {
  navigateIframe(html, "build");
}

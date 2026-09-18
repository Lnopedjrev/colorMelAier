(() => {
  "use strict";

  if (globalThis.__COLOR_TWEAKER_CONTROLLER__) return;

  const TYPES = {
    PING: "ct:ping",
    DETACH_REQUEST: "ct:detach-request",
    SCAN_REQUEST: "ct:scan-request",
    SOURCES_CHANGED: "ct:sources-changed",
    REGISTER_REMOTE_SOURCES: "ct:register-remote-sources",
    APPLY_SOURCE_UPDATES: "ct:apply-source-updates",
    INSPECT_START: "ct:inspect-start",
    INSPECT_STOP: "ct:inspect-stop",
    INSPECT_RESULT: "ct:inspect-result",
  };
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
  const records = new Map();
  const ownerIds = new WeakMap();
  const sheetIds = new WeakMap();
  const watchedLinks = new WeakSet();
  let sequence = 0;
  let observer = null;
  let observedRoots = [];
  let mutationTimer = null;
  let pendingFullScan = false;
  const pendingOwners = new Set();
  let applyingUpdates = false;
  let lastSkipped = 0;
  let inspectorMode = "off";
  let inspectorStyle = null;
  let frozenOverlay = null;

  function sourceId(owner, prefix, idMap = ownerIds) {
    let id = idMap.get(owner);
    if (!id) {
      id = `${prefix}-${++sequence}`;
      idMap.set(owner, id);
    }
    return id;
  }

  function serializeStyleSheet(sheet, visited = new Set()) {
    if (!sheet || visited.has(sheet)) {
      return { text: "", skipped: 0, readable: Boolean(sheet) };
    }
    visited.add(sheet);
    const chunks = [];
    let skipped = 0;
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
          const imported = serializeStyleSheet(rule.styleSheet, visited);
          let text = imported.text;
          if (rule.supportsText) {
            text = `@supports ${rule.supportsText}{\n${text}\n}`;
          }
          if (rule.media?.mediaText && rule.media.mediaText !== "all") {
            text = `@media ${rule.media.mediaText}{\n${text}\n}`;
          }
          if (rule.layerName !== undefined && rule.layerName !== null) {
            text = `@layer${rule.layerName ? ` ${rule.layerName}` : ""}{\n${text}\n}`;
          }
          chunks.push(text);
          skipped += imported.skipped;
        } else {
          chunks.push(rule.cssText);
        }
      }
    } catch {
      return { text: "", skipped: skipped + 1, readable: false };
    }
    return { text: chunks.filter(Boolean).join("\n"), skipped, readable: true };
  }

  function restoreRecord(record) {
    const { owner, kind, baseText } = record;
    if (kind === "linked") {
      record.patch?.remove();
      record.patch = null;
      if (owner?.isConnected) owner.disabled = record.originalDisabled;
    } else if (kind === "attribute") {
      if (!owner?.isConnected) return;
      if (baseText === null) owner.removeAttribute("style");
      else owner.setAttribute("style", baseText);
    } else if (kind === "adopted") {
      if (typeof owner?.replaceSync === "function") owner.replaceSync(baseText);
    } else if (owner?.isConnected) {
      owner.textContent = baseText;
    }
    record.modified = false;
    record.lastAppliedText = null;
  }

  function discardRecord(record) {
    if (record.kind === "linked") {
      record.patch?.remove();
      if (record.owner?.isConnected) {
        record.owner.disabled = record.originalDisabled;
      }
    }
  }

  function sourceFromRecord(record) {
    return {
      id: record.id,
      name: record.name,
      kind: record.kind,
      text: record.baseText || "",
      order: record.order,
      href: record.href || null,
    };
  }

  function snapshot(skipped = lastSkipped) {
    const ordered = Array.from(records.values()).sort(
      (left, right) => left.order - right.order,
    );
    const resolvedInaccessible = ordered.filter(
      (record) => record.inaccessible && record.remoteText,
    ).length;
    return {
      sources: ordered.map(sourceFromRecord),
      skipped: Math.max(0, skipped - resolvedInaccessible),
      unreadableStylesheets: ordered
        .filter(
          (record) =>
            record.kind === "linked" &&
            record.inaccessible &&
            !record.remoteText,
        )
        .map((record) => ({
          id: record.id,
          href: record.href,
          name: record.name,
        })),
    };
  }

  function mergeRecord(source, owner, discoveredText, extra = {}) {
    let previous = records.get(source.id);
    if (previous && previous.owner !== owner) discardRecord(previous);

    if (
      source.kind === "linked" &&
      previous?.owner === owner &&
      previous.href !== source.href
    ) {
      discardRecord(previous);
      previous = null;
    }

    const sameOwner = previous?.owner === owner;
    const observedOwnUpdate =
      sameOwner &&
      previous.modified &&
      previous.lastAppliedText === discoveredText;
    let baseText = observedOwnUpdate ? previous.baseText : discoveredText;

    if (source.kind === "linked" && sameOwner) {
      if (previous.remoteText && extra.inaccessible) {
        baseText = previous.remoteText;
      } else if (previous.modified) {
        baseText = previous.baseText;
      }
    }

    const record = {
      ...previous,
      ...source,
      ...extra,
      owner,
      baseText: baseText ?? "",
      modified:
        sameOwner && previous?.modified &&
        (source.kind === "linked" || observedOwnUpdate),
      lastAppliedText:
        sameOwner && previous?.modified ? previous.lastAppliedText : null,
      originalDisabled:
        source.kind === "linked"
          ? previous?.originalDisabled ?? owner.disabled
          : undefined,
    };
    records.set(source.id, record);
    return record;
  }

  function isTrackableStyle(element) {
    return (
      element?.nodeType === Node.ELEMENT_NODE &&
      element.tagName === "STYLE" &&
      element.type !== "importmap" &&
      element.dataset.ctManaged !== "true"
    );
  }

  function isStylesheetLink(element) {
    return (
      element?.nodeType === Node.ELEMENT_NODE &&
      element.tagName === "LINK" &&
      element.relList?.contains("stylesheet")
    );
  }

  function scanRoot(root, context) {
    context.roots.push(root);
    const query = (selector) => Array.from(root.querySelectorAll(selector));

    for (const style of query("style")) {
      if (!isTrackableStyle(style)) continue;
      const id = sourceId(style, "style");
      const serialized = /@import\b/i.test(style.textContent || "")
        ? serializeStyleSheet(style.sheet)
        : null;
      context.skipped += serialized?.skipped || 0;
      mergeRecord(
        {
          id,
          name: style.dataset.ctName || id,
          kind: "runtime",
          order: context.order++,
          href: null,
        },
        style,
        serialized?.text || style.textContent || "",
      );
      context.seen.add(id);
    }

    for (const link of query('link[rel~="stylesheet"]')) {
      const id = sourceId(link, "linked");
      const serialized = serializeStyleSheet(link.sheet);
      const inaccessible = !serialized.readable;
      context.skipped += serialized.skipped;
      const previous = records.get(id);
      mergeRecord(
        {
          id,
          name: link.getAttribute("href") || id,
          kind: "linked",
          order: context.order++,
          href: link.href,
        },
        link,
        inaccessible ? previous?.remoteText || "" : serialized.text,
        { inaccessible },
      );
      context.seen.add(id);
      if (inaccessible && !watchedLinks.has(link)) {
        watchedLinks.add(link);
        link.addEventListener("load", scheduleFullScan, { once: true });
      }
    }

    for (const element of query("[style]")) {
      if (element.dataset.ctManaged === "true") continue;
      const id = sourceId(element, "attribute");
      mergeRecord(
        {
          id,
          name: `${element.tagName.toLowerCase()}[style]`,
          kind: "attribute",
          order: context.order++,
          href: null,
        },
        element,
        element.getAttribute("style"),
      );
      context.seen.add(id);
    }

    for (const sheet of root.adoptedStyleSheets || []) {
      const id = sourceId(sheet, "adopted", sheetIds);
      const serialized = serializeStyleSheet(sheet);
      context.skipped += serialized.skipped;
      if (!serialized.text) continue;
      mergeRecord(
        {
          id,
          name: id,
          kind: "adopted",
          order: context.order++,
          href: null,
        },
        sheet,
        serialized.text,
      );
      context.seen.add(id);
    }

    for (const element of query("*")) {
      if (element.shadowRoot) scanRoot(element.shadowRoot, context);
    }
  }

  function installObserver(roots) {
    observer?.disconnect();
    observedRoots = roots;
    observer = new MutationObserver(queueMutations);
    for (const root of roots) {
      const target = root === document ? document.documentElement : root;
      if (!target) continue;
      observer.observe(target, {
        childList: true,
        characterData: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "href"],
      });
    }
  }

  function scanAll() {
    observer?.disconnect();
    const context = {
      order: 0,
      roots: [],
      seen: new Set(),
      skipped: 0,
    };
    scanRoot(document, context);
    lastSkipped = context.skipped;
    for (const [id, record] of records) {
      if (context.seen.has(id)) continue;
      discardRecord(record);
      records.delete(id);
    }
    installObserver(context.roots);
    return snapshot(context.skipped);
  }

  function subtreeContainsSource(node) {
    if (node?.nodeType !== Node.ELEMENT_NODE) return false;
    if (node.dataset.ctManaged === "true") return false;
    if (
      isTrackableStyle(node) ||
      isStylesheetLink(node) ||
      node.hasAttribute("style") ||
      node.shadowRoot
    ) {
      return true;
    }
    if (node.querySelector('style, link[rel~="stylesheet"], [style]')) {
      return true;
    }
    return Array.from(node.querySelectorAll("*")).some(
      (element) => element.shadowRoot,
    );
  }

  function queueMutations(mutations) {
    if (applyingUpdates) return;
    for (const mutation of mutations) {
      if (
        mutation.target?.nodeType === Node.ELEMENT_NODE &&
        mutation.target.dataset?.ctManaged === "true"
      ) {
        continue;
      }
      if (mutation.type === "attributes") {
        if (mutation.attributeName === "href") pendingFullScan = true;
        else pendingOwners.add(mutation.target);
        continue;
      }
      if (mutation.type === "characterData") {
        const style = mutation.target.parentElement;
        if (isTrackableStyle(style)) pendingOwners.add(style);
        continue;
      }
      if (isTrackableStyle(mutation.target)) {
        pendingOwners.add(mutation.target);
      } else if (
        [...mutation.addedNodes, ...mutation.removedNodes].some(
          subtreeContainsSource,
        )
      ) {
        pendingFullScan = true;
      }
    }
    if (!pendingFullScan && !pendingOwners.size) return;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(flushMutations, 400);
  }

  function refreshOwner(owner) {
    const id = ownerIds.get(owner);
    const record = id && records.get(id);
    if (!record || !owner.isConnected) return false;
    let text;
    if (record.kind === "attribute") {
      if (!owner.hasAttribute("style")) {
        records.delete(id);
        return true;
      }
      text = owner.getAttribute("style");
    } else if (record.kind === "runtime") {
      const serialized = /@import\b/i.test(owner.textContent || "")
        ? serializeStyleSheet(owner.sheet)
        : null;
      text = serialized?.text || owner.textContent || "";
    } else {
      return false;
    }
    if (text === record.lastAppliedText || text === record.baseText) return false;
    record.baseText = text;
    record.modified = false;
    record.lastAppliedText = null;
    return true;
  }

  function sendSourcesChanged(nextSnapshot) {
    chrome.runtime
      .sendMessage({ type: TYPES.SOURCES_CHANGED, snapshot: nextSnapshot })
      .catch(() => {});
  }

  function flushMutations() {
    mutationTimer = null;
    const fullScan = pendingFullScan;
    const owners = Array.from(pendingOwners);
    pendingFullScan = false;
    pendingOwners.clear();
    if (fullScan) {
      sendSourcesChanged(scanAll());
      return;
    }
    let changed = false;
    for (const owner of owners) changed = refreshOwner(owner) || changed;
    if (changed) sendSourcesChanged(snapshot());
  }

  function scheduleFullScan() {
    pendingFullScan = true;
    clearTimeout(mutationTimer);
    mutationTimer = setTimeout(flushMutations, 100);
  }

  function applyUpdate(record, update) {
    if (
      typeof update.sourceText === "string" &&
      update.sourceText !== record.baseText
    ) {
      record.baseText = update.sourceText;
      if (record.kind === "linked") record.sourcePatched = true;
    }
    const nextText = update.text;
    if (nextText === record.baseText && !record.sourcePatched) {
      restoreRecord(record);
      return;
    }

    if (record.kind === "attribute") {
      if (record.owner?.isConnected) record.owner.setAttribute("style", nextText);
      record.lastAppliedText = record.owner?.getAttribute("style") || nextText;
    } else if (record.kind === "adopted") {
      record.owner?.replaceSync?.(nextText);
      record.lastAppliedText = serializeStyleSheet(record.owner).text;
    } else if (record.kind === "linked") {
      if (!record.owner?.isConnected) return;
      if (!record.patch) {
        record.patch = document.createElement("style");
        record.patch.dataset.ctManaged = "true";
        record.owner.after(record.patch);
      }
      record.owner.disabled = true;
      record.patch.textContent = nextText;
      record.lastAppliedText = record.patch.textContent;
    } else {
      if (!record.owner?.isConnected) return;
      record.owner.textContent = nextText;
      record.lastAppliedText = record.owner.textContent || "";
    }
    record.modified = true;
  }

  function applyUpdates(updates) {
    applyingUpdates = true;
    observer?.disconnect();
    try {
      for (const update of updates || []) {
        const record = records.get(update.id);
        if (!record || typeof update.text !== "string") continue;
        applyUpdate(record, update);
      }
    } finally {
      applyingUpdates = false;
      installObserver(observedRoots);
    }
    return snapshot();
  }

  function registerRemoteSources(sources) {
    for (const source of sources || []) {
      const record = records.get(source.id);
      if (
        !record ||
        record.kind !== "linked" ||
        record.href !== source.href ||
        typeof source.text !== "string"
      ) {
        continue;
      }
      record.remoteText = source.text;
      record.baseText = source.text;
    }
    return snapshot();
  }

  function pointHitsText(element, clientX, clientY) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clientX, clientY);
      node = position?.offsetNode;
      offset = position?.offset ?? 0;
    } else if (document.caretRangeFromPoint) {
      const range = document.caretRangeFromPoint(clientX, clientY);
      node = range?.startContainer;
      offset = range?.startOffset ?? 0;
    }
    if (!node || node.nodeType !== Node.TEXT_NODE || !element.contains(node)) {
      return false;
    }
    const text = node.textContent || "";
    for (const index of [offset, offset - 1]) {
      if (index < 0 || index >= text.length || !text[index].trim()) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + 1);
      if (
        Array.from(range.getClientRects()).some(
          (rect) =>
            clientX >= rect.left &&
            clientX <= rect.right &&
            clientY >= rect.top &&
            clientY <= rect.bottom,
        )
      ) {
        return true;
      }
    }
    return false;
  }

  function borderPropertiesAtPoint(element, computed, clientX, clientY) {
    const rect = element.getBoundingClientRect();
    const sides = [
      ["border-top-color", "border-top-width", "border-top-style", clientY - rect.top],
      ["border-right-color", "border-right-width", "border-right-style", rect.right - clientX],
      ["border-bottom-color", "border-bottom-width", "border-bottom-style", rect.bottom - clientY],
      ["border-left-color", "border-left-width", "border-left-style", clientX - rect.left],
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
      .sort((left, right) => left[3] - right[3])
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
    const computed = getComputedStyle(element);
    const computedStyles = new WeakMap([[element, computed]]);
    const getComputed = (owner) => {
      if (!computedStyles.has(owner)) {
        computedStyles.set(owner, getComputedStyle(owner));
      }
      return computedStyles.get(owner);
    };
    const candidates = [];
    const seen = new Set();
    const addCandidate = (owner, property) => {
      const ownerComputed = getComputed(owner);
      if (!isRenderedColorProperty(owner, ownerComputed, property)) return false;
      const color = ownerComputed.getPropertyValue(property).trim();
      if (
        !color ||
        color === "none" ||
        color === "transparent" ||
        color === "rgba(0, 0, 0, 0)"
      ) {
        return false;
      }
      const key = `${property}:${color}`;
      if (seen.has(key)) return true;
      seen.add(key);
      candidates.push({ property, color });
      return true;
    };

    for (const property of borderPropertiesAtPoint(
      element,
      computed,
      clientX,
      clientY,
    )) {
      addCandidate(element, property);
    }
    if (element.namespaceURI === "http://www.w3.org/2000/svg") {
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

  function sendInspectResult(element, clientX, clientY) {
    const candidates = element
      ? collectElementColors(element, clientX, clientY)
      : [];
    clearInspector();
    chrome.runtime
      .sendMessage({
        type: TYPES.INSPECT_RESULT,
        candidates,
      })
      .catch(() => {});
  }

  function deepestElementFromPoint(clientX, clientY) {
    let element = document.elementFromPoint(clientX, clientY);
    while (element?.shadowRoot?.elementFromPoint) {
      const nested = element.shadowRoot.elementFromPoint(clientX, clientY);
      if (!nested || nested === element) break;
      element = nested;
    }
    return element;
  }

  function handleInspectedClick(event) {
    if (inspectorMode !== "inspect") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const target = event
      .composedPath()
      .find((node) => node?.nodeType === Node.ELEMENT_NODE);
    sendInspectResult(target, event.clientX, event.clientY);
  }

  function handleFrozenClick(event) {
    if (inspectorMode !== "frozen") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    frozenOverlay.style.pointerEvents = "none";
    const element = deepestElementFromPoint(event.clientX, event.clientY);
    frozenOverlay.style.pointerEvents = "auto";
    sendInspectResult(element, event.clientX, event.clientY);
  }

  function clearInspector() {
    document.removeEventListener("click", handleInspectedClick, true);
    inspectorStyle?.remove();
    frozenOverlay?.remove();
    inspectorStyle = null;
    frozenOverlay = null;
    inspectorMode = "off";
  }

  function setInspector(mode) {
    clearInspector();
    if (mode !== "inspect" && mode !== "frozen") return;
    inspectorMode = mode;

    inspectorStyle = document.createElement("style");
    inspectorStyle.dataset.ctManaged = "true";
    inspectorStyle.textContent = "*{cursor:crosshair!important}";
    (document.head || document.documentElement).appendChild(inspectorStyle);

    if (mode === "inspect") {
      document.addEventListener("click", handleInspectedClick, true);
      return;
    }

    frozenOverlay = document.createElement("div");
    frozenOverlay.dataset.ctManaged = "true";
    frozenOverlay.setAttribute("aria-hidden", "true");
    frozenOverlay.style.cssText = [
      "position:fixed",
      "inset:0",
      "z-index:2147483647",
      "background:transparent",
      "cursor:crosshair",
      "pointer-events:auto",
    ].join(";");
    frozenOverlay.addEventListener("click", handleFrozenClick, true);
    document.documentElement.appendChild(frozenOverlay);
  }

  function detach() {
    clearTimeout(mutationTimer);
    observer?.disconnect();
    clearInspector();
    applyingUpdates = true;
    try {
      for (const record of records.values()) {
        if (record.modified || record.patch) restoreRecord(record);
      }
    } finally {
      applyingUpdates = false;
    }
    records.clear();
    chrome.runtime.onMessage.removeListener(handleMessage);
    delete globalThis.__COLOR_TWEAKER_CONTROLLER__;
  }

  function handleMessage(message, sender, sendResponse) {
    try {
      if (message?.type === TYPES.PING) {
        sendResponse({ ok: true });
      } else if (message?.type === TYPES.SCAN_REQUEST) {
        sendResponse({ ok: true, snapshot: scanAll() });
      } else if (message?.type === TYPES.REGISTER_REMOTE_SOURCES) {
        sendResponse({
          ok: true,
          snapshot: registerRemoteSources(message.sources),
        });
      } else if (message?.type === TYPES.APPLY_SOURCE_UPDATES) {
        sendResponse({ ok: true, snapshot: applyUpdates(message.updates) });
      } else if (message?.type === TYPES.INSPECT_START) {
        setInspector(message.mode);
        sendResponse({ ok: true });
      } else if (message?.type === TYPES.INSPECT_STOP) {
        clearInspector();
        sendResponse({ ok: true });
      } else if (message?.type === TYPES.DETACH_REQUEST) {
        sendResponse({ ok: true });
        detach();
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  }

  chrome.runtime.onMessage.addListener(handleMessage);
  globalThis.__COLOR_TWEAKER_CONTROLLER__ = { detach };
})();

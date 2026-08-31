// ColorTweaker dev-server bridge.
// Serve this file from the previewed site and add it to index.html:
// <script src="/color-tweaker-bridge.js" data-color-tweaker-origin="http://localhost:3000"></script>

(function () {
  "use strict";

  const script = document.currentScript;
  const allowedOrigin = script && script.dataset.colorTweakerOrigin;
  const sourceOwners = new Map();
  const sourceRecords = new Map();
  const sourceTexts = new Map();
  const lastAppliedTexts = new Map();
  const overriddenIds = new Set();
  const sheetIds = new WeakMap();
  let sourceSequence = 0;
  let parentOrigin = null;
  let inspectorOrigin = null;
  let observer = null;
  let notifyTimer = null;
  let observedRoots = [];
  let pendingFullScan = false;
  const pendingStyleSources = new Set();
  const pendingInlineSources = new Set();

  const inspectedColorProperties = [
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

  function accepts(event) {
    return (
      event.source === window.parent &&
      (!allowedOrigin || event.origin === allowedOrigin)
    );
  }

  function serializeSheet(sheet, visited) {
    if (!sheet || visited.has(sheet)) return { text: "", skipped: 0 };
    visited.add(sheet);
    const chunks = [];
    let skipped = 0;
    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === 3 && rule.styleSheet) {
          const imported = serializeSheet(rule.styleSheet, visited);
          let importedText = imported.text;
          if (rule.supportsText) {
            importedText =
              "@supports " + rule.supportsText + "{\n" + importedText + "\n}";
          }
          if (rule.media && rule.media.mediaText && rule.media.mediaText !== "all") {
            importedText =
              "@media " + rule.media.mediaText + "{\n" + importedText + "\n}";
          }
          if (rule.layerName !== undefined && rule.layerName !== null) {
            importedText =
              "@layer" +
              (rule.layerName ? " " + rule.layerName : "") +
              "{\n" +
              importedText +
              "\n}";
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

  function nodeId(node, attribute, prefix) {
    let id = node.getAttribute(attribute);
    if (id) id = id.replace(/[^a-zA-Z0-9_.:-]+/g, "-");
    if (!id || sourceOwners.has(id)) {
      do {
        id = prefix + "-" + ++sourceSequence;
      } while (sourceOwners.has(id));
    }
    node.setAttribute(attribute, id);
    return id;
  }

  function scanSources() {
    sourceOwners.clear();
    sourceRecords.clear();
    const sources = [];
    const watchedRoots = [];
    let order = 0;
    let skipped = 0;

    function add(source, owner) {
      if (
        overriddenIds.has(source.id) &&
        sourceTexts.has(source.id) &&
        lastAppliedTexts.get(source.id) === source.text
      ) {
        source.text = sourceTexts.get(source.id);
      } else {
        sourceTexts.set(source.id, source.text);
        overriddenIds.delete(source.id);
        lastAppliedTexts.delete(source.id);
      }
      const record = { ...source, order: order++ };
      sources.push(record);
      sourceRecords.set(source.id, record);
      sourceOwners.set(source.id, { kind: source.kind, owner });
    }

    function scanRoot(root) {
      watchedRoots.push(root);
      const query = (selector) => Array.from(root.querySelectorAll(selector));

      for (const style of query("style")) {
        if (
          style.id === "__ct-inspector" ||
          style.type === "importmap" ||
          style.dataset.ctManaged === "true"
        ) {
          continue;
        }
        const id = nodeId(style, "data-ct-source", "style");
        const serialized = /@import\b/i.test(style.textContent || "")
          ? serializeSheet(style.sheet, new Set())
          : null;
        skipped += (serialized && serialized.skipped) || 0;
        add(
          {
            id,
            name: style.dataset.ctName || id,
            kind: "runtime",
            text: (serialized && serialized.text) || style.textContent || "",
          },
          style,
        );
      }

      for (const link of query('link[rel="stylesheet"]')) {
        const id = nodeId(link, "data-ct-source", "linked");
        const serialized = serializeSheet(link.sheet, new Set());
        skipped += serialized.skipped;
        if (!serialized.text) {
          link.addEventListener("load", notifySourcesChanged, { once: true });
          continue;
        }
        add(
          {
            id,
            name: link.getAttribute("href") || id,
            kind: "linked",
            text: link.__ctPatch ? link.__ctPatch.textContent : serialized.text,
            href: link.href,
          },
          link,
        );
      }

      for (const element of query("[style]")) {
        const id = nodeId(
          element,
          "data-ct-inline-source",
          "attribute",
        );
        add(
          {
            id,
            name: element.tagName.toLowerCase() + "[style]",
            kind: "attribute",
            text: element.getAttribute("style") || "",
          },
          element,
        );
      }

      if (root.adoptedStyleSheets) {
        for (const sheet of root.adoptedStyleSheets) {
          let id = sheetIds.get(sheet);
          if (!id) {
            id = "adopted-" + ++sourceSequence;
            sheetIds.set(sheet, id);
          }
          const serialized = serializeSheet(sheet, new Set());
          skipped += serialized.skipped;
          if (!serialized.text) continue;
          add(
            { id, name: id, kind: "adopted", text: serialized.text },
            sheet,
          );
        }
      }

      for (const element of query("*")) {
        if (element.shadowRoot) scanRoot(element.shadowRoot);
      }
    }

    scanRoot(document);
    return { sources, skipped, watchedRoots };
  }

  function isTrackableStyle(element) {
    return (
      element &&
      element.nodeType === 1 &&
      element.tagName === "STYLE" &&
      element.id !== "__ct-inspector" &&
      element.type !== "importmap" &&
      element.dataset.ctManaged !== "true"
    );
  }

  function isStylesheetLink(element) {
    return (
      element &&
      element.nodeType === 1 &&
      element.tagName === "LINK" &&
      element.relList &&
      element.relList.contains("stylesheet")
    );
  }

  function subtreeContainsCssSource(node) {
    if (!node || node.nodeType !== 1) return false;
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
    return Array.from(node.querySelectorAll("*")).some(function (element) {
      return element.shadowRoot;
    });
  }

  function queueMutations(records) {
    for (const record of records) {
      if (record.type === "attributes") {
        if (record.attributeName === "href" && isStylesheetLink(record.target)) {
          pendingFullScan = true;
        } else if (
          record.attributeName === "style" &&
          record.target.id !== "__ct-inspector"
        ) {
          const id = record.target.getAttribute("data-ct-inline-source");
          if (id && sourceOwners.get(id)?.owner === record.target) {
            pendingInlineSources.add(record.target);
          } else {
            pendingFullScan = true;
          }
        }
        continue;
      }
      if (record.type !== "childList") continue;
      if (isTrackableStyle(record.target)) {
        pendingStyleSources.add(record.target);
        continue;
      }
      if (
        Array.from(record.addedNodes)
          .concat(Array.from(record.removedNodes))
          .some(subtreeContainsCssSource)
      ) {
        pendingFullScan = true;
      }
    }
    if (
      !pendingFullScan &&
      !pendingStyleSources.size &&
      !pendingInlineSources.size
    ) {
      return;
    }
    window.clearTimeout(notifyTimer);
    notifyTimer = window.setTimeout(flushMutations, 300);
  }

  function updateSourceRecord(source, owner) {
    const current = sourceRecords.get(source.id);
    if (
      overriddenIds.has(source.id) &&
      sourceTexts.has(source.id) &&
      lastAppliedTexts.get(source.id) === source.text
    ) {
      source.text = sourceTexts.get(source.id);
    } else {
      sourceTexts.set(source.id, source.text);
      overriddenIds.delete(source.id);
      lastAppliedTexts.delete(source.id);
    }
    const next = { ...source, order: current?.order ?? sourceRecords.size };
    if (
      current &&
      current.text === next.text &&
      current.name === next.name &&
      current.kind === next.kind &&
      (current.href || null) === (next.href || null)
    ) {
      return null;
    }
    sourceRecords.set(next.id, next);
    sourceOwners.set(next.id, { kind: next.kind, owner });
    return next;
  }

  function updateStyleSource(style) {
    const id = style.getAttribute("data-ct-source");
    if (!id || !sourceOwners.has(id) || !style.isConnected) {
      return { fullScan: true };
    }
    const serialized = /@import\b/i.test(style.textContent || "")
      ? serializeSheet(style.sheet, new Set())
      : null;
    return {
      source: updateSourceRecord(
        {
          id,
          name: style.dataset.ctName || id,
          kind: sourceRecords.get(id)?.kind || "runtime",
          text: (serialized && serialized.text) || style.textContent || "",
        },
        style,
      ),
    };
  }

  function updateInlineSource(element) {
    const id = element.getAttribute("data-ct-inline-source");
    if (!id || sourceOwners.get(id)?.owner !== element) {
      return { fullScan: true };
    }
    if (!element.isConnected || !element.hasAttribute("style")) {
      sourceOwners.delete(id);
      sourceRecords.delete(id);
      sourceTexts.delete(id);
      lastAppliedTexts.delete(id);
      overriddenIds.delete(id);
      return { removedId: id };
    }
    return {
      source: updateSourceRecord(
        {
          id,
          name: element.tagName.toLowerCase() + "[style]",
          kind: "attribute",
          text: element.getAttribute("style") || "",
        },
        element,
      ),
    };
  }

  function flushMutations() {
    notifyTimer = null;
    const fullScan = pendingFullScan;
    const styles = Array.from(pendingStyleSources);
    const inlineElements = Array.from(pendingInlineSources);
    pendingFullScan = false;
    pendingStyleSources.clear();
    pendingInlineSources.clear();
    if (fullScan) {
      notifySourcesChanged();
      return;
    }
    const sources = [];
    const removedIds = [];
    for (const style of styles) {
      const change = updateStyleSource(style);
      if (change.fullScan) {
        notifySourcesChanged();
        return;
      }
      if (change.source) sources.push(change.source);
    }
    for (const element of inlineElements) {
      const change = updateInlineSource(element);
      if (change.fullScan) {
        notifySourcesChanged();
        return;
      }
      if (change.source) sources.push(change.source);
      if (change.removedId) removedIds.push(change.removedId);
    }
    if (!sources.length && !removedIds.length) return;
    window.parent.postMessage(
      { type: "ct-css-source-changes", sources, removedIds },
      parentOrigin,
    );
  }

  function installObserver(roots) {
    if (observer) observer.disconnect();
    observedRoots = roots;
    observer = new MutationObserver(queueMutations);
    for (const root of roots) {
      const target = root === document ? document.documentElement : root;
      if (!target) continue;
      observer.observe(target, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["style", "href"],
      });
    }
  }

  function notifySourcesChanged() {
    if (!parentOrigin) return;
    const result = scanSources();
    installObserver(result.watchedRoots);
    window.parent.postMessage(
      {
        type: "ct-css-sources-changed",
        sources: result.sources,
        skipped: result.skipped,
      },
      parentOrigin,
    );
  }

  function applySourceUpdates(updates) {
    if (!sourceOwners.size) scanSources();
    if (observer) observer.disconnect();
    for (const update of updates || []) {
      const record = sourceOwners.get(update.id);
      if (!record || typeof update.text !== "string") continue;
      if (typeof update.sourceText === "string") {
        sourceTexts.set(update.id, update.sourceText);
      }
      const currentText = lastAppliedTexts.has(update.id)
        ? lastAppliedTexts.get(update.id)
        : sourceTexts.get(update.id);
      if (currentText === update.text) continue;
      overriddenIds.add(update.id);
      if (record.kind === "attribute") {
        record.owner.setAttribute("style", update.text);
        lastAppliedTexts.set(update.id, record.owner.getAttribute("style") || "");
      } else if (record.kind === "adopted" && record.owner.replaceSync) {
        record.owner.replaceSync(update.text);
        lastAppliedTexts.set(
          update.id,
          serializeSheet(record.owner, new Set()).text,
        );
      } else if (record.owner.tagName === "LINK") {
        let patch = record.owner.__ctPatch;
        if (!patch) {
          patch = document.createElement("style");
          patch.dataset.ctManaged = "true";
          record.owner.after(patch);
          record.owner.disabled = true;
          record.owner.__ctPatch = patch;
        }
        patch.textContent = update.text;
        lastAppliedTexts.set(update.id, patch.textContent);
      } else {
        record.owner.textContent = update.text;
        lastAppliedTexts.set(update.id, record.owner.textContent || "");
      }
    }
    installObserver(observedRoots);
  }

  function pointHitsText(element, clientX, clientY) {
    let node = null;
    let offset = 0;
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(clientX, clientY);
      node = position?.offsetNode;
      offset = position?.offset ?? 0;
    } else if (document.caretRangeFromPoint) {
      const caretRange = document.caretRangeFromPoint(clientX, clientY);
      node = caretRange?.startContainer;
      offset = caretRange?.startOffset ?? 0;
    }
    if (!node || node.nodeType !== 3 || !element.contains(node)) return false;

    const text = node.textContent || "";
    for (const index of [offset, offset - 1]) {
      if (index < 0 || index >= text.length || !text[index].trim()) continue;
      const range = document.createRange();
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
    const computed = window.getComputedStyle(element);
    const computedStyles = new WeakMap([[element, computed]]);
    const getComputed = (owner) => {
      if (!computedStyles.has(owner)) {
        computedStyles.set(owner, window.getComputedStyle(owner));
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
    for (const property of inspectedColorProperties) {
      addCandidate(element, property);
    }
    return candidates;
  }

  function handleInspectedClick(event) {
    if (!inspectorOrigin) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage(
      {
        type: "ct-colors-picked",
        candidates: collectElementColors(
          event.target,
          event.clientX,
          event.clientY,
        ),
      },
      inspectorOrigin,
    );
  }

  function setInspector(active, origin) {
    inspectorOrigin = active ? origin : null;
    document.removeEventListener("click", handleInspectedClick, true);
    let style = document.getElementById("__ct-inspector");
    if (active) {
      document.addEventListener("click", handleInspectedClick, true);
      if (!style) {
        style = document.createElement("style");
        style.id = "__ct-inspector";
        style.textContent = "*{cursor:crosshair!important}";
        (document.head || document.documentElement).appendChild(style);
      }
    } else if (style) {
      style.remove();
    }
  }

  window.addEventListener("message", (event) => {
    if (!accepts(event) || !event.data) return;
    parentOrigin = event.origin;

    if (event.data.type === "ct-css-request") {
      const result = scanSources();
      installObserver(result.watchedRoots);
      event.source.postMessage(
        {
          type: "ct-css-response",
          requestId: event.data.requestId,
          protocol: 2,
          sources: result.sources,
          skipped: result.skipped,
        },
        event.origin,
      );
    } else if (event.data.type === "ct-source-update") {
      applySourceUpdates(event.data.updates);
    } else if (event.data.type === "ct-inspect-mode") {
      setInspector(Boolean(event.data.active), event.origin);
    } else if (event.data.type === "ct-inspect-point") {
      const x = Number(event.data.x);
      const y = Number(event.data.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const element = document.elementFromPoint(x, y);
      if (!element) return;
      event.source.postMessage(
        {
          type: "ct-colors-picked",
          candidates: collectElementColors(element, x, y),
        },
        event.origin,
      );
    }
  });
})();

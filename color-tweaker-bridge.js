// ColorTweaker dev-server bridge.
// Serve this file from the previewed site and add it to index.html:
// <script src="/color-tweaker-bridge.js" data-color-tweaker-origin="http://localhost:3000"></script>

(function () {
  "use strict";

  const script = document.currentScript;
  const allowedOrigin = script && script.dataset.colorTweakerOrigin;
  const sourceOwners = new Map();
  const sourceTexts = new Map();
  const lastAppliedTexts = new Map();
  const overriddenIds = new Set();
  const sheetIds = new WeakMap();
  let sourceSequence = 0;
  let parentOrigin = null;
  let inspectorOrigin = null;
  let observer = null;
  let notifyTimer = null;

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
      sources.push({ ...source, order: order++ });
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

  function installObserver(roots) {
    if (observer) observer.disconnect();
    observer = new MutationObserver(() => {
      window.clearTimeout(notifyTimer);
      notifyTimer = window.setTimeout(notifySourcesChanged, 120);
    });
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
    const result = scanSources();
    installObserver(result.watchedRoots);
  }

  function collectElementColors(element) {
    const computed = window.getComputedStyle(element);
    const colors = new Set();
    for (const property of inspectedColorProperties) {
      const value = computed.getPropertyValue(property).trim();
      if (
        value &&
        value !== "none" &&
        value !== "transparent" &&
        value !== "rgba(0, 0, 0, 0)"
      ) {
        colors.add(value);
      }
    }
    return Array.from(colors);
  }

  function handleInspectedClick(event) {
    if (!inspectorOrigin) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    window.parent.postMessage(
      { type: "ct-colors-picked", colors: collectElementColors(event.target) },
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
    }
  });
})();

(() => {
  "use strict";

  const TYPES = Object.freeze({
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
  const frame = document.getElementById("build-preview");
  let objectUrls = [];
  let activeRequestId = null;
  let sourceDeadline = null;

  function notify(type, payload = {}) {
    parent.postMessage({ type, ...payload }, "*");
  }

  function trackUrl(blob) {
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    return url;
  }

  function clearObjectUrls() {
    for (const url of objectUrls) URL.revokeObjectURL(url);
    objectUrls = [];
  }

  function normalizePath(value) {
    const parts = [];
    for (const part of String(value || "").replace(/\\/g, "/").split("/")) {
      if (!part || part === ".") continue;
      if (part === "..") parts.pop();
      else parts.push(part);
    }
    return parts.join("/");
  }

  function cleanReference(value) {
    return String(value || "").trim().split("#")[0].split("?")[0];
  }

  function isExternalReference(value) {
    return /^(?:[a-z][a-z\d+.-]*:|#|\/\/)/i.test(String(value || "").trim());
  }

  function sourceDirectory(sourcePath) {
    const index = sourcePath.lastIndexOf("/");
    return index < 0 ? "" : sourcePath.substring(0, index);
  }

  function resolvePath(reference, sourcePath = "") {
    const clean = cleanReference(reference);
    if (!clean || isExternalReference(clean)) return null;
    if (clean.startsWith("/")) return normalizePath(clean.substring(1));
    return normalizePath(`${sourceDirectory(sourcePath)}/${clean}`);
  }

  function findExistingPath(reference, sourcePath, fileMap) {
    if (isExternalReference(reference)) return null;
    const resolved = resolvePath(reference, sourcePath);
    if (resolved && fileMap.has(resolved)) return resolved;
    const clean = normalizePath(cleanReference(reference));
    if (fileMap.has(clean)) return clean;
    const filename = clean.split("/").pop();
    if (!filename) return null;
    const matches = Array.from(fileMap.keys()).filter(
      (path) => path === filename || path.endsWith(`/${filename}`),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function mimeType(path, supplied = "") {
    if (supplied) return supplied;
    const extension = path.split(".").pop().toLowerCase();
    const types = {
      css: "text/css",
      js: "application/javascript",
      mjs: "application/javascript",
      cjs: "application/javascript",
      html: "text/html",
      htm: "text/html",
      json: "application/json",
      map: "application/json",
      svg: "image/svg+xml",
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      gif: "image/gif",
      webp: "image/webp",
      avif: "image/avif",
      ico: "image/x-icon",
      woff: "font/woff",
      woff2: "font/woff2",
      ttf: "font/ttf",
      otf: "font/otf",
      eot: "application/vnd.ms-fontobject",
      wasm: "application/wasm",
      mp4: "video/mp4",
      webm: "video/webm",
      mp3: "audio/mpeg",
      wav: "audio/wav",
      txt: "text/plain",
      xml: "application/xml",
    };
    return types[extension] || "application/octet-stream";
  }

  function findHtmlEntry(fileMap) {
    if (fileMap.has("index.html")) return "index.html";
    const indexes = Array.from(fileMap.keys()).filter((path) =>
      path.endsWith("/index.html"),
    );
    if (indexes.length) return indexes.sort((a, b) => a.length - b.length)[0];
    return Array.from(fileMap.keys()).find((path) => /\.html?$/i.test(path));
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
      const conditionText =
        supports.startsWith("(") ||
        /^(?:selector|font-tech|font-format)\(/i.test(supports)
          ? supports
          : `(${supports})`;
      wrapped = `@supports ${conditionText}{\n${wrapped}\n}`;
    }
    if (layer !== null) {
      wrapped = `@layer${layer ? ` ${layer}` : ""}{\n${wrapped}\n}`;
    }
    return wrapped;
  }

  function rewriteCssUrls(css, sourcePath, fileMap, blobMap) {
    return css.replace(
      /url\(\s*(["']?)([^"')]+)\1\s*\)/gi,
      (match, quote, reference) => {
        if (isExternalReference(reference) || reference.startsWith("data:")) {
          return match;
        }
        const path = findExistingPath(reference, sourcePath, fileMap);
        const url = path && blobMap.get(path);
        return url ? `url("${url}")` : match;
      },
    );
  }

  async function expandCssImports(
    css,
    sourcePath,
    fileMap,
    blobMap,
    visited = new Set(),
  ) {
    if (visited.has(sourcePath)) return "";
    const nextVisited = new Set(visited);
    nextVisited.add(sourcePath);
    const importPattern =
      /@import\s+(?:url\(\s*)?["']?([^"'\)\s]+)["']?\s*\)?\s*([^;]*);/gi;
    let result = "";
    let cursor = 0;
    let match;
    while ((match = importPattern.exec(css))) {
      result += css.substring(cursor, match.index);
      cursor = importPattern.lastIndex;
      const importedPath = findExistingPath(match[1], sourcePath, fileMap);
      const importedFile = importedPath && fileMap.get(importedPath);
      if (!importedFile || !/\.css$/i.test(importedPath)) {
        result += match[0];
        continue;
      }
      const imported = await expandCssImports(
        await importedFile.blob.text(),
        importedPath,
        fileMap,
        blobMap,
        nextVisited,
      );
      const condition = match[2].trim();
      result += condition ? wrapImportedCss(imported, condition) : imported;
    }
    result += css.substring(cursor);
    return rewriteCssUrls(result, sourcePath, fileMap, blobMap);
  }

  function moduleAlias(path) {
    return `@ct/${path}`;
  }

  function resolveModulePath(specifier, importerPath, modulePaths) {
    if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;
    const clean = cleanReference(specifier);
    const candidate = normalizePath(
      clean.startsWith("/")
        ? clean.substring(1)
        : `${sourceDirectory(importerPath)}/${clean}`,
    );
    const candidates = [
      candidate,
      `${candidate}.js`,
      `${candidate}.mjs`,
      `${candidate}.cjs`,
      `${candidate}/index.js`,
      `${candidate}/index.mjs`,
      `${candidate}/index.cjs`,
    ];
    for (const path of candidates) {
      if (modulePaths.has(path)) return path;
    }
    const filename = candidate.split("/").pop();
    const matches = Array.from(modulePaths).filter(
      (path) => path === filename || path.endsWith(`/${filename}`),
    );
    return matches.length === 1 ? matches[0] : null;
  }

  function rewriteRuntimeAssetReferences(
    source,
    importerPath,
    fileMap,
    blobMap,
  ) {
    const blobUrl = (reference) => {
      const path = findExistingPath(reference, importerPath, fileMap);
      return path && blobMap.get(path);
    };
    let result = source.replace(
      /new\s+URL\(\s*(["'])([^"']+)\1\s*,\s*import\.meta\.url\s*\)/g,
      (match, quote, reference) => {
        const url = blobUrl(reference);
        return url ? `new URL(${JSON.stringify(url)})` : match;
      },
    );
    return result.replace(
      /(\bfetch\s*\(\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, reference) => {
        const url = blobUrl(reference);
        return url ? `${prefix}${quote}${url}${quote}` : match;
      },
    );
  }

  function rewriteModuleSpecifiers(
    source,
    importerPath,
    modulePaths,
    fileMap,
    blobMap,
  ) {
    const replace = (prefix, quote, specifier, suffix = "") => {
      const resolved = resolveModulePath(specifier, importerPath, modulePaths);
      return `${prefix}${quote}${resolved ? moduleAlias(resolved) : specifier}${quote}${suffix}`;
    };
    let result = source.replace(
      /(\b(?:import|export)\s*[^"'`;]*?\bfrom\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, specifier) => replace(prefix, quote, specifier),
    );
    result = result.replace(
      /(\bimport\s*)(["'])([^"']+)\2/g,
      (match, prefix, quote, specifier) => replace(prefix, quote, specifier),
    );
    result = result.replace(
      /(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/g,
      (match, prefix, quote, specifier, suffix) =>
        replace(prefix, quote, specifier, suffix),
    );
    return rewriteRuntimeAssetReferences(
      result,
      importerPath,
      fileMap,
      blobMap,
    );
  }

  function rewriteSrcset(value, sourcePath, fileMap, blobMap) {
    return value
      .split(",")
      .map((candidate) => {
        const [reference, ...descriptor] = candidate.trim().split(/\s+/);
        const path = findExistingPath(reference, sourcePath, fileMap);
        return `${path && blobMap.has(path) ? blobMap.get(path) : reference}${
          descriptor.length ? ` ${descriptor.join(" ")}` : ""
        }`;
      })
      .join(", ");
  }

  function runtimeBridge() {
    "use strict";

    const SOURCE_MESSAGE = "ct:build-sources";
    const APPLY_MESSAGE = "ct:build-apply-updates";
    const INSPECT_MESSAGE = "ct:build-inspector";
    const RESULT_MESSAGE = "ct:build-inspect-result";
    const records = new Map();
    const ownerIds = new WeakMap();
    const sheetIds = new WeakMap();
    const sourceOwners = new Map();
    const watchedLinks = new WeakSet();
    let sequence = 0;
    let observer = null;
    let scanTimer = null;
    let applying = false;
    let inspectorMode = "off";
    let inspectorStyle = null;
    let frozenOverlay = null;

    function nextId(prefix) {
      let id;
      do id = `${prefix}-${++sequence}`;
      while (sourceOwners.has(id));
      return id;
    }

    function nodeId(node, attribute, prefix) {
      let id = ownerIds.get(node) || node.getAttribute(attribute);
      if (id && sourceOwners.has(id) && sourceOwners.get(id) !== node) id = null;
      if (!id) id = nextId(prefix);
      id = String(id).replace(/[^a-zA-Z0-9_.:-]+/g, "-");
      node.setAttribute(attribute, id);
      ownerIds.set(node, id);
      sourceOwners.set(id, node);
      return id;
    }

    function sheetId(sheet) {
      let id = sheetIds.get(sheet);
      if (!id) {
        id = nextId("build-adopted");
        sheetIds.set(sheet, id);
        sourceOwners.set(id, sheet);
      }
      return id;
    }

    function serializeSheet(sheet, visited = new Set()) {
      if (!sheet || visited.has(sheet)) return "";
      visited.add(sheet);
      const chunks = [];
      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.type === CSSRule.IMPORT_RULE && rule.styleSheet) {
            let text = serializeSheet(rule.styleSheet, visited);
            if (rule.supportsText) text = `@supports ${rule.supportsText}{\n${text}\n}`;
            if (rule.media?.mediaText && rule.media.mediaText !== "all") {
              text = `@media ${rule.media.mediaText}{\n${text}\n}`;
            }
            if (rule.layerName !== undefined && rule.layerName !== null) {
              text = `@layer${rule.layerName ? ` ${rule.layerName}` : ""}{\n${text}\n}`;
            }
            chunks.push(text);
          } else {
            chunks.push(rule.cssText);
          }
        }
      } catch {
        return "";
      }
      return chunks.filter(Boolean).join("\n");
    }

    function mergeRecord(source, owner, discoveredText) {
      const previous = records.get(source.id);
      const ownUpdate =
        previous?.owner === owner &&
        previous.lastAppliedText !== null &&
        previous.lastAppliedText === discoveredText;
      const baseText = ownUpdate ? previous.baseText : discoveredText;
      records.set(source.id, {
        ...previous,
        ...source,
        owner,
        baseText: baseText || "",
        lastAppliedText: ownUpdate ? previous.lastAppliedText : null,
      });
    }

    function scanRoot(root, context) {
      context.roots.push(root);
      const query = (selector) => Array.from(root.querySelectorAll(selector));
      for (const style of query("style")) {
        if (style.dataset.ctManaged === "true" || style.type === "importmap") continue;
        const id = nodeId(style, "data-ct-source", "build-style");
        mergeRecord(
          {
            id,
            name: style.dataset.ctName || id,
            kind: style.dataset.ctKind || "runtime",
            order: context.order++,
            href: null,
          },
          style,
          /@import\b/i.test(style.textContent || "")
            ? serializeSheet(style.sheet) || style.textContent || ""
            : style.textContent || "",
        );
        context.seen.add(id);
      }
      for (const link of query('link[rel~="stylesheet"]')) {
        const id = nodeId(link, "data-ct-source", "build-link");
        const text = serializeSheet(link.sheet);
        if (!text) {
          if (!watchedLinks.has(link)) {
            watchedLinks.add(link);
            link.addEventListener("load", scanAndSend, { once: true });
          }
          continue;
        }
        mergeRecord(
          {
            id,
            name: link.getAttribute("href") || id,
            kind: "linked",
            order: context.order++,
            href: link.href,
          },
          link,
          text,
        );
        context.seen.add(id);
      }
      for (const element of query("[style]")) {
        if (element.dataset.ctManaged === "true") continue;
        const id = nodeId(element, "data-ct-inline-source", "build-attribute");
        mergeRecord(
          {
            id,
            name: `${element.tagName.toLowerCase()}[style]`,
            kind: "attribute",
            order: context.order++,
            href: null,
          },
          element,
          element.getAttribute("style") || "",
        );
        context.seen.add(id);
      }
      for (const sheet of root.adoptedStyleSheets || []) {
        const text = serializeSheet(sheet);
        if (!text) continue;
        const id = sheetId(sheet);
        mergeRecord(
          { id, name: id, kind: "adopted", order: context.order++, href: null },
          sheet,
          text,
        );
        context.seen.add(id);
      }
      for (const element of query("*")) {
        if (element.shadowRoot) scanRoot(element.shadowRoot, context);
      }
    }

    function snapshot() {
      return Array.from(records.values())
        .sort((left, right) => left.order - right.order)
        .map((record) => ({
          id: record.id,
          name: record.name,
          kind: record.kind,
          text: record.baseText,
          order: record.order,
          href: record.href || null,
        }));
    }

    function installObserver(roots) {
      observer?.disconnect();
      observer = new MutationObserver((mutations) => {
        if (applying) return;
        const relevant = mutations.some(
          (mutation) => mutation.target?.dataset?.ctManaged !== "true",
        );
        if (!relevant) return;
        clearTimeout(scanTimer);
        scanTimer = setTimeout(scanAndSend, 250);
      });
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

    function scanAndSend() {
      clearTimeout(scanTimer);
      observer?.disconnect();
      const context = { roots: [], seen: new Set(), order: 0 };
      scanRoot(document, context);
      for (const id of Array.from(records.keys())) {
        if (!context.seen.has(id)) records.delete(id);
      }
      installObserver(context.roots);
      parent.postMessage({ type: SOURCE_MESSAGE, sources: snapshot() }, "*");
    }

    function applyUpdates(updates) {
      applying = true;
      observer?.disconnect();
      try {
        for (const update of updates || []) {
          const record = records.get(update.id);
          if (!record || typeof update.text !== "string") continue;
          if (typeof update.sourceText === "string") {
            record.baseText = update.sourceText;
          }
          if (record.kind === "attribute") {
            record.owner?.setAttribute?.("style", update.text);
            record.lastAppliedText = record.owner?.getAttribute?.("style") || update.text;
          } else if (record.kind === "adopted") {
            record.owner?.replaceSync?.(update.text);
            record.lastAppliedText = serializeSheet(record.owner);
          } else if (record.kind === "linked") {
            if (!record.owner?.isConnected) continue;
            let patch = record.patch;
            if (!patch) {
              patch = document.createElement("style");
              patch.dataset.ctManaged = "true";
              record.owner.after(patch);
              record.owner.disabled = true;
              record.patch = patch;
            }
            patch.textContent = update.text;
            record.lastAppliedText = patch.textContent;
          } else if (record.owner?.isConnected) {
            record.owner.textContent = update.text;
            record.lastAppliedText = record.owner.textContent || "";
          }
        }
      } finally {
        applying = false;
        const roots = [];
        const collectRoots = (root) => {
          roots.push(root);
          for (const element of root.querySelectorAll("*")) {
            if (element.shadowRoot) collectRoots(element.shadowRoot);
          }
        };
        collectRoots(document);
        installObserver(roots);
      }
    }

    function pointHitsText(element, x, y) {
      const position = document.caretPositionFromPoint?.(x, y);
      const range = !position ? document.caretRangeFromPoint?.(x, y) : null;
      const node = position?.offsetNode || range?.startContainer;
      const offset = position?.offset ?? range?.startOffset ?? 0;
      if (!node || node.nodeType !== Node.TEXT_NODE || !element.contains(node)) return false;
      const text = node.textContent || "";
      for (const index of [offset, offset - 1]) {
        if (index < 0 || index >= text.length || !text[index].trim()) continue;
        const character = document.createRange();
        character.setStart(node, index);
        character.setEnd(node, index + 1);
        if (
          Array.from(character.getClientRects()).some(
            (rect) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom,
          )
        ) return true;
      }
      return false;
    }

    function collectColors(element, x, y) {
      const candidates = [];
      const seen = new Set();
      const computedCache = new WeakMap();
      const computed = (owner) => {
        if (!computedCache.has(owner)) computedCache.set(owner, getComputedStyle(owner));
        return computedCache.get(owner);
      };
      const add = (owner, property) => {
        const value = computed(owner).getPropertyValue(property).trim();
        if (!value || value === "none" || value === "transparent" || value === "rgba(0, 0, 0, 0)") return false;
        const key = `${property}:${value}`;
        if (!seen.has(key)) {
          seen.add(key);
          candidates.push({ property, color: value });
        }
        return true;
      };
      const style = computed(element);
      const rect = element.getBoundingClientRect();
      const borders = [
        ["border-top-color", "border-top-width", "border-top-style", y - rect.top],
        ["border-right-color", "border-right-width", "border-right-style", rect.right - x],
        ["border-bottom-color", "border-bottom-width", "border-bottom-style", rect.bottom - y],
        ["border-left-color", "border-left-width", "border-left-style", x - rect.left],
      ];
      for (const [property, widthName, styleName, distance] of borders) {
        const width = parseFloat(style.getPropertyValue(widthName));
        const borderStyle = style.getPropertyValue(styleName);
        if (width > 0 && !["none", "hidden"].includes(borderStyle) && distance >= 0 && distance <= width) {
          add(element, property);
        }
      }
      if (element.namespaceURI === "http://www.w3.org/2000/svg") {
        add(element, "fill");
        add(element, "stroke");
      }
      const textHit = pointHitsText(element, x, y);
      if (textHit) add(element, "color");
      let background = element;
      while (background) {
        if (add(background, "background-color")) break;
        const root = background.getRootNode();
        background = background.parentElement || root.host || null;
      }
      if (!textHit) add(element, "color");
      for (const property of ["outline-color", "text-decoration-color", "column-rule-color", "caret-color"]) {
        add(element, property);
      }
      return candidates;
    }

    function deepestElement(x, y) {
      let element = document.elementFromPoint(x, y);
      while (element?.shadowRoot?.elementFromPoint) {
        const nested = element.shadowRoot.elementFromPoint(x, y);
        if (!nested || nested === element) break;
        element = nested;
      }
      return element;
    }

    function clearInspector() {
      document.removeEventListener("click", inspectClick, true);
      inspectorStyle?.remove();
      frozenOverlay?.remove();
      inspectorStyle = null;
      frozenOverlay = null;
      inspectorMode = "off";
    }

    function sendInspection(element, x, y) {
      const candidates = element ? collectColors(element, x, y) : [];
      clearInspector();
      parent.postMessage({ type: RESULT_MESSAGE, candidates }, "*");
    }

    function inspectClick(event) {
      if (inspectorMode !== "inspect") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      const target = event.composedPath().find((node) => node?.nodeType === Node.ELEMENT_NODE);
      sendInspection(target, event.clientX, event.clientY);
    }

    function frozenClick(event) {
      if (inspectorMode !== "frozen") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      frozenOverlay.style.pointerEvents = "none";
      const target = deepestElement(event.clientX, event.clientY);
      frozenOverlay.style.pointerEvents = "auto";
      sendInspection(target, event.clientX, event.clientY);
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
        document.addEventListener("click", inspectClick, true);
        return;
      }
      frozenOverlay = document.createElement("div");
      frozenOverlay.dataset.ctManaged = "true";
      frozenOverlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;background:transparent;cursor:crosshair;pointer-events:auto";
      frozenOverlay.addEventListener("click", frozenClick, true);
      document.documentElement.appendChild(frozenOverlay);
    }

    window.addEventListener("message", (event) => {
      if (event.source !== parent || !event.data) return;
      if (event.data.type === APPLY_MESSAGE) applyUpdates(event.data.updates);
      else if (event.data.type === INSPECT_MESSAGE) setInspector(event.data.mode);
    });
    window.addEventListener("error", (event) => {
      parent.postMessage({ type: "ct:build-warning", message: event.message || "Build script error." }, "*");
    });
    window.addEventListener("unhandledrejection", (event) => {
      parent.postMessage({ type: "ct:build-warning", message: String(event.reason || "Unhandled build promise rejection.") }, "*");
    });
    // Do not wait for DOMContentLoaded: deferred/module scripts can keep it
    // pending while the application is starting. The first scan installs an
    // observer, which picks up the rest of the document as parsing continues.
    scanAndSend();
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", scanAndSend, { once: true });
    }
    window.addEventListener("load", scanAndSend, { once: true });
  }

  async function transformBuild(fileRecords) {
    const fileMap = new Map();
    for (const record of fileRecords || []) {
      const path = normalizePath(record.path);
      if (!path || !record.buffer) continue;
      fileMap.set(path, {
        path,
        blob: new Blob([record.buffer], { type: mimeType(path, record.type) }),
      });
    }
    const htmlPath = findHtmlEntry(fileMap);
    if (!htmlPath) throw new Error("The selected folder does not contain an HTML entry file.");

    const blobMap = new Map();
    for (const [path, file] of fileMap) {
      if (/\.(?:html?|css|[cm]?js)$/i.test(path)) continue;
      blobMap.set(path, trackUrl(file.blob));
    }

    for (const [path, file] of fileMap) {
      if (!/\.css$/i.test(path)) continue;
      const css = await expandCssImports(
        await file.blob.text(),
        path,
        fileMap,
        blobMap,
      );
      blobMap.set(path, trackUrl(new Blob([css], { type: "text/css" })));
    }

    const modulePaths = new Set(
      Array.from(fileMap.keys()).filter((path) => /\.(?:[cm]?js)$/i.test(path)),
    );
    const importEntries = {};
    for (const path of modulePaths) {
      const file = fileMap.get(path);
      const source = rewriteModuleSpecifiers(
        await file.blob.text(),
        path,
        modulePaths,
        fileMap,
        blobMap,
      );
      const url = trackUrl(new Blob([source], { type: "application/javascript" }));
      blobMap.set(path, url);
      importEntries[moduleAlias(path)] = url;
    }

    const html = await fileMap.get(htmlPath).blob.text();
    const doc = new DOMParser().parseFromString(html, "text/html");
    doc.querySelectorAll("base").forEach((element) => element.remove());
    doc
      .querySelectorAll('meta[http-equiv="content-security-policy" i], link[rel="manifest"]')
      .forEach((element) => element.remove());
    doc
      .querySelectorAll('script[src*="ngsw" i], script[src*="service-worker" i]')
      .forEach((element) => element.remove());

    let sourceSequence = 0;
    for (const link of Array.from(doc.querySelectorAll('link[rel~="stylesheet"]'))) {
      const path = findExistingPath(link.getAttribute("href"), htmlPath, fileMap);
      const file = path && fileMap.get(path);
      if (!file) continue;
      const style = doc.createElement("style");
      style.dataset.ctSource = `build-style-${++sourceSequence}`;
      style.dataset.ctName = path;
      style.dataset.ctKind = "build";
      style.textContent = await expandCssImports(
        await file.blob.text(),
        path,
        fileMap,
        blobMap,
      );
      link.replaceWith(style);
    }

    for (const style of Array.from(doc.querySelectorAll("style"))) {
      if (style.type === "importmap") continue;
      if (!style.dataset.ctSource) {
        style.dataset.ctSource = `build-style-${++sourceSequence}`;
      }
      style.dataset.ctKind = style.dataset.ctKind || "build";
      style.textContent = await expandCssImports(
        style.textContent || "",
        htmlPath,
        fileMap,
        blobMap,
      );
    }
    for (const element of Array.from(doc.querySelectorAll("[style]"))) {
      element.dataset.ctInlineSource = `build-attribute-${++sourceSequence}`;
      element.setAttribute(
        "style",
        rewriteCssUrls(element.getAttribute("style") || "", htmlPath, fileMap, blobMap),
      );
    }

    for (const element of Array.from(doc.querySelectorAll("[src], [poster], object[data]"))) {
      const attribute = element.hasAttribute("src")
        ? "src"
        : element.hasAttribute("poster")
          ? "poster"
          : "data";
      const path = findExistingPath(element.getAttribute(attribute), htmlPath, fileMap);
      if (path && blobMap.has(path)) element.setAttribute(attribute, blobMap.get(path));
    }
    for (const element of Array.from(doc.querySelectorAll("[srcset]"))) {
      element.setAttribute(
        "srcset",
        rewriteSrcset(element.getAttribute("srcset"), htmlPath, fileMap, blobMap),
      );
    }
    for (const link of Array.from(doc.querySelectorAll("link[href]"))) {
      const path = findExistingPath(link.getAttribute("href"), htmlPath, fileMap);
      if (path && blobMap.has(path)) {
        link.setAttribute("href", blobMap.get(path));
        link.removeAttribute("integrity");
      }
    }

    for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
      const path = findExistingPath(script.getAttribute("src"), htmlPath, fileMap);
      if (path && blobMap.has(path)) {
        script.setAttribute("src", blobMap.get(path));
        script.removeAttribute("integrity");
      }
    }
    for (const script of Array.from(doc.querySelectorAll('script[type="module"]:not([src])'))) {
      script.textContent = rewriteModuleSpecifiers(
        script.textContent || "",
        htmlPath,
        modulePaths,
        fileMap,
        blobMap,
      );
    }
    for (const script of Array.from(doc.querySelectorAll('script:not([src]):not([type="module"]):not([type="importmap"])'))) {
      script.textContent = rewriteRuntimeAssetReferences(
        script.textContent || "",
        htmlPath,
        fileMap,
        blobMap,
      );
    }

    const existingImportMap = { imports: {}, scopes: {} };
    for (const map of Array.from(doc.querySelectorAll('script[type="importmap"]'))) {
      try {
        const parsed = JSON.parse(map.textContent || "{}");
        Object.assign(existingImportMap.imports, parsed.imports || {});
        Object.assign(existingImportMap.scopes, parsed.scopes || {});
      } catch {
        // Ignore malformed build import maps; the preview will report unresolved imports.
      }
      map.remove();
    }
    for (const [specifier, target] of Object.entries(existingImportMap.imports)) {
      const path = findExistingPath(target, htmlPath, fileMap);
      if (path && blobMap.has(path)) existingImportMap.imports[specifier] = blobMap.get(path);
    }
    if (
      Object.keys(importEntries).length ||
      Object.keys(existingImportMap.imports).length ||
      Object.keys(existingImportMap.scopes).length
    ) {
      const map = doc.createElement("script");
      map.type = "importmap";
      map.textContent = JSON.stringify({
        imports: { ...existingImportMap.imports, ...importEntries },
        scopes: existingImportMap.scopes,
      }).replace(/</g, "\\u003c");
      doc.head.prepend(map);
    }

    const bridge = doc.createElement("script");
    bridge.textContent = `(${runtimeBridge.toString()})();`;
    const firstModule = doc.head.querySelector('script[type="module"]');
    if (firstModule) firstModule.before(bridge);
    else doc.head.appendChild(bridge);

    return {
      htmlPath,
      html: `<!doctype html>\n${doc.documentElement.outerHTML}`,
      fileCount: fileMap.size,
    };
  }

  async function loadBuild(message) {
    activeRequestId = message.requestId;
    clearTimeout(sourceDeadline);
    sourceDeadline = null;
    clearObjectUrls();
    frame.removeAttribute("src");
    try {
      const result = await transformBuild(message.files);
      if (activeRequestId !== message.requestId) return;
      const documentUrl = trackUrl(
        new Blob([result.html], { type: "text/html" }),
      );
      frame.src = documentUrl;
      sourceDeadline = setTimeout(() => {
        notify(TYPES.ERROR, {
          requestId: message.requestId,
          error:
            "The build document opened, but its ColorTweaker runtime did not initialize.",
        });
      }, 15000);
      notify(TYPES.LOADED, {
        requestId: message.requestId,
        entryPath: result.htmlPath,
        fileCount: result.fileCount,
      });
    } catch (error) {
      notify(TYPES.ERROR, {
        requestId: message.requestId,
        error: error.message || String(error),
      });
    }
  }

  window.addEventListener("message", (event) => {
    if (!event.data?.type) return;
    if (event.source === parent) {
      if (event.data.type === TYPES.LOAD) loadBuild(event.data);
      else if (event.data.type === TYPES.APPLY) {
        frame.contentWindow?.postMessage(event.data, "*");
      } else if (event.data.type === TYPES.INSPECT) {
        frame.contentWindow?.postMessage(event.data, "*");
      }
      return;
    }
    if (event.source !== frame.contentWindow) return;
    if (event.data.type === TYPES.SOURCES) {
      clearTimeout(sourceDeadline);
      sourceDeadline = null;
    }
    if (
      event.data.type === TYPES.SOURCES ||
      event.data.type === TYPES.INSPECT_RESULT ||
      event.data.type === TYPES.WARNING
    ) {
      notify(event.data.type, {
        ...event.data,
        requestId: activeRequestId,
      });
    }
  });

  window.addEventListener("beforeunload", () => {
    clearTimeout(sourceDeadline);
    clearObjectUrls();
  });
  notify(TYPES.READY);
})();

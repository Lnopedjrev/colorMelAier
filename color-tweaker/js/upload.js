// Build upload — reads a dist/ folder, rewrites its assets, and loads it into the iframe

import { state } from "./state.js";
import { loadBuildHtml, loadSiteUrl, readSiteCss } from "./preview.js";
import { renderColorPanel } from "./color-panel.js";
import {
  getCssEditorText,
  rebuildColorEntries,
  registerCssSource,
  resetCssSources,
} from "./css-sources.js";

let cssEditorEl = null;
let onBuildLoaded = null;

export function initUpload(elements, callbacks) {
  cssEditorEl = elements.cssEditor;
  onBuildLoaded = callbacks.onBuildLoaded;

  const {
    dropZone,
    fileInput,
    btnLoad,
    buildChips,
    siteUrl,
    btnLoadUrl,
    urlStatus,
  } = elements;

  dropZone.addEventListener("click", () => fileInput.click());
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("over");
  });
  dropZone.addEventListener("dragleave", () =>
    dropZone.classList.remove("over"),
  );
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("over");
    handleBuildFiles(e.dataTransfer.files, btnLoad, buildChips);
  });
  fileInput.addEventListener("change", (e) =>
    handleBuildFiles(e.target.files, btnLoad, buildChips),
  );
  btnLoad.addEventListener("click", () => loadBuild());
  btnLoadUrl.addEventListener("click", () =>
    loadUrl(siteUrl, btnLoadUrl, urlStatus),
  );
  siteUrl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") loadUrl(siteUrl, btnLoadUrl, urlStatus);
  });
}

function setUrlStatus(el, message, type = "") {
  el.textContent = message;
  el.className = "load-status" + (type ? " " + type : "");
}

async function loadUrl(input, button, statusEl) {
  let url;
  try {
    url = new URL(input.value.trim());
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch (error) {
    setUrlStatus(statusEl, "Enter a valid http:// or https:// URL.", "error");
    return;
  }

  button.disabled = true;
  setUrlStatus(statusEl, "Loading site in preview…");

  try {
    await loadSiteUrl(url.href);
    if (onBuildLoaded) onBuildLoaded("url");
    setUrlStatus(statusEl, "Site loaded. Inspecting CSS…");

    resetCssSources("url");
    cssEditorEl.value = "";
    renderColorPanel();

    const { skipped } = await readSiteCss();
    cssEditorEl.value = getCssEditorText();
    renderColorPanel();
    if (!state.cssSources.length) {
      setUrlStatus(
        statusEl,
        skipped
          ? "Site loaded, but its stylesheets could not be inspected."
          : "Site loaded, but no CSS was found.",
        "error",
      );
    } else {
      const suffix = skipped
        ? ` ${skipped} cross-origin stylesheet${skipped === 1 ? " was" : "s were"} skipped.`
        : "";
      setUrlStatus(
        statusEl,
        `Site loaded. Found ${state.colorEntries.length} color${state.colorEntries.length === 1 ? "" : "s"}.${suffix}`,
        "success",
      );
    }
  } catch (error) {
    setUrlStatus(statusEl, error.message, "error");
  } finally {
    button.disabled = false;
  }
}

async function handleBuildFiles(fileList, btnLoad, chipsEl) {
  state.buildFileMap.clear();
  for (const f of fileList) {
    const path = "/" + f.webkitRelativePath.split("/").slice(1).join("/");
    state.buildFileMap.set(path, f);
  }
  chipsEl.innerHTML =
    Array.from(state.buildFileMap.keys())
      .slice(0, 30)
      .map((p) => `<span class="file-chip">${p}</span>`)
      .join("") +
    (state.buildFileMap.size > 30
      ? `<span class="file-chip">+${state.buildFileMap.size - 30} more</span>`
      : "");
  btnLoad.disabled = false;
}

function getMimeType(filename) {
  const ext = filename.split(".").pop().toLowerCase();
  const types = {
    js: "application/javascript",
    mjs: "application/javascript",
    css: "text/css",
    html: "text/html",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    eot: "application/vnd.ms-fontobject",
    ico: "image/x-icon",
    txt: "text/plain",
    xml: "application/xml",
  };
  return types[ext] || "application/octet-stream";
}

function findHtmlFile() {
  if (state.buildFileMap.has("/index.html")) {
    return { path: "/index.html", file: state.buildFileMap.get("/index.html") };
  }
  for (const [path, file] of state.buildFileMap) {
    if (file.name === "index.html") return { path, file };
  }
  for (const [path, file] of state.buildFileMap) {
    if (path.endsWith(".html")) return { path, file };
  }
  return null;
}

function findFileByRelativePath(relativePath, htmlDir) {
  const clean = cleanHref(relativePath);
  const candidates = [];

  if (htmlDir) candidates.push(htmlDir + "/" + clean);
  candidates.push("/" + clean);

  for (const path of candidates) {
    if (state.buildFileMap.has(path)) return state.buildFileMap.get(path);
  }

  const name = clean.split("/").pop();
  for (const [path, file] of state.buildFileMap) {
    if (path.endsWith("/" + name) || path === "/" + name) return file;
  }
  return null;
}

function cleanHref(href) {
  if (!href) return "";
  if (/^(?:data|blob|https?):/i.test(href)) return href;
  return href
    .replace(/^\.?\//, "")
    .split("?")[0]
    .split("#")[0];
}

function blobUrlForRef(ref, blobMap, htmlDir) {
  const clean = cleanHref(ref);
  if (!clean || /^(?:data|blob|https?):/i.test(clean)) return null;
  if (blobMap.has(clean)) return blobMap.get(clean);

  const file = findFileByRelativePath(clean, htmlDir);
  if (!file) return null;

  const name = clean.split("/").pop();
  for (const [rel, url] of blobMap) {
    if (rel === clean || rel.endsWith("/" + name) || rel === name) return url;
  }
  return null;
}

function resolveAssetPath(ref, sourcePath = "") {
  const clean = cleanHref(ref);
  if (!clean || /^(?:data|blob|https?):/i.test(clean)) return clean;
  if (String(ref).trim().startsWith("/")) return normalizeModulePath(clean);
  const sourceDir = sourcePath.includes("/")
    ? sourcePath.substring(0, sourcePath.lastIndexOf("/"))
    : "";
  return normalizeModulePath(sourceDir + "/" + clean);
}

function rewriteUrlsInCss(css, blobMap, sourcePath = "") {
  return css.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, ref) => {
    if (
      ref.startsWith("data:") ||
      ref.startsWith("blob:") ||
      ref.startsWith("http")
    )
      return match;
    const resolved = resolveAssetPath(ref, sourcePath);
    if (blobMap.has(resolved)) return "url(" + blobMap.get(resolved) + ")";
    return match;
  });
}

function closingParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i++) {
    if (text[i] === "(") depth++;
    else if (text[i] === ")" && --depth === 0) return i;
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

  const media = rest.trim();
  let wrapped = css;
  if (media) wrapped = `@media ${media}{\n${wrapped}\n}`;
  if (supports) {
    const supportsCondition =
      supports.startsWith("(") || /^(?:selector|font-tech|font-format)\(/i.test(supports)
        ? supports
        : `(${supports})`;
    wrapped = `@supports ${supportsCondition}{\n${wrapped}\n}`;
  }
  if (layer !== null) wrapped = `@layer${layer ? ` ${layer}` : ""}{\n${wrapped}\n}`;
  return wrapped;
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
  const importRe = /@import\s+(?:url\(\s*)?['"]?([^'"\)\s]+)['"]?\s*\)?\s*([^;]*);/gi;
  let result = "";
  let cursor = 0;
  let match;

  while ((match = importRe.exec(css))) {
    result += css.substring(cursor, match.index);
    cursor = importRe.lastIndex;
    const ref = match[1];
    const resolved = resolveAssetPath(ref, sourcePath);
    const importedFile = fileMap.get(resolved);
    if (!importedFile || /^(?:data|blob|https?):/i.test(ref)) {
      result += match[0];
      continue;
    }
    const imported = await expandCssImports(
      await importedFile.text(),
      resolved,
      fileMap,
      blobMap,
      nextVisited,
    );
    const condition = match[2].trim();
    result += condition ? wrapImportedCss(imported, condition) : imported;
  }
  result += css.substring(cursor);
  return rewriteUrlsInCss(result, blobMap, sourcePath);
}

function normalizeModulePath(path) {
  const parts = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") parts.pop();
    else parts.push(part);
  }
  return parts.join("/");
}

function moduleAlias(relativePath) {
  return "@ct/" + relativePath;
}

function resolveModulePath(specifier, importerPath, modulePaths) {
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) return null;

  const clean = specifier.split("?")[0].split("#")[0];
  const importerDir = importerPath.includes("/")
    ? importerPath.substring(0, importerPath.lastIndexOf("/"))
    : "";
  const candidate = normalizeModulePath(
    clean.startsWith("/") ? clean.substring(1) : importerDir + "/" + clean,
  );
  if (modulePaths.has(candidate)) return candidate;

  const filename = candidate.split("/").pop();
  const matches = Array.from(modulePaths).filter(
    (path) => path === filename || path.endsWith("/" + filename),
  );
  return matches.length === 1 ? matches[0] : null;
}

function rewriteModuleSpecifiers(source, importerPath, modulePaths) {
  const replaceSpecifier = (prefix, quote, specifier, suffix = "") => {
    const resolved = resolveModulePath(specifier, importerPath, modulePaths);
    return resolved
      ? prefix + quote + moduleAlias(resolved) + quote + suffix
      : prefix + quote + specifier + quote + suffix;
  };

  let result = source.replace(
    /(\b(?:import|export)\s*[^"'`;]*?\bfrom\s*)(["'])([^"']+)\2/g,
    (match, prefix, quote, specifier) =>
      replaceSpecifier(prefix, quote, specifier),
  );
  result = result.replace(
    /(\bimport\s*)(["'])([^"']+)\2/g,
    (match, prefix, quote, specifier) =>
      replaceSpecifier(prefix, quote, specifier),
  );
  result = result.replace(
    /(\bimport\s*\(\s*)(["'])([^"']+)\2(\s*\))/g,
    (match, prefix, quote, specifier, suffix) =>
      replaceSpecifier(prefix, quote, specifier, suffix),
  );
  return result;
}

async function loadBuild() {
  resetCssSources("build");

  const found = findHtmlFile();
  if (!found) {
    alert("No html file found in uploaded files");
    return;
  }
  const { path: htmlPath, file: htmlFile } = found;
  const htmlDir = htmlPath.substring(0, htmlPath.lastIndexOf("/"));

  console.log("[CT] HTML:", htmlPath, "| dir:", htmlDir || "/");

  // ---- blob URLs for non-module assets under htmlDir ----
  const blobMap = new Map();
  const assetFiles = new Map();
  const moduleFiles = new Map();
  for (const [path, file] of state.buildFileMap) {
    if (path === htmlPath) continue;
    if (htmlDir && !path.startsWith(htmlDir + "/")) continue; // if html is a root, ignore; if not, consume only files that in folder with html;
    const relativePath = htmlDir
      ? path.substring(htmlDir.length + 1)
      : path.substring(1);

    if (/\.(?:js|mjs)$/.test(relativePath)) {
      moduleFiles.set(relativePath, file);
      continue;
    }

    assetFiles.set(relativePath, file);
    const buf = await file.arrayBuffer();
    const blob = new Blob([buf], { type: getMimeType(file.name) });
    blobMap.set(relativePath, URL.createObjectURL(blob));
  }

  // blob: URLs cannot resolve relative ESM imports. Rewrite module references
  // to bare @ct/* aliases first, then map those aliases to the final blobs.
  const modulePaths = new Set(moduleFiles.keys());
  const importEntries = {};
  for (const [relativePath, file] of moduleFiles) {
    const source = await file.text();
    const rewritten = rewriteModuleSpecifiers(
      source,
      relativePath,
      modulePaths,
    );
    const blob = new Blob([rewritten], { type: getMimeType(file.name) });
    const url = URL.createObjectURL(blob);
    blobMap.set(relativePath, url);
    importEntries[moduleAlias(relativePath)] = url;
  }
  console.log("[CT]", blobMap.size, "assets → blob URLs");

  // ---- parse HTML ----
  const htmlText = await htmlFile.text();
  const doc = new DOMParser().parseFromString(htmlText, "text/html");

  // ---- strip <base> (Angular always emits <base href="/">) ----
  const baseEl = doc.querySelector("base");
  if (baseEl) baseEl.remove();

  // ---- strip service-worker / manifest links ----
  doc
    .querySelectorAll('link[rel="manifest"], script[src*="ngsw"]')
    .forEach((el) => el.remove());

  // ---- import map for rewritten JS/MJS aliases ----
  let hasModuleScripts = false;

  doc.querySelectorAll('script[type="module"]').forEach(() => {
    hasModuleScripts = true;
  });

  if (hasModuleScripts && Object.keys(importEntries).length > 0) {
    const mapEl = doc.createElement("script");
    mapEl.type = "importmap";
    mapEl.textContent = JSON.stringify({ imports: importEntries });
    doc.head.insertBefore(mapEl, doc.head.firstChild);
    console.log(
      "[CT] import map:",
      Object.keys(importEntries).length,
      "modules",
    );
  }

  // ---- inline linked stylesheets while preserving each source boundary ----
  let sourceSequence = 0;
  for (const link of Array.from(
    doc.querySelectorAll('link[rel="stylesheet"]'),
  )) {
    const href = link.getAttribute("href");
    const file = findFileByRelativePath(href, htmlDir);
    if (file) {
      const sourcePath = Array.from(assetFiles).find(
        ([, candidate]) => candidate === file,
      )?.[0] || cleanHref(href);
      const content = await expandCssImports(
        await file.text(),
        sourcePath,
        assetFiles,
        blobMap,
      );
      const style = doc.createElement("style");
      style.dataset.ctSource = `build-style-${++sourceSequence}`;
      style.dataset.ctName = sourcePath;
      style.textContent = content;
      link.replaceWith(style);
    }
  }

  // Register every style independently, including Angular critical/runtime CSS.
  let sourceOrder = 0;
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    if (style.type === "importmap") continue;
    const rewritten = rewriteUrlsInCss(style.textContent, blobMap);
    if (rewritten !== style.textContent) style.textContent = rewritten;
    if (!style.dataset.ctSource) {
      style.dataset.ctSource = `build-style-${++sourceSequence}`;
    }
    registerCssSource({
      id: style.dataset.ctSource,
      name: style.dataset.ctName || style.dataset.ctSource,
      kind: "build",
      text: style.textContent,
      order: sourceOrder++,
      owner: null,
    });
  }

  // Inline style attributes are editable sources too.
  for (const element of Array.from(doc.querySelectorAll("[style]"))) {
    const id = `build-attribute-${++sourceSequence}`;
    element.dataset.ctInlineSource = id;
    registerCssSource({
      id,
      name: `${element.tagName.toLowerCase()}[style]`,
      kind: "attribute",
      text: element.getAttribute("style") || "",
      order: sourceOrder++,
      owner: null,
    });
  }

  // ---- rewrite icon / preload / resource links ----
  doc
    .querySelectorAll(
      [
        'link[rel="icon"]',
        'link[rel="shortcut icon"]',
        'link[rel="apple-touch-icon"]',
        'link[rel="modulepreload"]',
        'link[rel="preload"][href]',
      ].join(","),
    )
    .forEach((link) => {
      const blobUrl = blobUrlForRef(
        link.getAttribute("href"),
        blobMap,
        htmlDir,
      );
      if (blobUrl) link.setAttribute("href", blobUrl);
    });

  // ---- handle scripts ----
  for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = script.getAttribute("src");
    const blobUrl = blobUrlForRef(src, blobMap, htmlDir);

    if (script.type === "module") {
      // Module source has already been rewritten to @ct/* import-map aliases.
      if (blobUrl) script.setAttribute("src", blobUrl);
    } else {
      // non-module scripts: inline them
      const file = findFileByRelativePath(src, htmlDir);
      if (file) {
        const content = await file.text();
        const inline = doc.createElement("script");
        if (script.type) inline.type = script.type;
        if (script.defer) inline.defer = true;
        if (script.async) inline.async = true;
        inline.textContent = content;
        script.replaceWith(inline);
      } else if (blobUrl) {
        script.setAttribute("src", blobUrl);
      }
    }
  }

  // ---- feed CSS to editor + color parser ----
  rebuildColorEntries();
  cssEditorEl.value = getCssEditorText();
  renderColorPanel();

  loadBuildHtml("<!DOCTYPE html>" + doc.documentElement.outerHTML);
  if (onBuildLoaded) onBuildLoaded("build");
}

export { loadBuild };

// Build upload — reads dist/ folder, inlines assets, injects capture script into iframe

import { state } from "./state.js";
import { parseTypeScript } from "./ts-parser.js";
import { loadBuildHtml, loadSiteUrl, readSiteCss } from "./preview.js";
import { updateMockBadge } from "./mocks.js";
import { extractColors } from "./css-parser.js";
import { renderColorPanel } from "./color-panel.js";

let cssEditorEl = null;
let onBuildLoaded = null;

export function initUpload(elements, callbacks) {
  cssEditorEl = elements.cssEditor;
  onBuildLoaded = callbacks.onBuildLoaded;

  const {
    dropZone,
    fileInput,
    tsInput,
    btnLoad,
    buildChips,
    tsChips,
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
  tsInput.addEventListener("change", (e) =>
    handleTsFiles(e.target.files, tsChips),
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

    cssEditorEl.value = "";
    state.colorEntries = [];
    state.replacements.clear();
    state.alphaOverrides.clear();
    renderColorPanel();

    const { css, skipped } = await readSiteCss();
    cssEditorEl.value = css;
    state.colorEntries = extractColors(css);
    state.replacements.clear();
    state.alphaOverrides.clear();
    renderColorPanel();
    if (!css) {
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

async function handleTsFiles(fileList, chipsEl) {
  state.parsedTsTypes = {};
  chipsEl.innerHTML = "";
  const chips = [];
  for (const f of fileList) {
    const text = await f.text();
    const types = parseTypeScript(text);
    Object.assign(state.parsedTsTypes, types);
    chips.push(
      `<span class="file-chip ts">${f.name} (${Object.keys(types).length} types)</span>`,
    );
  }
  chipsEl.innerHTML = chips.join("");
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
  // for (const [path, file] of state.buildFileMap) {
  //   if (file.name === "index.html") return { path, file };
  // }
  for (const [path, file] of state.buildFileMap) {
    if (path.endsWith(".html")) return { path, file };
  }
  return null;
}

function findFileByRelativePath(relativePath, htmlDir) {
  const fullPath = htmlDir + "/" + relativePath;
  if (state.buildFileMap.has(fullPath)) return state.buildFileMap.get(fullPath);

  const name = relativePath.split("/").pop().split("?")[0];
  for (const [path, file] of state.buildFileMap) {
    if (path.endsWith("/" + name) || path === "/" + name) return file;
  }
  return null;
}

function cleanHref(href) {
  if (!href) return "";
  return href
    .replace(/^\.?\//, "")
    .split("?")[0]
    .split("#")[0];
}

function rewriteUrlsInCss(css, blobMap) {
  let result = css.replace(
    /@import\s+url\(\s*['"]?([^'")]+)['"]?\s*\)/g,
    (match, ref) => {
      if (
        ref.startsWith("data:") ||
        ref.startsWith("blob:") ||
        ref.startsWith("http")
      )
        return match;
      const clean = cleanHref(ref);
      if (blobMap.has(clean)) return "@import url(" + blobMap.get(clean) + ")";
      return match;
    },
  );

  result = result.replace(/@import\s+['"]([^'"]+)['"]/g, (match, ref) => {
    if (
      ref.startsWith("data:") ||
      ref.startsWith("blob:") ||
      ref.startsWith("http")
    )
      return match;
    const clean = cleanHref(ref);
    if (blobMap.has(clean)) return "@import url(" + blobMap.get(clean) + ")";
    return match;
  });

  result = result.replace(/url\(\s*['"]?([^'")]+)['"]?\s*\)/g, (match, ref) => {
    if (
      ref.startsWith("data:") ||
      ref.startsWith("blob:") ||
      ref.startsWith("http")
    )
      return match;
    const clean = cleanHref(ref);
    if (blobMap.has(clean)) return "url(" + blobMap.get(clean) + ")";
    return match;
  });

  return result;
}

function buildCaptureScript(mocks) {
  var s = "(function(){";
  s += "var __MOCKS__=" + JSON.stringify(mocks) + ";";
  s += "var _f=window.fetch;";
  s += "window.fetch=function(input,init){";
  s +=
    'var url=typeof input==="string"?input:(input&&input.url)||String(input);';
  s += 'var method=((init&&init.method)||"GET").toUpperCase();';
  s += 'var key=method+" "+url;';
  s += "if(__MOCKS__[key]!==undefined){";
  s += "return Promise.resolve(new Response(JSON.stringify(__MOCKS__[key]),";
  s += '{status:200,headers:{"Content-Type":"application/json"}}));}';
  s += "return _f.call(window,input,init).then(function(res){";
  s +=
    'if(!res.ok){window.parent.postMessage({type:"ct-fetch-fail",url:url,method:method,status:res.status},"*");}';
  s += "return res;";
  s += "}).catch(function(err){";
  s +=
    'window.parent.postMessage({type:"ct-fetch-fail",url:url,method:method,error:err.message},"*");';
  s +=
    'return new Response("null",{status:0,headers:{"Content-Type":"application/json"}});});};';
  s += 'window.addEventListener("error",function(e){';
  s +=
    'window.parent.postMessage({type:"ct-runtime-error",message:e.message,filename:e.filename,lineno:e.lineno},"*");});';
  s += 'window.addEventListener("unhandledrejection",function(e){';
  s +=
    'window.parent.postMessage({type:"ct-unhandled-rejection",reason:String(e.reason)},"*");});';
  s += "})();";
  return s;
}

async function loadBuild() {
  state.failedEndpoints.clear();
  Object.keys(state.mockData).forEach((k) => delete state.mockData[k]);
  updateMockBadge();

  const found = findHtmlFile();
  if (!found) {
    alert("No html file found in uploaded files");
    return;
  }
  const { path: htmlPath, file: htmlFile } = found;
  const htmlDir = htmlPath.substring(0, htmlPath.lastIndexOf("/"));

  console.log("[CT] HTML:", htmlPath, "| dir:", htmlDir || "/");

  // ---- blob URLs for every asset under htmlDir ----
  const blobMap = new Map();
  for (const [path, file] of state.buildFileMap) {
    if (path === htmlPath) continue;
    if (htmlDir && !path.startsWith(htmlDir + "/")) continue; // if html is a root, ignore; if not, consume only files that in folder with html;
    const relativePath = htmlDir
      ? path.substring(htmlDir.length + 1)
      : path.substring(1);
    const buf = await file.arrayBuffer();
    const blob = new Blob([buf], { type: getMimeType(file.name) });
    blobMap.set(relativePath, URL.createObjectURL(blob));
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

  // ---- import map for all JS/MJS (handles static + dynamic import()) ----
  const importEntries = {};
  let hasModuleScripts = false;
  for (const [rel, url] of blobMap) {
    if (!/\.(js|mjs)$/.test(rel)) continue;
    importEntries["./" + rel] = url;
    importEntries[rel] = url;
  }

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
      Object.keys(importEntries).length / 2,
      "modules",
    );
  }

  // ---- inline CSS <link>s with url() rewriting ----
  let allCss = "";
  let firstInlinedStyle = null;

  for (const link of Array.from(
    doc.querySelectorAll('link[rel="stylesheet"]'),
  )) {
    const href = link.getAttribute("href");
    const clean = cleanHref(href);
    const file = findFileByRelativePath(clean, htmlDir);
    if (file) {
      let content = await file.text();
      content = rewriteUrlsInCss(content, blobMap);
      allCss += content + "\n";
      const style = doc.createElement("style");
      style.textContent = content;
      link.replaceWith(style);
      if (!firstInlinedStyle) firstInlinedStyle = style;
    }
  }

  // also collect pre-existing <style> content (Angular critical CSS)
  for (const style of Array.from(doc.querySelectorAll("style"))) {
    if (style === firstInlinedStyle) continue;
    if (style.type === "importmap") continue;
    const rewritten = rewriteUrlsInCss(style.textContent, blobMap);
    if (rewritten !== style.textContent) style.textContent = rewritten;
  }

  // ---- rewrite icon / resource links ----
  doc
    .querySelectorAll(
      'link[rel="icon"], link[rel="shortcut icon"], link[rel="apple-touch-icon"]',
    )
    .forEach((link) => {
      const clean = cleanHref(link.getAttribute("href"));
      if (blobMap.has(clean)) link.setAttribute("href", blobMap.get(clean));
    });

  // ---- handle scripts ----
  for (const script of Array.from(doc.querySelectorAll("script[src]"))) {
    const src = script.getAttribute("src");
    const clean = cleanHref(src);

    if (script.type === "module") {
      // module scripts: keep external, rewrite src to blob URL
      // import map handles all their import() / import from ... calls
      if (blobMap.has(clean)) {
        script.setAttribute("src", blobMap.get(clean));
      }
    } else {
      // non-module scripts: inline them
      const file = findFileByRelativePath(clean, htmlDir);
      if (file) {
        const content = await file.text();
        const inline = doc.createElement("script");
        if (script.type) inline.type = script.type;
        if (script.defer) inline.defer = true;
        if (script.async) inline.async = true;
        inline.textContent = content;
        script.replaceWith(inline);
      } else if (blobMap.has(clean)) {
        script.setAttribute("src", blobMap.get(clean));
      }
    }
  }

  // ---- inject capture + listener scripts (after import map, before modules) ----
  const anchor = doc.head.querySelector('script[type="importmap"]');

  const captureEl = doc.createElement("script");
  captureEl.textContent = buildCaptureScript(state.mockData);

  const listenerEl = doc.createElement("script");
  listenerEl.textContent =
    'window.addEventListener("message",function(e){' +
    'if(e.data&&e.data.type==="css-update"){' +
    'var s=document.getElementById("__ct");if(s)s.textContent=e.data.css;}});';

  if (anchor) {
    anchor.after(listenerEl);
    listenerEl.after(captureEl);
  } else {
    doc.head.insertBefore(captureEl, doc.head.firstChild);
    doc.head.insertBefore(listenerEl, captureEl);
  }

  // ---- mark first inlined <style> for CSS patching ----
  if (firstInlinedStyle) {
    firstInlinedStyle.id = "__ct";
  } else {
    const anyStyle = doc.querySelector("style");
    if (anyStyle) anyStyle.id = "__ct";
  }

  // ---- feed CSS to editor + color parser ----
  cssEditorEl.value = allCss;
  state.colorEntries = extractColors(allCss);
  state.replacements.clear();
  state.alphaOverrides.clear();
  renderColorPanel();

  loadBuildHtml("<!DOCTYPE html>" + doc.documentElement.outerHTML);
  if (onBuildLoaded) onBuildLoaded("build");
}

export { loadBuild };

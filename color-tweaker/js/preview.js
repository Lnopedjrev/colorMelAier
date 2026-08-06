// Iframe preview management — blob URL isolation + postMessage CSS patching

import { state } from './state.js';
import { extractAlpha, hexToRgba } from './utils.js';

let iframeEl = null;
let currentBlobUrl = null;
let isSiteUrl = false;
let siteMessageOrigin = "*";
let requestSequence = 0;
let inspectorActive = false;
let inspectorDocument = null;
let onColorsPicked = null;

const INSPECTED_COLOR_PROPERTIES = [
  'color',
  'background-color',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'outline-color',
  'text-decoration-color',
  'column-rule-color',
  'caret-color',
  'fill',
  'stroke',
];

const IFRAME_LISTENER =
  'window.addEventListener("message",function(e){' +
  'if(e.data&&e.data.type==="css-update"){' +
  'var s=document.getElementById("__ct");if(s)s.textContent=e.data.css;}});';

export function initPreview(iframe, callbacks = {}) {
  iframeEl = iframe;
  onColorsPicked = callbacks.onColorsPicked || null;
  iframeEl.addEventListener('load', syncInspector);
  window.addEventListener('message', (event) => {
    if (event.source !== iframeEl.contentWindow) return;
    if (!event.data || event.data.type !== 'ct-colors-picked') return;
    if (onColorsPicked) onColorsPicked(event.data.colors || []);
  });
}

export function isSiteUrlActive() {
  return isSiteUrl;
}

function collectElementColors(element) {
  const computed = element.ownerDocument.defaultView.getComputedStyle(element);
  const colors = new Set();
  for (const property of INSPECTED_COLOR_PROPERTIES) {
    const value = computed.getPropertyValue(property).trim();
    if (
      value &&
      value !== 'none' &&
      value !== 'transparent' &&
      value !== 'rgba(0, 0, 0, 0)'
    ) {
      colors.add(value);
    }
  }
  return Array.from(colors);
}

function handleInspectedClick(event) {
  if (!inspectorActive) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  if (onColorsPicked) onColorsPicked(collectElementColors(event.target));
}

function setInspectorCursor(doc, active) {
  let style = doc.getElementById('__ct-inspector');
  if (active && !style) {
    style = doc.createElement('style');
    style.id = '__ct-inspector';
    style.textContent = '*{cursor:crosshair!important}';
    (doc.head || doc.documentElement).appendChild(style);
  } else if (!active && style) {
    style.remove();
  }
}

function syncInspector() {
  if (inspectorDocument) {
    inspectorDocument.removeEventListener('click', handleInspectedClick, true);
    setInspectorCursor(inspectorDocument, false);
    inspectorDocument = null;
  }

  try {
    const doc = iframeEl.contentDocument;
    void iframeEl.contentWindow.location.href;
    if (!doc) throw new Error();
    inspectorDocument = doc;
    if (inspectorActive) {
      doc.addEventListener('click', handleInspectedClick, true);
      setInspectorCursor(doc, true);
    }
  } catch (error) {
    iframeEl.contentWindow.postMessage(
      { type: 'ct-inspect-mode', active: inspectorActive },
      siteMessageOrigin,
    );
  }
}

export function setPreviewInspector(active) {
  inspectorActive = active;
  syncInspector();
}

// Apply all color replacements to raw CSS text
function buildReplacement(originals, newHex6, alphaOverride) {
  const results = new Map();
  for (const orig of originals) {
    const origAlpha = extractAlpha(orig);
    const alpha = alphaOverride !== undefined ? alphaOverride : origAlpha;
    if (alpha !== null && alpha < 1) {
      results.set(orig, hexToRgba(newHex6, alpha));
    } else if (origAlpha !== null && alphaOverride !== undefined) {
      results.set(orig, hexToRgba(newHex6, alpha));
    } else {
      results.set(orig, newHex6);
    }
  }
  return results;
}

export function getProcessedCss(rawCss) {
  let css = rawCss;
  for (const [canon, newHex6] of state.replacements) {
    const entry = state.colorEntries.find(e => e.canonical === canon);
    if (!entry) continue;
    const alphaOv = state.alphaOverrides.has(canon) ? state.alphaOverrides.get(canon) : undefined;
    const mapping = buildReplacement(entry.originals, newHex6, alphaOv);
    for (const [orig, replacement] of mapping) {
      if (/^[a-zA-Z]+$/.test(orig)) {
        css = css.replace(new RegExp('\\b' + orig + '\\b', 'gi'), replacement);
      } else {
        css = css.split(orig).join(replacement);
      }
    }
  }
  return css;
}

function navigateIframe(html) {
  if (currentBlobUrl) URL.revokeObjectURL(currentBlobUrl);
  const blob = new Blob([html], { type: 'text/html' });
  currentBlobUrl = URL.createObjectURL(blob);
  isSiteUrl = false;
  iframeEl.src = currentBlobUrl;
}

// Navigate directly to a website and resolve after the iframe load event.
export function loadSiteUrl(url) {
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
  isSiteUrl = true;
  siteMessageOrigin = "*";

  // Turn the iframe's one-shot events into an awaitable navigation result.
  return new Promise((resolve, reject) => {
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error('The site did not finish loading within 15 seconds.'));
    }, 15000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      iframeEl.removeEventListener('load', onLoad);
      iframeEl.removeEventListener('error', onError);
    };
    const onLoad = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error('The site could not be loaded in the iframe.'));
    };

    iframeEl.addEventListener('load', onLoad, { once: true });
    iframeEl.addEventListener('error', onError, { once: true });
    iframeEl.src = url;
  });
}

function serializeStyleSheets(styleSheets) {
  const chunks = [];
  let skipped = 0;
  const visited = new Set();

  function visit(sheet) {
    if (!sheet || visited.has(sheet)) return;
    visited.add(sheet);
    if (sheet.ownerNode && sheet.ownerNode.id === '__ct') return;

    try {
      for (const rule of Array.from(sheet.cssRules)) {
        if (rule.type === 3 && rule.styleSheet) visit(rule.styleSheet);
        else chunks.push(rule.cssText);
      }
    } catch (error) {
      skipped++;
    }
  }

  for (const sheet of Array.from(styleSheets)) visit(sheet);
  return { css: chunks.filter(Boolean).join('\n\n'), skipped };
}

function requestSiteCss() {
  return new Promise((resolve, reject) => {
    const requestId = 'ct-css-' + Date.now() + '-' + (++requestSequence);
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error(
        'The site is cross-origin and did not answer the CSS query. Add color-tweaker-bridge.js to its index.html.',
      ));
    }, 3000);

    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener('message', onMessage);
    };
    const onMessage = (event) => {
      if (event.source !== iframeEl.contentWindow) return;
      if (!event.data || event.data.type !== 'ct-css-response') return;
      if (event.data.requestId !== requestId) return;
      cleanup();
      siteMessageOrigin = event.origin;
      resolve({
        css: typeof event.data.css === 'string' ? event.data.css : '',
        skipped: Number(event.data.skipped) || 0,
      });
    };

    window.addEventListener('message', onMessage);
    iframeEl.contentWindow.postMessage({ type: 'ct-css-request', requestId }, '*');
  });
}

// Read directly for same-origin pages; otherwise ask the optional dev-server bridge.
export async function readSiteCss() {
  try {
    const doc = iframeEl.contentDocument;
    void iframeEl.contentWindow.location.href;
    if (!doc) throw new Error();
    return serializeStyleSheets(doc.styleSheets);
  } catch (error) {
    return requestSiteCss();
  }
}

// Full rebuild — editor mode (HTML/CSS/JS textareas)
export function updatePreview(rawHtml, rawCss, rawJs) {
  const css = getProcessedCss(rawCss);
  const doc = '<!DOCTYPE html><html><head><meta charset="UTF-8">' +
    '<style id="__ct">' + css + '</style>' +
    '<script>' + IFRAME_LISTENER + '<\/script>' +
    '</head><body>' + rawHtml +
    '<script>' + rawJs + '<\/script></body></html>';
  navigateIframe(doc);
}

// CSS-only patch via postMessage (no iframe reload)
export function patchCss(rawCss) {
  if (isSiteUrl) {
    try {
      const doc = iframeEl.contentDocument;
      void iframeEl.contentWindow.location.href;
      let style = doc.getElementById('__ct');
      if (!style) {
        style = doc.createElement('style');
        style.id = '__ct';
        (doc.head || doc.documentElement).appendChild(style);
      }
      style.textContent = getProcessedCss(rawCss);
    } catch (error) {
      iframeEl.contentWindow.postMessage(
        { type: 'ct-css-update', css: getProcessedCss(rawCss) },
        siteMessageOrigin,
      );
    }
  } else if (iframeEl && iframeEl.contentWindow) {
    iframeEl.contentWindow.postMessage(
      { type: 'css-update', css: getProcessedCss(rawCss) }, '*'
    );
  }
}

// Full rebuild — build upload mode (pre-assembled HTML)
export function loadBuildHtml(html) {
  navigateIframe(html);
}

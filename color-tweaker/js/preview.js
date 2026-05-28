// Iframe preview management — blob URL isolation + postMessage CSS patching

import { state } from './state.js';
import { extractAlpha, hexToRgba } from './utils.js';

let iframeEl = null;
let currentBlobUrl = null;

const IFRAME_LISTENER =
  'window.addEventListener("message",function(e){' +
  'if(e.data&&e.data.type==="css-update"){' +
  'var s=document.getElementById("__ct");if(s)s.textContent=e.data.css;}});';

export function initPreview(iframe) {
  iframeEl = iframe;
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
  iframeEl.src = currentBlobUrl;
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
  if (iframeEl && iframeEl.contentWindow) {
    iframeEl.contentWindow.postMessage(
      { type: 'css-update', css: getProcessedCss(rawCss) }, '*'
    );
  }
}

// Full rebuild — build upload mode (pre-assembled HTML)
export function loadBuildHtml(html) {
  navigateIframe(html);
}

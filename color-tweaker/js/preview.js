// Iframe preview management — blob URL isolation + postMessage CSS patching

import { state } from './state.js';
import { extractAlpha, hexToRgba } from './utils.js';

let iframeEl = null;
let currentBlobUrl = null;
let isSiteUrl = false;

const IFRAME_LISTENER =
  'window.addEventListener("message",function(e){' +
  'if(e.data&&e.data.type==="css-update"){' +
  'var s=document.getElementById("__ct");if(s)s.textContent=e.data.css;}});';

export function initPreview(iframe) {
  iframeEl = iframe;
}

export function isSiteUrlActive() {
  return isSiteUrl;
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

// The browser permits CSSOM access only for same-origin pages/stylesheets.
export function readSiteCss() {
  let doc;
  try {
    doc = iframeEl.contentDocument;
    void iframeEl.contentWindow.location.href;
  } catch (error) {
    throw new Error('The site loaded, but its CSS is cross-origin and cannot be inspected by the browser.');
  }

  if (!doc) throw new Error('The site loaded, but its document is not accessible.');

  const chunks = [];
  let skipped = 0;
  for (const sheet of Array.from(doc.styleSheets)) {
    if (sheet.ownerNode && sheet.ownerNode.id === '__ct') continue;
    try {
      chunks.push(Array.from(sheet.cssRules, rule => rule.cssText).join('\n'));
    } catch (error) {
      skipped++;
    }
  }

  return { css: chunks.filter(Boolean).join('\n\n'), skipped };
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
      // Cross-origin pages cannot be modified from the parent application.
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

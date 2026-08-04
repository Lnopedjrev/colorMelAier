// ColorTweaker dev-server bridge.
// Serve this file from the site being previewed and add this to its index.html:
// <script src="/color-tweaker-bridge.js" data-color-tweaker-origin="http://localhost:3000"></script>

(function () {
  "use strict";

  const script = document.currentScript;
  const allowedOrigin = script && script.dataset.colorTweakerOrigin;

  function accepts(event) {
    return (
      event.source === window.parent &&
      (!allowedOrigin || event.origin === allowedOrigin)
    );
  }

  function serializeStyleSheets() {
    const chunks = [];
    const visited = new Set();
    let skipped = 0;

    function visit(sheet) {
      if (!sheet || visited.has(sheet)) return;
      visited.add(sheet);
      if (sheet.ownerNode && sheet.ownerNode.id === "__ct") return;

      try {
        for (const rule of Array.from(sheet.cssRules)) {
          if (rule.type === 3 && rule.styleSheet) visit(rule.styleSheet);
          else chunks.push(rule.cssText);
        }
      } catch (error) {
        skipped++;
      }
    }

    for (const sheet of Array.from(document.styleSheets)) visit(sheet);
    return { css: chunks.filter(Boolean).join("\n\n"), skipped };
  }

  function applyCss(css) {
    let style = document.getElementById("__ct");
    if (!style) {
      style = document.createElement("style");
      style.id = "__ct";
      (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = css;
  }

  window.addEventListener("message", (event) => {
    if (!accepts(event) || !event.data) return;

    if (event.data.type === "ct-css-request") {
      const result = serializeStyleSheets();
      event.source.postMessage(
        {
          type: "ct-css-response",
          requestId: event.data.requestId,
          css: result.css,
          skipped: result.skipped,
        },
        event.origin,
      );
    } else if (
      event.data.type === "ct-css-update" &&
      typeof event.data.css === "string"
    ) {
      applyCss(event.data.css);
    }
  });
})();

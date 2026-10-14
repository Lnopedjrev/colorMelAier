(() => {
  "use strict";

  const existing = globalThis.__COLOR_TWEAKER_PAGE_HOOKS__;
  if (existing) {
    existing.active = true;
    return;
  }

  const START_EVENT = "ct:page-hooks-start";
  const STOP_EVENT = "ct:page-hooks-stop";
  const SOURCES_CHANGED_EVENT = "ct:page-sources-changed";
  const state = { active: true };

  function signalSourceChange() {
    if (state.active) document.dispatchEvent(new Event(SOURCES_CHANGED_EVENT));
  }

  function wrapMethod(prototype, name, afterCall) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
    if (!descriptor || typeof descriptor.value !== "function") return;
    const original = descriptor.value;
    try {
      Object.defineProperty(prototype, name, {
        ...descriptor,
        value: function (...args) {
          const result = Reflect.apply(original, this, args);
          afterCall(result);
          return result;
        },
      });
    } catch {
      // A page can lock native prototypes; the DOM observer still handles
      // ordinary style/link/attribute changes in that case.
    }
  }

  function wrapAdoptedStyleSheetsSetter(prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(
      prototype,
      "adoptedStyleSheets",
    );
    if (!descriptor?.set) return;
    const originalSetter = descriptor.set;
    try {
      Object.defineProperty(prototype, "adoptedStyleSheets", {
        ...descriptor,
        set(value) {
          Reflect.apply(originalSetter, this, [value]);
          signalSourceChange();
        },
      });
    } catch {
      // See wrapMethod: a locked descriptor cannot be observed this way.
    }
  }

  wrapMethod(Element.prototype, "attachShadow", (shadowRoot) => {
    if (shadowRoot?.mode === "open") signalSourceChange();
  });

  for (const method of ["insertRule", "deleteRule", "addRule", "removeRule", "replaceSync"]) {
    wrapMethod(CSSStyleSheet.prototype, method, signalSourceChange);
  }
  wrapMethod(CSSStyleSheet.prototype, "replace", (result) => {
    Promise.resolve(result).then(signalSourceChange, () => {});
  });

  wrapAdoptedStyleSheetsSetter(Document.prototype);
  if (globalThis.ShadowRoot) wrapAdoptedStyleSheetsSetter(ShadowRoot.prototype);

  document.addEventListener(START_EVENT, () => {
    state.active = true;
  });
  document.addEventListener(STOP_EVENT, () => {
    state.active = false;
  });
  globalThis.__COLOR_TWEAKER_PAGE_HOOKS__ = state;
})();

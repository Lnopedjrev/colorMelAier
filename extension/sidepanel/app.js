import { createBrowserColorAdapter } from "../shared/browser-color.js";
import { createCssParser } from "../shared/css-parser.js";
import { createCssSourceStore } from "../shared/css-sources.js";
import { createColorTweakerState } from "../shared/state.js";

// The side panel owns independent state. Page-specific DOM/CSSOM references
// will remain in the content controller once active-tab support is added.
export const state = createColorTweakerState();
const colorAdapter = createBrowserColorAdapter(document);
const parser = createCssParser(colorAdapter);
export const cssSourceStore = createCssSourceStore({
  state,
  buildColorEntries: parser.buildColorEntries,
  extractAlpha: colorAdapter.extractAlpha,
  hexToRgba: colorAdapter.hexToRgba,
});

document.documentElement.dataset.cssMode = state.cssMode;

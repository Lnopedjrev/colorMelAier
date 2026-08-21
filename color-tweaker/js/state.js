// Shared mutable state — single source of truth for all modules
export const state = {
  colorEntries: [],
  cssSources: [],
  cssMode: "editor",
  replacements: new Map(),
  alphaOverrides: new Map(),
  buildFileMap: new Map(),
};

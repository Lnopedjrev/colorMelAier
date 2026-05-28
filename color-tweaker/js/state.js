// Shared mutable state — single source of truth for all modules
export const state = {
  colorEntries: [],
  replacements: new Map(),
  alphaOverrides: new Map(),
  buildFileMap: new Map(),
  parsedTsTypes: {},
  failedEndpoints: new Map(),
  mockData: {}
};

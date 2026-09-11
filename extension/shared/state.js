/**
 * Creates the serializable, UI-independent part of ColorTweaker state.
 * Runtime-specific state (DOM owners, uploaded Files, object URLs) belongs to
 * the environment that uses the shared core.
 */
export function createColorTweakerState(extra = {}) {
  return {
    colorEntries: [],
    cssSources: [],
    cssMode: "editor",
    replacements: new Map(),
    alphaOverrides: new Map(),
    ...extra,
  };
}

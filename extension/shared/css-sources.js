// Shared CSS source registry and exact occurrence-based replacement logic.

const MARKER_RE = /\/\*\s*=== ColorTweaker source:([^\s]+)[^*]*===\s*\*\//g;

export function safeSourceId(value) {
  return String(value).replace(/[^a-zA-Z0-9_.:-]+/g, "-");
}

export function toSerializableCssSource(source) {
  return {
    id: source.id,
    name: source.name,
    kind: source.kind,
    text: source.text,
    order: source.order,
    href: source.href,
  };
}

function assertStoreDependencies(dependencies) {
  const { state, buildColorEntries, extractAlpha, hexToRgba } = dependencies;
  if (!state || !Array.isArray(state.cssSources)) {
    throw new TypeError("createCssSourceStore requires state.cssSources");
  }
  for (const [name, value] of Object.entries({
    buildColorEntries,
    extractAlpha,
    hexToRgba,
  })) {
    if (typeof value !== "function") {
      throw new TypeError(`createCssSourceStore requires ${name}`);
    }
  }
}

/**
 * Creates a CSS-source store bound to one environment's state and color tools.
 * The standalone page, side panel, and sandbox can each own an independent
 * store while sharing identical source/replacement behavior.
 */
export function createCssSourceStore(dependencies) {
  assertStoreDependencies(dependencies);
  const { state, buildColorEntries, extractAlpha, hexToRgba } = dependencies;

  function resetCssSources(mode = "editor") {
    state.cssMode = mode;
    state.cssSources = [];
    state.colorEntries = [];
    state.replacements.clear();
    state.alphaOverrides.clear();
  }

  function registerCssSource(source) {
    if (!source?.id) {
      throw new TypeError("registerCssSource requires source.id");
    }
    const id = safeSourceId(source.id);
    const existing = state.cssSources.find((item) => item.id === id);
    const record = {
      id,
      name: source.name || id,
      kind: source.kind || "inline",
      text: source.text || "",
      order: source.order ?? state.cssSources.length,
      href: source.href || null,
      owner: source.owner ?? null,
      occurrences: [],
    };
    if (existing) Object.assign(existing, record);
    else state.cssSources.push(record);
    state.cssSources.sort((a, b) => a.order - b.order);
    return existing || record;
  }

  function rebuildColorEntries(clearReplacements = false) {
    if (clearReplacements) {
      state.replacements.clear();
      state.alphaOverrides.clear();
    }
    state.colorEntries = buildColorEntries(state.cssSources);
    return state.colorEntries;
  }

  function rebuildChangedColorEntries(sourceIds) {
    state.colorEntries = buildColorEntries(state.cssSources, {
      reparse: false,
      sourceIds: new Set(sourceIds),
    });
    return state.colorEntries;
  }

  function replacementFor(entry, occurrence) {
    const hex = state.replacements.get(entry.id);
    if (!hex) return occurrence.original;
    const alphaOverride = state.alphaOverrides.has(entry.id)
      ? state.alphaOverrides.get(entry.id)
      : undefined;
    const originalAlpha = extractAlpha(occurrence.original);
    const alpha = alphaOverride !== undefined ? alphaOverride : originalAlpha;
    return alpha !== null && alpha !== undefined && alpha < 1
      ? hexToRgba(hex, alpha)
      : hex;
  }

  function processedSourceText(source) {
    const edits = [];
    for (const entry of state.colorEntries) {
      if (!state.replacements.has(entry.id)) continue;
      for (const occurrence of entry.occurrences) {
        if (occurrence.sourceId !== source.id) continue;
        edits.push({
          start: occurrence.start,
          end: occurrence.end,
          text: replacementFor(entry, occurrence),
        });
      }
    }
    edits.sort((a, b) => b.start - a.start);
    let text = source.text;
    for (const edit of edits) {
      text = text.substring(0, edit.start) + edit.text + text.substring(edit.end);
    }
    return text;
  }

  function getCssSourceUpdates() {
    return state.cssSources.map((source) => ({
      id: source.id,
      kind: source.kind,
      sourceText: source.text,
      text: processedSourceText(source),
    }));
  }

  function getCombinedCss(processed = false) {
    return state.cssSources
      .map((source) => {
        const text = processed ? processedSourceText(source) : source.text;
        return `/* === ColorTweaker source:${source.id} ${source.name} === */\n${text}`;
      })
      .join("\n\n");
  }

  function getFlattenedCss(processed = false) {
    return state.cssSources
      .map((source) => (processed ? processedSourceText(source) : source.text))
      .filter(Boolean)
      .join("\n\n");
  }

  function getCssEditorText() {
    if (
      state.cssSources.length === 1 &&
      state.cssSources[0].kind === "editor"
    ) {
      return state.cssSources[0].text;
    }
    return getCombinedCss();
  }

  function updateSourcesFromCombinedCss(css) {
    const matches = Array.from(css.matchAll(MARKER_RE));
    if (!matches.length) {
      if (state.cssSources.length === 1) state.cssSources[0].text = css;
      else if (state.cssSources.length > 1) {
        state.cssSources[0].text = css;
        for (const source of state.cssSources.slice(1)) source.text = "";
      } else {
        resetCssSources("editor");
        registerCssSource({ id: "editor", name: "Editor CSS", text: css });
      }
      return;
    }

    const updatedIds = new Set();
    for (let i = 0; i < matches.length; i++) {
      const id = matches[i][1];
      const start = matches[i].index + matches[i][0].length;
      const end = i + 1 < matches.length ? matches[i + 1].index : css.length;
      const source = state.cssSources.find((item) => item.id === id);
      if (source) {
        source.text = css.substring(start, end).replace(/^\s*\n/, "").trimEnd();
        updatedIds.add(id);
      }
    }
    for (const source of state.cssSources) {
      if (!updatedIds.has(source.id)) source.text = "";
    }
  }

  function setEditorCss(css) {
    resetCssSources("editor");
    registerCssSource({
      id: "editor",
      name: "Editor CSS",
      kind: "editor",
      text: css,
    });
    rebuildColorEntries();
  }

  return {
    resetCssSources,
    registerCssSource,
    rebuildColorEntries,
    rebuildChangedColorEntries,
    processedSourceText,
    getCssSourceUpdates,
    getCombinedCss,
    getFlattenedCss,
    getCssEditorText,
    updateSourcesFromCombinedCss,
    setEditorCss,
  };
}

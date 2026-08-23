// Source-aware CSS color extraction with exact token ranges.

import {
  NAMED_COLORS,
  isValidColor,
  toCanonical,
  canonicalToHex6,
} from "./utils.js";

const COLOR_FUNCTIONS = new Set([
  "rgb",
  "rgba",
  "hsl",
  "hsla",
  "hwb",
  "lab",
  "lch",
  "oklab",
  "oklch",
  "color",
  "color-mix",
  "light-dark",
]);

function ignoredRanges(value) {
  const ranges = [];
  let quote = null;
  let start = -1;
  for (let i = 0; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) {
        ranges.push([start, i + 1]);
        quote = null;
      }
    } else if (char === "/" && value[i + 1] === "*") {
      const rangeStart = i;
      const close = value.indexOf("*/", i + 2);
      i = close < 0 ? value.length - 1 : close + 1;
      ranges.push([rangeStart, i + 1]);
    } else if (char === '"' || char === "'") {
      quote = char;
      start = i;
    } else if (/^url\s*\(/i.test(value.substring(i))) {
      let depth = 0;
      const rangeStart = i;
      for (; i < value.length; i++) {
        if (value[i] === "(") depth++;
        else if (value[i] === ")" && --depth === 0) break;
      }
      ranges.push([rangeStart, i + 1]);
    }
  }
  if (quote) ranges.push([start, value.length]);
  return ranges;
}

function overlaps(ranges, start, end) {
  return ranges.some(([a, b]) => start < b && end > a);
}

function previousCodeIndex(css, start, ignored) {
  let index = start - 1;
  while (index >= 0) {
    if (/\s/.test(css[index])) {
      index--;
      continue;
    }
    const range = ignored.find(([from, to]) => index >= from && index < to);
    if (range) {
      index = range[0] - 1;
      continue;
    }
    return index;
  }
  return -1;
}

function findClosingParen(text, openIndex) {
  let depth = 0;
  let quote = null;
  for (let i = openIndex; i < text.length; i++) {
    const char = text[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && --depth === 0) return i;
  }
  return -1;
}

function colorTokens(value, absoluteStart) {
  const tokens = [];
  const occupied = ignoredRanges(value);
  let match;

  const functionRe = /\b([a-z][\w-]*)\s*\(/gi;
  while ((match = functionRe.exec(value))) {
    const name = match[1].toLowerCase();
    if (!COLOR_FUNCTIONS.has(name)) continue;
    const open = value.indexOf("(", match.index);
    const close = findClosingParen(value, open);
    if (close < 0) continue;
    const candidate = value.substring(match.index, close + 1);
    if (isValidColor(candidate)) {
      tokens.push({
        original: candidate,
        start: absoluteStart + match.index,
        end: absoluteStart + close + 1,
        type: "inline",
      });
      occupied.push([match.index, close + 1]);
    }
    functionRe.lastIndex = close + 1;
  }

  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  while ((match = hexRe.exec(value))) {
    if (overlaps(occupied, match.index, match.index + match[0].length))
      continue;
    tokens.push({
      original: match[0],
      start: absoluteStart + match.index,
      end: absoluteStart + match.index + match[0].length,
      type: "inline",
    });
  }

  const wordRe = /\b[a-zA-Z]+\b/g;
  while ((match = wordRe.exec(value))) {
    if (overlaps(occupied, match.index, match.index + match[0].length))
      continue;
    if (!NAMED_COLORS.has(match[0].toLowerCase()) && !isValidColor(match[0])) {
      continue;
    }
    tokens.push({
      original: match[0],
      start: absoluteStart + match.index,
      end: absoluteStart + match.index + match[0].length,
      type: "named",
    });
  }

  return tokens.sort((a, b) => a.start - b.start);
}

function declarationEnd(css, start) {
  let depth = 0;
  let quote = null;
  for (let i = start; i < css.length; i++) {
    const char = css[i];
    if (quote) {
      if (char === "\\") i++;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === "/" && css[i + 1] === "*") {
      const close = css.indexOf("*/", i + 2);
      i = close < 0 ? css.length - 1 : close + 1;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === "(") depth++;
    else if (char === ")" && depth) depth--;
    else if (depth === 0 && (char === ";" || char === "}")) return i;
  }
  return css.length;
}

export function parseCssSource(css, sourceId = "editor") {
  const occurrences = [];
  const ignored = ignoredRanges(css).filter(
    ([start]) => css.substring(start, start + 2) === "/*",
  );
  const declarationRe = /(--[\w-]+|[\w-]+)\s*:\s*/g;
  let match;

  while ((match = declarationRe.exec(css))) {
    if (overlaps(ignored, match.index, declarationRe.lastIndex)) continue;
    const previous = previousCodeIndex(css, match.index, ignored);
    if (previous >= 0 && css[previous] !== "{" && css[previous] !== ";") {
      continue;
    }

    const property = match[1];
    const valueStart = declarationRe.lastIndex;
    const end = declarationEnd(css, valueStart);
    const rawValue = css.substring(valueStart, end);
    const leading = rawValue.length - rawValue.trimStart().length;
    const trailing = rawValue.trimEnd().length;
    const value = rawValue.trim();
    if (!value) continue;

    const isVariable = property.startsWith("--");
    if (isVariable && isValidColor(value)) {
      occurrences.push({
        sourceId,
        property,
        variableName: property,
        original: value,
        start: valueStart + leading,
        end: valueStart + trailing,
        type: "variable",
      });
    } else {
      for (const token of colorTokens(rawValue, valueStart)) {
        occurrences.push({
          sourceId,
          property,
          variableName: isVariable ? property : null,
          ...token,
          type: isVariable ? "variable" : token.type,
        });
      }
    }
    declarationRe.lastIndex = end + 1;
  }

  return occurrences
    .map((occurrence) => ({
      ...occurrence,
      canonical: toCanonical(occurrence.original),
    }))
    .filter((occurrence) => occurrence.canonical);
}

export function buildColorEntries(
  sources,
  { reparse = true, sourceIds = null } = {},
) {
  const found = new Map();
  for (const source of sources) {
    if (
      reparse ||
      !Array.isArray(source.occurrences) ||
      sourceIds?.has(source.id)
    ) {
      source.occurrences = parseCssSource(source.text, source.id);
    }
    for (const occurrence of source.occurrences) {
      const key = occurrence.variableName
        ? `variable:${occurrence.variableName}:${occurrence.canonical}`
        : `color:${occurrence.canonical}`;
      let entry = found.get(key);
      if (!entry) {
        entry = {
          id: key,
          canonical: occurrence.canonical,
          hex6: canonicalToHex6(occurrence.canonical),
          originals: new Set(),
          occurrences: [],
          sourceIds: new Set(),
          type: occurrence.type,
          name: occurrence.variableName || null,
          count: 0,
        };
        found.set(key, entry);
      }
      entry.originals.add(occurrence.original);
      entry.occurrences.push(occurrence);
      entry.sourceIds.add(source.id);
      entry.count++;
      if (occurrence.type === "named" && entry.type !== "variable") {
        entry.type = "named";
      }
    }
  }

  return Array.from(found.values()).sort((a, b) => {
    if (a.type === "variable" && b.type !== "variable") return -1;
    if (a.type !== "variable" && b.type === "variable") return 1;
    return b.count - a.count;
  });
}

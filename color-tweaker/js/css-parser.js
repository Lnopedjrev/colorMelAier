// Extracts all color values from a CSS string, grouped by canonical color

import { NAMED_COLORS, isValidColor, toCanonical, canonicalToHex6 } from './utils.js';

export function extractColors(css) {
  const found = new Map();

  function add(original, type, name) {
    const canon = toCanonical(original);
    if (!canon) return;
    if (found.has(canon)) {
      const e = found.get(canon);
      e.originals.add(original);
      e.count++;
      if (type === 'variable' && !e.name) { e.name = name; e.type = 'variable'; }
    } else {
      found.set(canon, {
        canonical: canon,
        hex6: canonicalToHex6(canon),
        originals: new Set([original]),
        type, name: name || null, count: 1
      });
    }
  }

  let m;

  const varRe = /(--[\w-]+)\s*:\s*([^;}\n]+)/g;
  while ((m = varRe.exec(css)) !== null) {
    const val = m[2].trim();
    if (isValidColor(val)) add(val, 'variable', m[1]);
  }

  const hexRe = /#[0-9a-fA-F]{3,8}\b/g;
  while ((m = hexRe.exec(css)) !== null) add(m[0], 'inline');

  const rgbRe = /rgba?\([^)]+\)/gi;
  while ((m = rgbRe.exec(css)) !== null) add(m[0], 'inline');

  const hslRe = /hsla?\([^)]+\)/gi;
  while ((m = hslRe.exec(css)) !== null) add(m[0], 'inline');

  const declRe = /[\w-]+\s*:\s*([^;}\n]+)/g;
  while ((m = declRe.exec(css)) !== null) {
    const words = m[1].match(/\b[a-zA-Z]+\b/g) || [];
    for (const w of words) {
      if (NAMED_COLORS.has(w.toLowerCase())) add(w, 'named');
    }
  }

  const entries = Array.from(found.values());
  entries.sort((a, b) => {
    if (a.type === 'variable' && b.type !== 'variable') return -1;
    if (a.type !== 'variable' && b.type === 'variable') return 1;
    return b.count - a.count;
  });
  return entries;
}

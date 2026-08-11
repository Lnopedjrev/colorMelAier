// Color panel rendering — swatches, pickers, alpha sliders

import { state } from "./state.js";
import {
  hexToRgba,
  entryHasAlpha,
  getEntryAlpha,
  toCanonical,
} from "./utils.js";
import { patchCss } from "./preview.js";

let colorListEl = null;
let cpCountEl = null;
export function initColorPanel(listEl, countEl) {
  colorListEl = listEl;
  cpCountEl = countEl;
}

function updateSwatch(idx) {
  const entry = state.colorEntries[idx];
  const hex = state.replacements.has(entry.id)
    ? state.replacements.get(entry.id)
    : entry.hex6;
  const alpha = getEntryAlpha(entry, state.alphaOverrides);
  const color = hexToRgba(hex, alpha);
  const row = colorListEl.querySelector(`.color-entry[data-idx="${idx}"]`);
  if (row) row.querySelector(".swatch-inner").style.background = color;
}

function onColorPick(e) {
  const idx = parseInt(e.target.dataset.idx);
  const entry = state.colorEntries[idx];
  state.replacements.set(entry.id, e.target.value);
  updateSwatch(idx);
  patchCss();
}

export function setSiteTabsGuarded(guarded) {
  for (const key of ["html", "js"]) {
    const tab = tabs.querySelector(`[data-tab="${key}"]`);
    tab.classList.toggle("guarded", guarded);
    tab.setAttribute("aria-disabled", String(guarded));
    if (guarded) {
      tab.title = "Opening this editor can replace the loaded preview";
    } else {
      tab.removeAttribute("title");
    }
  }
}

function onAlphaPick(e) {
  const idx = parseInt(e.target.dataset.idx);
  const entry = state.colorEntries[idx];
  const alpha = parseFloat(e.target.value);
  state.alphaOverrides.set(entry.id, alpha);
  e.target.closest(".alpha-row").querySelector("label").textContent =
    Math.round(alpha * 100) + "%";
  if (!state.replacements.has(entry.id))
    state.replacements.set(entry.id, entry.hex6);
  updateSwatch(idx);
  patchCss();
}

export function renderColorPanel() {
  cpCountEl.textContent = state.colorEntries.length;

  if (!state.colorEntries.length) {
    colorListEl.innerHTML =
      '<div class="empty">No colors detected in CSS</div>';
    return;
  }

  colorListEl.innerHTML = state.colorEntries
    .map((entry, i) => {
      const currentHex = state.replacements.has(entry.id)
        ? state.replacements.get(entry.id)
        : entry.hex6;
      const label = entry.name || Array.from(entry.originals)[0];
      const badgeCls =
        entry.type === "variable" ? "v" : entry.type === "named" ? "n" : "";
      const badgeLabel =
        entry.type === "variable"
          ? "var"
          : entry.type === "named"
            ? "named"
            : "inline";
      const alpha = getEntryAlpha(entry, state.alphaOverrides);
      const showAlpha = entryHasAlpha(entry);
      const swatchColor = showAlpha ? hexToRgba(currentHex, alpha) : currentHex;

      let html = `<div class="color-entry" data-idx="${i}">
      <div class="swatch"><div class="swatch-inner" style="background:${swatchColor}"></div></div>
      <div class="c-info">
        <div class="c-value" title="${Array.from(entry.originals).join(", ")}">${label}</div>
        <div class="c-meta">
          <span class="badge ${badgeCls}">${badgeLabel}</span>
          <span class="c-count">${entry.count}x</span>
          <span class="c-count">${entry.sourceIds.size} source${entry.sourceIds.size === 1 ? "" : "s"}</span>
        </div>
      </div>
      <div class="picker-wrap">
        <input type="color" value="${currentHex}" data-idx="${i}">
      </div>
    </div>`;

      if (showAlpha) {
        html += `<div class="alpha-row" data-idx="${i}">
        <label>${Math.round(alpha * 100)}%</label>
        <input type="range" min="0" max="1" step="0.01" value="${alpha}" data-idx="${i}">
      </div>`;
      } else {
        html += `<div class="alpha-row" data-idx="${i}">
        <label>100%</label>
        <input type="range" min="0" max="1" step="0.01" value="1" data-idx="${i}">
      </div>`;
      }
      return html;
    })
    .join("");

  colorListEl
    .querySelectorAll('input[type="color"]')
    .forEach((input) => input.addEventListener("input", onColorPick));
  colorListEl
    .querySelectorAll('.alpha-row input[type="range"]')
    .forEach((input) => input.addEventListener("input", onAlphaPick));
}

export function highlightColorEntries(colors) {
  const canonicalColors = new Set(
    colors.map((color) => toCanonical(color)).filter(Boolean),
  );
  let firstMatch = null;
  let matchCount = 0;

  colorListEl.querySelectorAll(".color-entry").forEach((row) => {
    const entry = state.colorEntries[Number(row.dataset.idx)];
    const replacement = entry && state.replacements.get(entry.id);
    const currentCanonical = replacement
      ? toCanonical(
          hexToRgba(replacement, getEntryAlpha(entry, state.alphaOverrides)),
        )
      : entry?.canonical;
    const matches = entry && canonicalColors.has(currentCanonical);
    row.classList.toggle("highlighted", Boolean(matches));
    if (matches) {
      matchCount++;
      if (!firstMatch) firstMatch = row;
    }
  });

  if (firstMatch) {
    firstMatch.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
  return matchCount;
}

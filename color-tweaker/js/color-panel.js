// Color panel rendering — swatches, pickers, alpha sliders

import { state } from "./state.js";
import {
  hexToRgba,
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
      const swatchColor = hexToRgba(currentHex, alpha);

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

      html += `<div class="alpha-row" data-idx="${i}">
        <label>${Math.round(alpha * 100)}%</label>
        <input type="range" min="0" max="1" step="0.01" value="${alpha}" data-idx="${i}">
      </div>`;
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

const PROPERTY_SHORTHANDS = {
  "background-color": ["background"],
  "border-top-color": ["border", "border-color", "border-top"],
  "border-right-color": ["border", "border-color", "border-right"],
  "border-bottom-color": ["border", "border-color", "border-bottom"],
  "border-left-color": ["border", "border-color", "border-left"],
  "outline-color": ["outline"],
  "text-decoration-color": ["text-decoration"],
  "column-rule-color": ["column-rule"],
};

function entryUsesProperty(entry, property) {
  if (!property) return false;
  const accepted = new Set([property, ...(PROPERTY_SHORTHANDS[property] || [])]);
  return entry.occurrences.some((occurrence) =>
    accepted.has(occurrence.property),
  );
}

function currentCanonical(entry) {
  const replacement = state.replacements.get(entry.id);
  return replacement
    ? toCanonical(
        hexToRgba(replacement, getEntryAlpha(entry, state.alphaOverrides)),
      )
    : entry.canonical;
}

function scrollEntryIntoPanel(row) {
  const panel = colorListEl.closest(".color-panel");
  if (!panel) {
    row.scrollIntoView({ block: "center" });
    return;
  }

  const panelRect = panel.getBoundingClientRect();
  const rowRect = row.getBoundingClientRect();
  const headerHeight = panel.querySelector(".cp-head")?.offsetHeight || 0;
  const visibleTop = panelRect.top + headerHeight;
  if (rowRect.top >= visibleTop && rowRect.bottom <= panelRect.bottom) return;

  const visibleHeight = panel.clientHeight - headerHeight;
  panel.scrollTo({
    top:
      panel.scrollTop +
      rowRect.top -
      visibleTop -
      Math.max(0, (visibleHeight - rowRect.height) / 2),
    behavior: "auto",
  });
}

export function highlightColorEntries(values) {
  const candidates = values
    .map((value) =>
      typeof value === "string"
        ? { property: null, canonical: toCanonical(value) }
        : {
            property: value.property || null,
            canonical: toCanonical(value.color),
          },
    )
    .filter((candidate) => candidate.canonical);
  const rows = Array.from(colorListEl.querySelectorAll(".color-entry")).map(
    (row) => ({
      row,
      entry: state.colorEntries[Number(row.dataset.idx)],
    }),
  );

  let selected = null;
  for (const candidate of candidates) {
    const matches = rows.filter(
      ({ entry }) => entry && currentCanonical(entry) === candidate.canonical,
    );
    if (!matches.length) continue;
    selected =
      matches.find(({ entry }) =>
        entryUsesProperty(entry, candidate.property),
      ) || matches[0];
    break;
  }

  for (const { row } of rows) {
    row.classList.toggle("highlighted", row === selected?.row);
  }

  if (selected) {
    scrollEntryIntoPanel(selected.row);
    return 1;
  }
  return 0;
}

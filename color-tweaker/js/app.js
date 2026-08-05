import { state } from "./state.js";
import { debounce } from "./utils.js";
import { extractColors } from "./css-parser.js";
import {
  initPreview,
  updatePreview,
  patchCss,
  getProcessedCss,
  isSiteUrlActive,
} from "./preview.js";
import { initColorPanel, renderColorPanel } from "./color-panel.js";
import { initMocks, updateMockBadge, renderMocksPanel } from "./mocks.js";
import { initUpload, loadBuild } from "./upload.js";

// ---- DOM References ----
const ed = {
  html: document.getElementById("ed-html"),
  css: document.getElementById("ed-css"),
  js: document.getElementById("ed-js"),
};
const preview = document.getElementById("preview");
const tabs = document.getElementById("tabs");
const panelUpload = document.getElementById("panel-upload");
const panelMocks = document.getElementById("panel-mocks");

// ---- Initialize Modules ----
initPreview(preview);

initColorPanel(
  document.getElementById("color-list"),
  document.getElementById("cp-count"),
  () => ed.css.value,
);

initMocks(
  document.getElementById("mocks-list"),
  document.getElementById("btn-apply-mocks"),
  document.getElementById("mock-badge"),
  () => loadBuild(),
);

initUpload(
  {
    dropZone: document.getElementById("drop-zone"),
    fileInput: document.getElementById("file-input"),
    tsInput: document.getElementById("ts-input"),
    btnLoad: document.getElementById("btn-load"),
    buildChips: document.getElementById("build-files"),
    tsChips: document.getElementById("ts-files"),
    cssEditor: ed.css,
    siteUrl: document.getElementById("site-url"),
    btnLoadUrl: document.getElementById("btn-load-url"),
    urlStatus: document.getElementById("url-status"),
  },
  {
    onBuildLoaded: (source) => {
      renderMocksPanel();
      setSiteTabsGuarded(source === "url");
    },
  },
);

// ---- Tab Switching ----
function setSiteTabsGuarded(guarded) {
  for (const key of ["html", "js"]) {
    const tab = tabs.querySelector(`[data-tab="${key}"]`);
    tab.classList.toggle("guarded", guarded);
    tab.setAttribute("aria-disabled", String(guarded));
    if (guarded) {
      tab.title = "Opening this editor can replace the loaded site preview";
    } else {
      tab.removeAttribute("title");
    }
  }
}

tabs.addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  const key = tab.dataset.tab;

  if (tab.classList.contains("guarded")) {
    const confirmed = window.confirm(
      `Changing ${key.toUpperCase()} will immediately replace the loaded site's iframe content. Continue?`,
    );
    if (!confirmed) return;
    setSiteTabsGuarded(false);
  }

  document
    .querySelectorAll(".tab")
    .forEach((t) => t.classList.remove("active"));
  tab.classList.add("active");
  Object.keys(ed).forEach((k) => ed[k].classList.add("hidden"));
  panelUpload.classList.add("hidden");
  panelMocks.classList.add("hidden");
  if (ed[key]) ed[key].classList.remove("hidden");
  else if (key === "upload") panelUpload.classList.remove("hidden");
  else if (key === "mocks") panelMocks.classList.remove("hidden");
});

// ---- Tab Key Support ----
Object.values(ed).forEach((textarea) => {
  textarea.addEventListener("keydown", (e) => {
    if (e.key === "Tab") {
      e.preventDefault();
      const s = textarea.selectionStart;
      const end = textarea.selectionEnd;
      textarea.value =
        textarea.value.substring(0, s) + "  " + textarea.value.substring(end);
      textarea.selectionStart = textarea.selectionEnd = s + 2;
      textarea.dispatchEvent(new Event("input"));
    }
  });
});

// ---- Parse + Preview ----
function parseAndRefresh() {
  state.colorEntries = extractColors(ed.css.value);
  state.replacements.clear();
  state.alphaOverrides.clear();
  renderColorPanel();
  if (isSiteUrlActive()) patchCss(ed.css.value);
  else updatePreview(ed.html.value, ed.css.value, ed.js.value);
}

const debouncedParse = debounce(parseAndRefresh, 300);
const debouncedPreview = debounce(
  () => updatePreview(ed.html.value, ed.css.value, ed.js.value),
  200,
);

ed.css.addEventListener("input", debouncedParse);
ed.html.addEventListener("input", debouncedPreview);
ed.js.addEventListener("input", debouncedPreview);

// ---- Reset ----
document.getElementById("btn-reset").addEventListener("click", () => {
  state.replacements.clear();
  state.alphaOverrides.clear();
  renderColorPanel();
  patchCss(ed.css.value);
});

// ---- Export ----
function download(content, filename, type) {
  const blob = new Blob([content], { type });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

document.getElementById("btn-export-css").addEventListener("click", () => {
  download(getProcessedCss(ed.css.value), "styles.css", "text/css");
});

document.getElementById("btn-export-html").addEventListener("click", () => {
  const full =
    '<!DOCTYPE html>\n<html>\n<head>\n<meta charset="UTF-8">\n<style>\n' +
    getProcessedCss(ed.css.value) +
    "\n</style>\n</head>\n<body>\n" +
    ed.html.value +
    "\n<script>\n" +
    ed.js.value +
    "\n<\/script>\n</body>\n</html>";
  download(full, "index.html", "text/html");
});

// ---- Default Sample Content ----
ed.html.value = `<div class="hero">
  <nav>
    <div class="logo">Acme</div>
    <div class="nav-links">
      <a href="#">Features</a>
      <a href="#">Pricing</a>
      <a href="#" class="nav-cta">Get Started</a>
    </div>
  </nav>
  <div class="hero-content">
    <span class="chip">New Release</span>
    <h1>Build faster with <em>smarter</em> tools</h1>
    <p>A modern toolkit for teams that ship. Design, develop, and deploy with confidence.</p>
    <div class="hero-actions">
      <button class="btn-primary">Start Free Trial</button>
      <button class="btn-ghost">View Demo</button>
    </div>
  </div>
  <div class="cards">
    <div class="card">
      <div class="card-icon" style="background:rgba(59,130,246,0.15);color:#3b82f6">&#9672;</div>
      <h3>Lightning Fast</h3>
      <p>Optimized build pipeline with sub-second hot reloads.</p>
    </div>
    <div class="card">
      <div class="card-icon" style="background:rgba(139,92,246,0.15);color:#8b5cf6">&#9830;</div>
      <h3>Type Safe</h3>
      <p>End-to-end type safety from database to frontend.</p>
    </div>
    <div class="card">
      <div class="card-icon" style="background:rgba(245,158,11,0.15);color:#f59e0b">&#9733;</div>
      <h3>Beautiful UI</h3>
      <p>Accessible components with built-in dark mode support.</p>
    </div>
  </div>
</div>`;

ed.css.value = `:root {
  --primary: #3b82f6;
  --primary-hover: #2563eb;
  --secondary: #8b5cf6;
  --accent: #f59e0b;
  --bg: #0a0a0f;
  --surface: #13131a;
  --surface-border: rgba(255, 255, 255, 0.08);
  --text: #e4e4e7;
  --text-muted: #71717a;
  --radius: 12px;
}
* { margin: 0; padding: 0; box-sizing: border-box; }
body {
  background: var(--bg);
  color: var(--text);
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
}
.hero { max-width: 800px; margin: 0 auto; padding: 1.5rem; }
nav {
  display: flex; align-items: center; justify-content: space-between;
  padding: 1rem 0; margin-bottom: 3rem;
}
.logo { font-size: 18px; font-weight: 700; color: var(--primary); }
.nav-links { display: flex; align-items: center; gap: 1.5rem; }
.nav-links a { color: var(--text-muted); text-decoration: none; font-size: 14px; transition: color 0.2s; }
.nav-links a:hover { color: var(--text); }
.nav-cta { background: var(--primary) !important; color: white !important; padding: 6px 14px; border-radius: 8px; }
.hero-content { text-align: center; margin-bottom: 3rem; }
.chip {
  display: inline-block; font-size: 12px; font-weight: 600;
  padding: 4px 12px; border-radius: 20px;
  background: rgba(139, 92, 246, 0.15); color: var(--secondary); margin-bottom: 1.5rem;
}
h1 { font-size: 2.5rem; font-weight: 700; line-height: 1.2; margin-bottom: 1rem; }
h1 em {
  font-style: normal;
  background: linear-gradient(135deg, var(--primary), var(--secondary));
  -webkit-background-clip: text; -webkit-text-fill-color: transparent;
}
.hero-content > p { font-size: 1.05rem; color: var(--text-muted); max-width: 500px; margin: 0 auto 2rem; line-height: 1.6; }
.hero-actions { display: flex; justify-content: center; gap: 10px; }
.btn-primary, .btn-ghost {
  padding: 10px 20px; border-radius: 10px; font-size: 14px;
  font-weight: 500; cursor: pointer; border: none; transition: all 0.2s;
}
.btn-primary { background: var(--primary); color: white; }
.btn-primary:hover { background: var(--primary-hover); }
.btn-ghost { background: transparent; color: var(--text-muted); border: 1px solid var(--surface-border); }
.btn-ghost:hover { border-color: var(--text-muted); color: var(--text); }
.cards { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; }
.card { background: var(--surface); border: 1px solid var(--surface-border); border-radius: var(--radius); padding: 1.25rem; }
.card-icon {
  width: 36px; height: 36px; border-radius: 8px;
  display: flex; align-items: center; justify-content: center;
  font-size: 16px; margin-bottom: 0.75rem;
}
.card h3 { font-size: 14px; font-weight: 600; margin-bottom: 0.4rem; }
.card p { font-size: 13px; color: var(--text-muted); line-height: 1.5; }`;

ed.js.value = `document.querySelector('.btn-primary')?.addEventListener('click', function() {
  this.textContent = 'Starting...';
  this.style.opacity = '0.7';
  setTimeout(() => {
    this.textContent = 'Start Free Trial';
    this.style.opacity = '1';
  }, 1500);
});`;

// ---- Boot ----
parseAndRefresh();

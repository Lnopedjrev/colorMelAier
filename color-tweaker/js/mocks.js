// Mock capture — listens for failed fetch reports from iframe, renders mock config panel

import { state } from './state.js';
import { generateMockForType } from './ts-parser.js';
import { debounce } from './utils.js';

let mocksListEl = null;
let btnApplyEl = null;
let mockBadgeEl = null;
let onApplyCallback = null;

export function initMocks(listEl, btnEl, badgeEl, onApply) {
  mocksListEl = listEl;
  btnApplyEl = btnEl;
  mockBadgeEl = badgeEl;
  onApplyCallback = onApply;

  window.addEventListener('message', (e) => {
    if (!e.data || typeof e.data !== 'object') return;
    if (e.data.type === 'ct-runtime-error') {
      console.warn('[iframe error]', e.data.message, e.data.filename + ':' + e.data.lineno);
      return;
    }
    if (e.data.type === 'ct-unhandled-rejection') {
      console.warn('[iframe rejection]', e.data.reason);
      return;
    }
    if (e.data.type === 'ct-fetch-fail') {
      const key = e.data.method + ' ' + e.data.url;
      if (state.failedEndpoints.has(key)) return;
      state.failedEndpoints.set(key, {
        method: e.data.method,
        url: e.data.url,
        status: e.data.status,
        error: e.data.error
      });
      renderMocksPanel();
      updateMockBadge();
    }
  });

  btnApplyEl.addEventListener('click', () => {
    if (onApplyCallback) onApplyCallback();
  });
}

export function updateMockBadge() {
  const n = state.failedEndpoints.size;
  mockBadgeEl.innerHTML = n ? `<span class="mock-count-badge">${n}</span>` : '';
}

export function renderMocksPanel() {
  if (!state.failedEndpoints.size) {
    mocksListEl.innerHTML = '<div class="empty">No failed requests captured yet</div>';
    btnApplyEl.classList.add('hidden');
    return;
  }

  const typeNames = Object.keys(state.parsedTsTypes);
  const typeOptions = typeNames.length
    ? '<option value="">-- select type --</option>' +
      typeNames.map(t => `<option value="${t}">${t}</option>`).join('')
    : '';

  mocksListEl.innerHTML = Array.from(state.failedEndpoints.entries()).map(([key, ep]) => {
    const existing = state.mockData[key] ? JSON.stringify(state.mockData[key], null, 2) : '';
    return `<div class="mock-endpoint" data-key="${key}">
      <div class="mock-head">
        <span class="mock-method">${ep.method}</span>
        <span class="mock-url" title="${ep.url}">${ep.url}</span>
        <span class="mock-status">${ep.status || ep.error || 'failed'}</span>
        ${typeOptions ? `<select class="type-select" data-key="${key}">${typeOptions}</select>` : ''}
      </div>
      <div class="mock-body">
        <textarea spellcheck="false" data-key="${key}" placeholder="Paste JSON mock response...">${existing}</textarea>
      </div>
    </div>`;
  }).join('');

  btnApplyEl.classList.remove('hidden');

  mocksListEl.querySelectorAll('.type-select').forEach(sel => {
    sel.addEventListener('change', (e) => {
      const typeName = e.target.value;
      if (!typeName) return;
      const scaffold = generateMockForType(typeName, state.parsedTsTypes);
      if (scaffold !== null) {
        const ta = mocksListEl.querySelector(`textarea[data-key="${e.target.dataset.key}"]`);
        ta.value = JSON.stringify(scaffold, null, 2);
        state.mockData[e.target.dataset.key] = scaffold;
      }
    });
  });

  const debouncedParse = debounce((key, value) => {
    try { state.mockData[key] = JSON.parse(value); } catch {}
  }, 400);

  mocksListEl.querySelectorAll('textarea').forEach(ta => {
    ta.addEventListener('input', (e) => debouncedParse(e.target.dataset.key, e.target.value));
  });
}

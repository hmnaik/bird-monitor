(() => {
'use strict';

const KEY = 'bm.v1';
const root = document.getElementById('app');

let cfg = { title: 'Bird Monitor', spots: [], taxa: {} };
let db = loadDb();
let view = { taxon: null, q: '', seenOnly: false };
let timerId = null;
let wakeLock = null;
let installPrompt = null;

// ---------- storage ----------
function loadDb() {
  try {
    const d = JSON.parse(localStorage.getItem(KEY));
    if (d && Array.isArray(d.sessions)) return d;
  } catch (e) {}
  return { spots: [], custom: {}, sessions: [], active: null, observer: '', lastSpot: '' };
}
function save() {
  try { localStorage.setItem(KEY, JSON.stringify(db)); }
  catch (e) { alert('Could not save (storage full or blocked). Export your data now.'); }
}

// ---------- helpers ----------
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const pad = n => String(n).padStart(2, '0');
function localStamp(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function fmtDur(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${pad(mm)}:${pad(ss)}` : `${pad(mm)}:${pad(ss)}`;
}
const activeSession = () => db.sessions.find(s => s.id === db.active) || null;
const allSpots = () => [...new Set([...(cfg.spots || []), ...db.spots])];
const norm = x => (typeof x === 'string' ? { n: x } : x);

function speciesByTaxon() {
  const out = {};
  for (const [tx, list] of Object.entries(cfg.taxa || {})) {
    out[tx] = list.map(norm).sort((a, b) => a.n.localeCompare(b.n));
  }
  for (const [tx, list] of Object.entries(db.custom)) {
    out[tx] = out[tx] || [];
    for (const it of list) if (!out[tx].some(x => x.n.toLowerCase() === it.n.toLowerCase())) out[tx].push(it);
  }
  return out;
}

// ---------- export ----------
function csvCell(v) {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;          // avoid spreadsheet formula injection
  return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function buildCsv(sessions) {
  const inList = new Set();
  for (const [tx, list] of Object.entries(cfg.taxa || {})) for (const it of list) inList.add(tx + '|' + norm(it).n.toLowerCase());
  const head = ['session_id', 'observer', 'spot', 'session_start', 'session_end', 'taxon', 'species', 'count', 'in_checklist', 'timestamp_utc', 'timestamp_local'];
  const rows = [head];
  for (const s of sessions) {
    for (const e of s.events) {
      rows.push([s.id, s.observer, s.spot, s.start, s.end || '', e.tx, e.sp, 1,
        inList.has(e.tx + '|' + e.sp.toLowerCase()) ? 'TRUE' : 'FALSE', e.t, localStamp(e.t)]);
    }
  }
  return '﻿' + rows.map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
async function exportCsv(sessions, label) {
  const d = new Date();
  const name = `birdmonitor_${label}_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.csv`;
  const file = new File([buildCsv(sessions)], name, { type: 'text/csv' });
  try {
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      await navigator.share({ files: [file], title: name });
      return;
    }
  } catch (e) { if (e && e.name === 'AbortError') return; }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---------- wake lock (keep screen on during a session) ----------
async function lockScreen() {
  try {
    if ('wakeLock' in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    }
  } catch (e) {}
}
function unlockScreen() { try { wakeLock && wakeLock.release(); } catch (e) {} wakeLock = null; }
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && db.active) lockScreen();
});

// ---------- views ----------
function render() {
  clearInterval(timerId);
  const s = activeSession();
  if (!s) db.active = null;
  s ? renderSession(s) : renderHome();
}

function renderHome() {
  unlockScreen();
  const obs = h('input', { type: 'text', placeholder: 'Your name', autocomplete: 'name', value: db.observer || '' });
  const spotSel = h('select', {},
    h('option', { value: '' }, 'Select spot…'),
    allSpots().map(sp => h('option', { value: sp }, sp)));
  spotSel.value = allSpots().includes(db.lastSpot) ? db.lastSpot : '';

  const addSpot = () => {
    const name = (prompt('New spot name:') || '').trim();
    if (!name) return;
    if (!allSpots().some(x => x.toLowerCase() === name.toLowerCase())) { db.spots.push(name); save(); }
    db.lastSpot = allSpots().find(x => x.toLowerCase() === name.toLowerCase());
    render();
  };

  const start = () => {
    const observer = obs.value.trim();
    if (!observer) { obs.focus(); return alert('Enter your name.'); }
    if (!spotSel.value) return alert('Select a spot.');
    const s = { id: uid(), observer, spot: spotSel.value, start: new Date().toISOString(), end: null, events: [] };
    db.sessions.push(s);
    db.active = s.id; db.observer = observer; db.lastSpot = spotSel.value;
    save();
    try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
    view.q = ''; view.seenOnly = false;
    render();
  };

  const done = db.sessions.filter(s => s.end).slice().reverse();
  const history = done.length
    ? done.map(s => {
        const spp = new Set(s.events.map(e => e.sp)).size;
        return h('div', { class: 'row' },
          h('div', {},
            h('b', {}, s.spot),
            h('small', {}, `${localStamp(s.start).slice(0, 16)} · ${s.observer}`),
            h('small', {}, `${s.events.length} ind · ${spp} spp · ${fmtDur(new Date(s.end) - new Date(s.start))}`)),
          h('div', {},
            h('button', { onclick: () => exportCsv([s], 'session') }, 'CSV'), ' ',
            h('button', { class: 'del', onclick: () => {
              if (confirm(`Delete session at ${s.spot}? This cannot be undone.`)) {
                db.sessions = db.sessions.filter(x => x.id !== s.id); save(); render();
              }
            } }, '✕')));
      })
    : h('p', { class: 'note' }, 'No finished sessions yet.');

  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const installRow = installPrompt
    ? h('button', { class: 'link', onclick: async () => { installPrompt.prompt(); await installPrompt.userChoice; installPrompt = null; render(); } }, 'Install app')
    : (ios && !navigator.standalone ? h('p', { class: 'note' }, 'To install: tap Share, then “Add to Home Screen”.') : null);

  root.replaceChildren(
    h('header', {}, h('h1', {}, cfg.title || 'Bird Monitor')),
    h('main', {},
      h('label', {}, 'Observer', obs),
      h('label', {}, 'Spot', spotSel),
      h('p', {}, h('button', { class: 'link', onclick: addSpot }, '+ Add spot')),
      h('button', { class: 'primary', onclick: start }, 'Start session'),
      h('h2', {}, 'Finished sessions'),
      history,
      done.length ? h('p', {}, h('button', { class: 'link', onclick: () => exportCsv(db.sessions.filter(s => s.end), 'all') }, 'Export all sessions (CSV)')) : null,
      installRow,
      h('p', { class: 'note' }, 'Data is stored on this device only. Export the CSV after each visit.')));
}

function renderSession(s) {
  lockScreen();
  const data = speciesByTaxon();
  const taxa = Object.keys(data);
  if (!view.taxon || !taxa.includes(view.taxon)) view.taxon = taxa[0];

  const countOf = name => { let c = 0; for (const e of s.events) if (e.sp === name) c++; return c; };
  const cards = {};

  const stats = h('small', {});
  const clock = h('span', {});
  const updateStats = () => {
    stats.replaceChildren(`${s.events.length} ind · ${new Set(s.events.map(e => e.sp)).size} spp · `, clock);
    clock.textContent = fmtDur(Date.now() - new Date(s.start));
  };
  timerId = setInterval(() => { clock.textContent = fmtDur(Date.now() - new Date(s.start)); }, 1000);

  const updateCard = name => {
    const r = cards[name]; if (!r) return;
    const c = countOf(name);
    r.count.textContent = c || '';
    r.card.classList.toggle('hit', c > 0);
    r.minus.disabled = c === 0;
  };

  const record = (name, tx, delta) => {
    if (delta > 0) {
      s.events.push({ t: new Date().toISOString(), sp: name, tx });
      try { navigator.vibrate && navigator.vibrate(15); } catch (e) {}
    } else {
      for (let i = s.events.length - 1; i >= 0; i--) if (s.events[i].sp === name) { s.events.splice(i, 1); break; }
    }
    save(); updateCard(name); updateStats();
  };

  const list = h('div', { id: 'list' });
  const drawList = () => {
    for (const k of Object.keys(cards)) delete cards[k];
    const q = view.q.trim().toLowerCase();
    const items = (data[view.taxon] || []).filter(it =>
      (!q || it.n.toLowerCase().includes(q) || (it.s || '').toLowerCase().includes(q)) &&
      (!view.seenOnly || countOf(it.n) > 0));
    const nodes = items.map(it => {
      const count = h('b', {});
      const minus = h('button', { class: 'minus', 'aria-label': 'Undo one ' + it.n, onclick: () => record(it.n, view.taxon, -1) }, '−');
      const card = h('div', { class: 'sp' },
        h('button', { class: 'tap', onclick: () => record(it.n, view.taxon, +1) }, h('span', {}, it.n), count),
        minus);
      cards[it.n] = { card, count, minus };
      return card;
    });
    if (!nodes.length) nodes.push(h('p', { class: 'empty' }, view.seenOnly ? 'Nothing recorded in this group yet.' : 'No match.'));
    nodes.push(h('button', { class: 'addnew', onclick: addSpecies }, '+ Add species not in list'));
    list.replaceChildren(...nodes);
    for (const it of items) updateCard(it.n);
  };

  const addSpecies = () => {
    const name = (prompt(`New ${view.taxon} species name (counted once):`, view.q.trim()) || '').trim();
    if (!name) return;
    const known = Object.values(speciesByTaxon()).flat().find(x => x.n.toLowerCase() === name.toLowerCase());
    const finalName = known ? known.n : name;
    if (!known) { (db.custom[view.taxon] = db.custom[view.taxon] || []).push({ n: name }); }
    s.events.push({ t: new Date().toISOString(), sp: finalName, tx: view.taxon });
    save(); view.q = ''; render();
  };

  const tabs = h('div', { class: 'tabs' }, taxa.map(tx =>
    h('button', { class: tx === view.taxon ? 'on' : '', onclick: () => { view.taxon = tx; render(); } }, tx)));

  const search = h('input', { type: 'search', placeholder: 'Search species', enterkeyhint: 'search', value: view.q,
    oninput: e => { view.q = e.target.value; drawList(); } });
  const seen = h('input', { type: 'checkbox', onchange: e => { view.seenOnly = e.target.checked; drawList(); } });
  seen.checked = view.seenOnly;

  const end = () => {
    if (!confirm(`End session at ${s.spot}? (${s.events.length} individuals recorded)`)) return;
    s.end = new Date().toISOString(); db.active = null; save(); render();
  };

  root.replaceChildren(
    h('header', { class: 'sticky' },
      h('div', {}, h('b', {}, s.spot), h('small', {}, s.observer), stats),
      h('button', { class: 'end', onclick: end }, 'End')),
    tabs,
    h('div', { class: 'tools' }, search, h('label', { class: 'chk' }, seen, 'Seen')),
    list);
  updateStats();
  drawList();
}

// ---------- boot ----------
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; if (!db.active) render(); });

async function boot() {
  try {
    const r = await fetch('config.json', { cache: 'no-cache' });
    if (r.ok) cfg = Object.assign(cfg, await r.json());
  } catch (e) {
    try { const r = await fetch('config.json'); if (r.ok) cfg = Object.assign(cfg, await r.json()); } catch (e2) {}
  }
  document.title = cfg.title || 'Bird Monitor';
  render();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
})();

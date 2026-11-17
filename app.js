// Craglog: a small offline table browser and editor on top of a SQLite file
// that lives in this browser. The interface is built from the database itself:
// every table that does not start with "_" is listed, foreign keys become links,
// and the optional _ui table supplies labels, widgets and facets.
import { STRINGS } from './strings.js';
import { zipBlob, unzip } from './zip.js';

const APP_VERSION = '1.0.0';
const NULLV = '__null__';
const PAGE = 100;

// ---------------------------------------------------------------- helpers

const S = { schema: null, meta: {}, lang: 'en', browserLang: 'en', sqlite: '', sqlText: '' };
let blobUrls = [];
let renderSeq = 0;

function t(key, vars) {
  let s = (STRINGS[S.lang] && STRINGS[S.lang][key]) || STRINGS.en[key] || key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', v);
  return s;
}

function h(tag, props, ...kids) {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name || 'div');
  if (classes.length) el.className = classes.join(' ');
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'spellcheck') { el.setAttribute(k, String(v)); continue; }
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') el.innerHTML = v;
    else if (k in el && k !== 'list' && k !== 'form') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

const bdi = (text) => h('bdi', {}, text);
const qi = (n) => '"' + String(n).replaceAll('"', '""') + '"';

const ICONS = {
  back: '<path d="M15 5l-7 7 7 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  tables: '<path d="M4 6h16M4 12h16M4 18h16"/>',
  sql: '<path d="M8 8l-4 4 4 4M16 8l4 4-4 4M13 6l-2 12"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M5.6 18.4l2.1-2.1M16.3 7.7l2.1-2.1"/>',
  file: '<path d="M7 3h7l5 5v13H7zM14 3v5h5"/>',
};
function icon(name) {
  return h('span.icon', {
    html: `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`,
  });
}

function fmtBytes(n) {
  if (n === null || n === undefined) return '';
  if (n < 1024) return n + ' B';
  if (n < 1 << 20) return (n / 1024).toFixed(0) + ' KB';
  if (n < 1 << 30) return (n / (1 << 20)).toFixed(1) + ' MB';
  return (n / (1 << 30)).toFixed(2) + ' GB';
}

function fmtDate(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v));
  if (!m) return String(v);
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.toLocaleDateString(S.lang === 'he' ? 'he-IL' : 'en-GB', { year: 'numeric', month: 'short', day: 'numeric' });
}

function hue(text) {
  let x = 0;
  for (const ch of String(text)) x = (x * 31 + ch.codePointAt(0)) % 360;
  return x;
}
function pill(text) {
  return h('span.pill', { style: `--hue:${hue(text)}` }, bdi(text));
}

// Text with clickable links and preserved line breaks.
function richText(text) {
  const el = h('div.rich', { dir: 'auto' });
  const parts = String(text).split(/(https?:\/\/[^\s<>"]+)/g);
  parts.forEach((p, i) => {
    if (i % 2) {
      let label = p;
      try {
        const u = new URL(p);
        const path = u.pathname.length > 18 ? u.pathname.slice(0, 16) + '…' : u.pathname;
        label = u.host.replace(/^www\./, '') + (path === '/' ? '' : path);
      } catch (e) { /* keep raw text */ }
      el.append(h('a', { href: p, target: '_blank', rel: 'noopener', dir: 'ltr' }, label));
    } else if (p) {
      el.append(p);
    }
  });
  return el;
}

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

function confirmSheet(message, actionLabel, danger = true) {
  return new Promise((resolve) => {
    const done = (v) => { sheet.remove(); resolve(v); };
    const sheet = h('div.sheet', { role: 'dialog', 'aria-modal': 'true' },
      h('div.sheet-box', {},
        h('p', { dir: 'auto' }, message),
        h('div.sheet-actions', {},
          h('button.btn', { type: 'button', onclick: () => done(false) }, t('cancel')),
          h('button.btn' + (danger ? '.danger' : '.primary'), { type: 'button', id: 'confirm-ok', onclick: () => done(true) }, actionLabel))));
    document.body.append(sheet);
  });
}

// ---------------------------------------------------------------- database

const worker = new Worker('./db-worker.js', { type: 'module' });
const pending = new Map();
let rpcSeq = 0;
worker.onmessage = (e) => {
  const { id, ok, result, error } = e.data;
  const p = pending.get(id);
  pending.delete(id);
  if (!p) return;
  if (ok) p.resolve(result); else p.reject(new Error(error));
};
worker.onerror = (e) => {
  for (const p of pending.values()) p.reject(new Error(e.message || 'worker failed'));
  pending.clear();
};
function rpc(op, args) {
  return new Promise((resolve, reject) => {
    const id = ++rpcSeq;
    pending.set(id, { resolve, reject });
    worker.postMessage({ id, op, args });
  });
}
const exec = (sql, bind = []) => rpc('exec', { sql, bind });
async function rows(sql, bind = []) {
  const r = await exec(sql, bind);
  return r.rows.map((a) => Object.fromEntries(r.columns.map((c, i) => [c, a[i]])));
}
async function value(sql, bind = []) {
  const r = await exec(sql, bind);
  return r.rows.length ? r.rows[0][0] : null;
}

async function ensureAppTables() {
  await exec(`
    CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS _ui (
      tbl TEXT NOT NULL, col TEXT NOT NULL DEFAULT '', label TEXT, widget TEXT,
      facet INTEGER DEFAULT 0, hidden INTEGER DEFAULT 0, position INTEGER, options TEXT,
      PRIMARY KEY (tbl, col));
    CREATE TABLE IF NOT EXISTS _files (
      id INTEGER PRIMARY KEY, tbl TEXT NOT NULL, row_id INTEGER NOT NULL, filename TEXT NOT NULL,
      mime TEXT, size INTEGER, path TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ','now')), airtable_id TEXT UNIQUE);
    CREATE INDEX IF NOT EXISTS files_row ON _files(tbl, row_id);`);
}

async function setMeta(key, val) {
  await exec('INSERT INTO _meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [key, String(val)]);
  S.meta[key] = String(val);
}
async function markDirty() {
  await exec("INSERT INTO _meta (key, value) VALUES ('dirty', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + 1");
  S.meta.dirty = String((+S.meta.dirty || 0) + 1);
}

function parseJson(text, fallback) {
  try { return text ? JSON.parse(text) : fallback; } catch (e) { return fallback; }
}

async function loadSchema() {
  await ensureAppTables();
  S.meta = Object.fromEntries((await rows('SELECT key, value FROM _meta')).map((r) => [r.key, r.value]));
  const ui = await rows('SELECT * FROM _ui');
  const uiFor = (tbl, col) => ui.find((u) => u.tbl === tbl && u.col === col) || {};
  const cols = await rows(`
    SELECT m.name AS tbl, p.name, p.type, p."notnull" AS nn, p.pk
    FROM sqlite_schema m, pragma_table_info(m.name) p
    WHERE m.type = 'table' AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND substr(m.name, 1, 1) <> '_'
    ORDER BY m.name, p.cid`);
  const fks = await rows(`
    SELECT m.name AS tbl, f."table" AS ref, f."from" AS col
    FROM sqlite_schema m, pragma_foreign_key_list(m.name) f
    WHERE m.type = 'table' AND substr(m.name, 1, 1) <> '_'`);
  const tables = new Map();
  for (const c of cols) {
    if (!tables.has(c.tbl)) {
      const u = uiFor(c.tbl, '');
      tables.set(c.tbl, {
        name: c.tbl, label: u.label || c.tbl, position: u.position ?? 999,
        options: parseJson(u.options, {}), cols: [], reverse: [],
      });
    }
    const u = uiFor(c.tbl, c.name);
    const type = (c.type || '').toUpperCase();
    const fk = fks.find((f) => f.tbl === c.tbl && f.col === c.name);
    let kind = u.widget;
    if (fk) kind = 'fk';
    else if (!kind) {
      if (/INT|REAL|NUM|DOUB|FLOA/.test(type)) kind = 'number';
      else if (/DATE/.test(type) || /(^|_)date$/i.test(c.name)) kind = 'date';
      else if (/^(notes?|description|comments?|details)$/i.test(c.name)) kind = 'textarea';
      else kind = 'text';
    }
    tables.get(c.tbl).cols.push({
      name: c.name, label: u.label || c.name, kind, notnull: !!c.nn, pk: !!c.pk,
      facet: !!u.facet, hidden: u.hidden ? true : !!c.pk, position: u.position ?? 500,
      options: parseJson(u.options, {}), fk: fk ? { table: fk.ref } : null,
    });
  }
  for (const T of tables.values()) {
    T.cols.sort((a, b) => a.position - b.position);
    const named = T.cols.find((c) => /^(name|title)$/i.test(c.name));
    const firstText = T.cols.find((c) => c.kind === 'text' && !c.pk);
    T.labelCol = T.options.labelCol || (named || firstText || T.cols[0]).name;
    for (const c of T.cols) {
      if (c.fk && tables.has(c.fk.table)) tables.get(c.fk.table).reverse.push({ table: T.name, col: c.name });
      else if (c.fk) { c.fk = null; c.kind = 'number'; }
    }
  }
  S.schema = [...tables.values()].sort((a, b) => a.position - b.position || a.name.localeCompare(b.name));
  const lang = S.meta.lang || S.browserLang;
  S.lang = STRINGS[lang] ? lang : 'en';
  document.documentElement.lang = S.lang;
  document.documentElement.dir = S.lang === 'he' ? 'rtl' : 'ltr';
  document.title = S.meta.title || t('appName');
  for (const el of document.querySelectorAll('[data-t]')) el.textContent = t(el.dataset.t);
}

const table = (name) => S.schema.find((T) => T.name === name);

// id -> label for every table that something links to (the data set is small).
async function labelMaps(T) {
  const maps = {};
  for (const c of T.cols) {
    if (!c.fk || maps[c.fk.table]) continue;
    const R = table(c.fk.table);
    const r = await exec(`SELECT rowid, ${qi(R.labelCol)} FROM ${qi(R.name)}`);
    maps[R.name] = new Map(r.rows.map(([id, label]) => [id, label]));
  }
  return maps;
}

function leadExpr(T) {
  const lead = T.options.lead;
  if (!lead) return 'NULL';
  const m = /^count:([^.]+)\.(.+)$/.exec(lead);
  if (m && table(m[1])) return `(SELECT count(*) FROM ${qi(m[1])} WHERE ${qi(m[2])} = ${qi(T.name)}.rowid)`;
  if (T.cols.some((c) => c.name === lead)) return qi(lead);
  return 'NULL';
}

function orderBy(T, sort) {
  const m = /^(.+?)( DESC)?$/.exec(sort || '');
  const col = m && T.cols.find((c) => c.name === m[1]);
  if (!col) return `${qi(T.labelCol)} COLLATE NOCASE`;
  const collate = col.kind === 'number' || col.kind === 'fk' ? '' : ' COLLATE NOCASE';
  return `${qi(col.name)} IS NULL, ${qi(col.name)}${collate}${m[2] || ''}, rowid DESC`;
}

// One guidebook-style line: a fixed lead column (grade, quantity, count),
// then the name with a quieter second line of facts.
function line(T, r, maps) {
  const metaEls = [];
  for (const name of T.options.list || []) {
    const c = T.cols.find((x) => x.name === name);
    const v = c ? r[name] : null;
    if (v === null || v === undefined || v === '') continue;
    if (c.kind === 'fk') metaEls.push(h('span', {}, bdi(maps[c.fk.table]?.get(v) ?? '#' + v)));
    else if (c.kind === 'select' && c.facet) metaEls.push(pill(v));
    else if (c.kind === 'date') metaEls.push(h('span.num', {}, fmtDate(v)));
    else metaEls.push(h('span', {}, bdi(String(v).split('\n')[0].slice(0, 60))));
  }
  const lead = r.__lead;
  return h('a.line', { href: `#/t/${encodeURIComponent(T.name)}/${r.__id}` },
    T.options.lead ? h('span.lead' + (lead === null || lead === '' ? '.blank' : ''), {}, lead === null || lead === '' ? '–' : bdi(lead)) : null,
    h('span.line-body', {},
      h('span.line-name', {}, bdi(r[T.labelCol] ?? '#' + r.__id)),
      metaEls.length ? h('span.line-meta', {}, metaEls) : null));
}

// ---------------------------------------------------------------- files

async function filesDir() {
  const root = await navigator.storage.getDirectory();
  const app = await root.getDirectoryHandle('craglog', { create: true });
  return app.getDirectoryHandle('files', { create: true });
}
async function readFile(path) {
  try {
    const dir = await filesDir();
    return await (await dir.getFileHandle(path)).getFile();
  } catch (e) {
    return null;
  }
}
function newPath(filename) {
  const m = /\.([A-Za-z0-9]{1,8})$/.exec(filename || '');
  const ext = m ? '.' + m[1].toLowerCase() : '';
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8) + ext;
}

// Large photos are scaled down to 2400 px on the long side before storing.
async function prepareImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type)) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 2400 / Math.max(bmp.width, bmp.height));
    const keep = file.type === 'image/jpeg' || file.type === 'image/png';
    if (scale === 1 && keep) { bmp.close(); return file; }
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bmp.width * scale);
    canvas.height = Math.round(bmp.height * scale);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close();
    const png = file.type === 'image/png';
    const blob = await new Promise((res) => canvas.toBlob(res, png ? 'image/png' : 'image/jpeg', 0.86));
    if (!blob) return file;
    const base = file.name.replace(/\.[A-Za-z0-9]+$/, '');
    return new File([blob], base + (png ? '.png' : '.jpg'), { type: blob.type });
  } catch (e) {
    return file;
  }
}

async function storeFile(tbl, rowId, file, airtableId = null) {
  const path = newPath(file.name);
  await rpc('writeFile', { path, blob: file });
  await exec('INSERT INTO _files (tbl, row_id, filename, mime, size, path, airtable_id) VALUES (?,?,?,?,?,?,?)',
    [tbl, rowId, file.name || path, file.type || null, file.size, path, airtableId]);
}

async function deleteFileRow(f) {
  await rpc('deleteFile', { path: f.path });
  await exec('DELETE FROM _files WHERE id = ?', [f.id]);
}

function shareOrDownload(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    return navigator.share({ files: [file] }).then(() => true, (e) => {
      if (e && e.name === 'AbortError') return false;
      download(file);
      return true;
    });
  }
  download(file);
  return Promise.resolve(true);
}
function download(file) {
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: file.name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function fileViewer(f, file, onDeleted) {
  const isImage = file && /^image\//.test(file.type || f.mime || '');
  const url = file ? URL.createObjectURL(file) : null;
  const close = () => { if (url) URL.revokeObjectURL(url); el.remove(); };
  const el = h('div.viewer', { role: 'dialog', 'aria-modal': 'true' },
    h('div.viewer-bar', {},
      h('button.btn.ghost', { type: 'button', id: 'viewer-close', onclick: close }, t('close')),
      h('span.viewer-name', {}, bdi(f.filename)),
      file ? h('button.btn.ghost', {
        type: 'button',
        onclick: () => shareOrDownload(new File([file], f.filename, { type: file.type || f.mime || 'application/octet-stream' })),
      }, t('share')) : null,
      h('button.btn.ghost.danger-text', {
        type: 'button', id: 'viewer-delete',
        onclick: async () => {
          if (!(await confirmSheet(t('deleteFileConfirm'), t('deleteFile')))) return;
          await deleteFileRow(f);
          await markDirty();
          close();
          onDeleted();
        },
      }, t('delete'))),
    h('div.viewer-body', {},
      !file ? h('p.empty', {}, t('missingFile'))
        : isImage ? h('img', { src: url, alt: f.filename })
          : h('div.viewer-doc', {},
            icon('file'),
            h('p', {}, bdi(f.filename), ' ', h('span.muted', {}, fmtBytes(f.size))),
            h('a.btn.primary', { href: url, target: '_blank', rel: 'noopener' }, t('open')))));
  document.body.append(el);
}

async function filesSection(T, id) {
  const box = h('section.block');
  async function refresh() {
    const list = await rows('SELECT * FROM _files WHERE tbl = ? AND row_id = ? ORDER BY id', [T.name, id]);
    const grid = h('div.files');
    for (const f of list) {
      const file = await readFile(f.path);
      const isImage = file && /^image\//.test(file.type || f.mime || '');
      let inner;
      if (isImage) {
        const url = URL.createObjectURL(file);
        blobUrls.push(url);
        inner = h('img', { src: url, alt: f.filename, loading: 'lazy', decoding: 'async' });
      } else {
        inner = h('span.file-doc' + (file ? '' : '.missing'), {}, icon('file'), h('span.file-name', {}, bdi(f.filename)));
      }
      grid.append(h('button.file-tile', { type: 'button', onclick: () => fileViewer(f, file, refresh) }, inner));
    }
    const status = h('span.muted');
    const input = h('input', {
      type: 'file', multiple: true, accept: 'image/*,application/pdf', hidden: true, id: 'file-input',
      onchange: async () => {
        const picked = [...input.files];
        let n = 0;
        for (const raw of picked) {
          status.textContent = t('addingFiles', { a: ++n, b: picked.length });
          await storeFile(T.name, id, await prepareImage(raw));
        }
        if (picked.length) await markDirty();
        refresh();
      },
    });
    box.replaceChildren(
      h('h2', {}, t('files'), list.length ? h('span.count', {}, list.length) : null),
      list.length ? grid : null,
      h('div.row-actions', {},
        h('button.btn', { type: 'button', onclick: () => input.click() }, icon('plus'), t('addFiles')), status),
      input);
  }
  await refresh();
  return box;
}

// ---------------------------------------------------------------- views

function tableHref(T, filters) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(filters || {})) p.set('f.' + k, v);
  const qs = p.toString();
  return `#/t/${encodeURIComponent(T.name)}${qs ? '?' + qs : ''}`;
}

async function viewHome() {
  if (!S.schema.length) return viewWelcome();
  const node = h('div');
  const dirty = +S.meta.dirty || 0;
  if (dirty > 0) {
    node.append(h('a.notice', { href: '#/settings' }, t('unsaved', { n: dirty }), ' ', h('u', {}, t('backUpNow'))));
  }
  const list = h('div.lines');
  for (const T of S.schema) {
    const n = await value(`SELECT count(*) FROM ${qi(T.name)}`);
    list.append(h('a.line', { href: tableHref(T) },
      h('span.lead', {}, n),
      h('span.line-body', {}, h('span.line-name', {}, bdi(T.label)))));
  }
  node.append(list);
  return { title: S.meta.title || t('appName'), node };
}

function importButton(label, cls = '.primary') {
  const input = h('input', {
    type: 'file', hidden: true, id: 'import-input',
    onchange: async () => {
      const file = input.files[0];
      input.value = '';
      if (!file) return;
      if (S.schema.length && !(await confirmSheet(t('restoreConfirm', { name: file.name }), t('restoreBtn')))) return;
      try {
        await importFile(file, (a, b) => { status.textContent = t('restoring', { a, b }); });
        status.textContent = '';
        toast(t('restored'));
        location.hash = '#/';
        render();
      } catch (e) {
        status.textContent = /not-sqlite|not-zip|corrupt/.test(e.message) ? t('notSqlite') : e.message;
      }
    },
  });
  const status = h('p.status', { role: 'status' });
  return h('div', {}, h('button.btn' + cls, { type: 'button', onclick: () => input.click() }, label), input, status);
}

function viewWelcome() {
  return {
    title: t('appName'),
    node: h('div.welcome', {},
      h('h2', {}, t('welcomeTitle')),
      h('p', {}, t('welcomeText')),
      importButton(t('restoreBtn'))),
  };
}

async function viewTable(T, params) {
  const state = { q: params.get('q') || '', sort: params.get('sort') || T.options.sort || T.labelCol, filters: {}, limit: PAGE };
  for (const [k, v] of params) if (k.startsWith('f.') && T.cols.some((c) => c.name === k.slice(2))) state.filters[k.slice(2)] = v;
  const maps = await labelMaps(T);
  const total = await value(`SELECT count(*) FROM ${qi(T.name)}`);
  const facetCols = T.cols.filter((c) => c.facet);

  function where(skip) {
    const parts = [];
    const bind = [];
    if (state.q) {
      const like = '%' + state.q.replace(/[%_\\]/g, (m) => '\\' + m) + '%';
      const ors = [];
      for (const c of T.cols) {
        if (c.fk) {
          const R = table(c.fk.table);
          ors.push(`${qi(c.name)} IN (SELECT rowid FROM ${qi(R.name)} WHERE ${qi(R.labelCol)} LIKE ? ESCAPE '\\')`);
        } else {
          ors.push(`${qi(c.name)} LIKE ? ESCAPE '\\'`);
        }
        bind.push(like);
      }
      parts.push('(' + ors.join(' OR ') + ')');
    }
    for (const [col, v] of Object.entries(state.filters)) {
      if (col === skip) continue;
      if (v === NULLV) parts.push(`(${qi(col)} IS NULL OR ${qi(col)} = '')`);
      else { parts.push(`${qi(col)} = ?`); bind.push(v); }
    }
    return { sql: parts.length ? ' WHERE ' + parts.join(' AND ') : '', bind };
  }

  function syncUrl() {
    const p = new URLSearchParams();
    if (state.q) p.set('q', state.q);
    if (state.sort !== (T.options.sort || T.labelCol)) p.set('sort', state.sort);
    for (const [k, v] of Object.entries(state.filters)) p.set('f.' + k, v);
    const qs = p.toString();
    history.replaceState(null, '', `#/t/${encodeURIComponent(T.name)}${qs ? '?' + qs : ''}`);
    addLink.href = newHref();
  }
  function newHref() {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(state.filters)) if (v !== NULLV) p.set(k, v);
    const qs = p.toString();
    return `#/t/${encodeURIComponent(T.name)}/new${qs ? '?' + qs : ''}`;
  }

  const facetsBox = h('div.facets');
  const countBox = h('span.muted', { id: 'row-count' });
  const listBox = h('div.lines');
  const moreBox = h('div.more');
  const addLink = h('a.btn.icon-btn', { href: newHref(), 'aria-label': t('addRow'), id: 'add-row' }, icon('plus'));

  async function refresh() {
    const w = where();
    const shown = await value(`SELECT count(*) FROM ${qi(T.name)}${w.sql}`, w.bind);
    const data = await rows(
      `SELECT rowid AS __id, ${leadExpr(T)} AS __lead, * FROM ${qi(T.name)}${w.sql} ORDER BY ${orderBy(T, state.sort)} LIMIT ${state.limit}`, w.bind);
    countBox.textContent = shown === total ? t('rows', { n: total }) : t('rowsOf', { a: shown, b: total });

    facetsBox.replaceChildren();
    for (const c of facetCols) {
      const fw = where(c.name);
      const order = c.options.facetSort === 'value' ? 'v IS NULL, v' : 'n DESC, v';
      const vals = await rows(
        `SELECT ${qi(c.name)} AS v, count(*) AS n FROM ${qi(T.name)}${fw.sql} GROUP BY 1 ORDER BY ${order}`, fw.bind);
      if (!vals.length) continue;
      const chips = vals.map(({ v, n }) => {
        const key = v === null || v === '' ? NULLV : String(v);
        const active = state.filters[c.name] === key;
        const text = key === NULLV ? t('empty') : c.fk ? (maps[c.fk.table]?.get(v) ?? '#' + v) : v;
        return h('button.chip' + (active ? '.on' : ''), {
          type: 'button', 'aria-pressed': String(active),
          onclick: () => {
            if (active) delete state.filters[c.name]; else state.filters[c.name] = key;
            state.limit = PAGE;
            syncUrl();
            refresh();
          },
        }, bdi(text), h('span.chip-n', {}, n));
      });
      facetsBox.append(h('div.facet', {}, h('span.facet-label', {}, bdi(c.label)), h('div.chips', {}, chips)));
    }

    listBox.replaceChildren(...data.map((r) => line(T, r, maps)));
    if (!data.length) {
      const filtered = state.q || Object.keys(state.filters).length;
      listBox.append(h('p.empty', {}, filtered ? t('noMatch') : t('noRows'),
        filtered ? h('button.btn.ghost', {
          type: 'button',
          onclick: () => { state.q = ''; search.value = ''; state.filters = {}; syncUrl(); refresh(); },
        }, t('clearFilters')) : null));
    }
    moreBox.replaceChildren(shown > data.length
      ? h('button.btn', { type: 'button', onclick: () => { state.limit += PAGE; refresh(); } }, t('showMore'))
      : '');
  }

  let timer;
  const search = h('input.search', {
    type: 'search', placeholder: t('search'), value: state.q, 'aria-label': t('search'), id: 'search',
    oninput: () => {
      clearTimeout(timer);
      timer = setTimeout(() => { state.q = search.value.trim(); state.limit = PAGE; syncUrl(); refresh(); }, 180);
    },
  });

  const [sortCol, sortDesc] = (() => { const m = /^(.+?)( DESC)?$/.exec(state.sort); return [m[1], !!m[2]]; })();
  const sortSel = h('select', { 'aria-label': t('sort'), id: 'sort-col', onchange: applySort },
    T.cols.filter((c) => !c.hidden || c.name === sortCol).map((c) => h('option', { value: c.name, selected: c.name === sortCol }, c.label)));
  const dirSel = h('select', { 'aria-label': t('sort'), id: 'sort-dir', onchange: applySort },
    h('option', { value: '', selected: !sortDesc }, '↑ ' + t('ascending')),
    h('option', { value: ' DESC', selected: sortDesc }, '↓ ' + t('descending')));
  function applySort() { state.sort = sortSel.value + dirSel.value; syncUrl(); refresh(); }

  await refresh();
  const node = h('div', {},
    h('div.toolbar', {}, search),
    facetsBox,
    h('div.listhead', {}, countBox, h('span.sorter', {}, sortSel, dirSel)),
    listBox, moreBox);
  return { title: T.label, back: '#/', actions: [addLink], node };
}

async function viewRow(T, id) {
  const r = (await rows(`SELECT rowid AS __id, ${leadExpr(T)} AS __lead, * FROM ${qi(T.name)} WHERE rowid = ?`, [id]))[0];
  if (!r) return { title: T.label, back: tableHref(T), node: h('p.empty', {}, t('noMatch')) };
  const maps = await labelMaps(T);
  const leadIsCol = T.options.lead && T.cols.some((c) => c.name === T.options.lead);

  function field(c) {
    const v = r[c.name];
    if (v === null || v === undefined || v === '') return null;
    let body;
    if (c.fk) {
      const R = table(c.fk.table);
      body = h('a', { href: `#/t/${encodeURIComponent(R.name)}/${v}` }, bdi(maps[R.name]?.get(v) ?? '#' + v));
    } else if (c.kind === 'select' && c.facet) body = pill(v);
    else if (c.kind === 'date') body = h('span.num', {}, fmtDate(v));
    else if (c.kind === 'number') body = h('span.num', {}, v);
    else body = richText(v);
    return h('div.field', {}, h('dt', {}, bdi(c.label)), h('dd', {}, body));
  }

  const main = T.cols.filter((c) => !c.hidden && c.name !== T.labelCol && !(leadIsCol && c.name === T.options.lead));
  const hidden = T.cols.filter((c) => c.hidden);
  const node = h('div', {},
    h('div.row-head', {},
      leadIsCol && r.__lead !== null && r.__lead !== '' ? h('span.lead.big', {}, bdi(r.__lead)) : null,
      h('h2.row-title', {}, bdi(r[T.labelCol] ?? '#' + id))),
    h('dl.fields', {}, main.map(field)));

  for (const rel of T.reverse) {
    const R = table(rel.table);
    const rmaps = await labelMaps(R);
    const kids = await rows(
      `SELECT rowid AS __id, ${leadExpr(R)} AS __lead, * FROM ${qi(R.name)} WHERE ${qi(rel.col)} = ? ORDER BY ${orderBy(R, R.options.sort)}`, [id]);
    const list = { ...R, options: { ...R.options, list: (R.options.list || []).filter((n) => n !== rel.col) } };
    node.append(h('section.block', {},
      h('h2', {}, bdi(R.label), h('span.count', {}, kids.length),
        h('a.btn.icon-btn.small', {
          href: `#/t/${encodeURIComponent(R.name)}/new?${encodeURIComponent(rel.col)}=${id}`, 'aria-label': t('addRow'),
        }, icon('plus'))),
      kids.length ? h('div.lines', {}, kids.map((k) => line(list, k, rmaps))) : null));
  }

  node.append(await filesSection(T, id));

  if (hidden.some((c) => r[c.name] !== null && r[c.name] !== '')) {
    node.append(h('details.block', {}, h('summary', {}, t('details')), h('dl.fields', {}, hidden.map(field))));
  }

  node.append(h('div.row-actions.end', {},
    h('button.btn.danger-text', {
      type: 'button', id: 'delete-row',
      onclick: async () => {
        if (!(await confirmSheet(t('deleteRowConfirm'), t('deleteRow')))) return;
        for (const f of await rows('SELECT * FROM _files WHERE tbl = ? AND row_id = ?', [T.name, id])) await deleteFileRow(f);
        await exec(`DELETE FROM ${qi(T.name)} WHERE rowid = ?`, [id]);
        await markDirty();
        toast(t('deleted'));
        location.hash = tableHref(T);
      },
    }, t('deleteRow'))));

  const editLink = h('a.btn', { href: `#/t/${encodeURIComponent(T.name)}/${id}/edit`, id: 'edit-row' }, t('edit'));
  return { title: T.label, back: tableHref(T), actions: [editLink], node };
}

async function viewEdit(T, id, params) {
  const isNew = id === null;
  const r = isNew ? {} : (await rows(`SELECT * FROM ${qi(T.name)} WHERE rowid = ?`, [id]))[0];
  if (!r) return { title: T.label, back: tableHref(T), node: h('p.empty', {}, t('noMatch')) };
  if (isNew) for (const [k, v] of params) if (T.cols.some((c) => c.name === k)) r[k] = v;
  const editable = T.cols.filter((c) => !c.hidden);
  const getters = {};
  const reloaders = [];
  const form = h('form.form', { novalidate: true });

  for (const c of editable) {
    const cur = r[c.name] ?? '';
    const inputId = 'f-' + c.name;
    let control;
    if (c.fk) {
      const R = table(c.fk.table);
      const opts = await exec(`SELECT rowid, ${qi(R.labelCol)} FROM ${qi(R.name)} ORDER BY 2 COLLATE NOCASE`);
      control = h('select', { id: inputId },
        h('option', { value: '' }, '—'),
        opts.rows.map(([oid, label]) => h('option', { value: oid, selected: String(oid) === String(cur) }, label)));
      getters[c.name] = () => (control.value === '' ? null : Number(control.value));
    } else if (c.kind === 'select') {
      const sel = h('select', { id: inputId });
      const custom = h('input', { type: 'text', hidden: true, dir: 'auto', 'aria-label': c.label, id: inputId + '-new' });
      let chosen = String(cur);
      const load = async () => {
        const scope = c.options.scope;
        const scopeVal = scope && getters[scope] ? getters[scope]() : null;
        const found = scope && scopeVal !== null
          ? await exec(`SELECT DISTINCT ${qi(c.name)} FROM ${qi(T.name)} WHERE ${qi(scope)} = ? AND ${qi(c.name)} <> '' ORDER BY 1 COLLATE NOCASE`, [scopeVal])
          : await exec(`SELECT DISTINCT ${qi(c.name)} FROM ${qi(T.name)} WHERE ${qi(c.name)} <> '' ORDER BY 1 COLLATE NOCASE`);
        const values = [...(c.options.choices || [])];
        for (const [v] of found.rows) if (!values.includes(String(v))) values.push(String(v));
        if (chosen && !values.includes(chosen)) values.unshift(chosen);
        sel.replaceChildren(
          h('option', { value: '' }, '—'),
          ...values.map((v) => h('option', { value: v, selected: v === chosen }, v)),
          h('option', { value: '\u0000new' }, t('newValue')));
      };
      sel.addEventListener('change', () => {
        custom.hidden = sel.value !== '\u0000new';
        if (!custom.hidden) custom.focus(); else chosen = sel.value;
      });
      await load();
      if (c.options.scope) reloaders.push({ scope: c.options.scope, load });
      control = h('div.stack', {}, sel, custom);
      getters[c.name] = () => {
        const v = sel.value === '\u0000new' ? custom.value.trim() : sel.value;
        return v === '' ? null : v;
      };
    } else if (c.kind === 'textarea') {
      control = h('textarea', { id: inputId, rows: Math.min(14, Math.max(3, String(cur).split('\n').length + 1)), dir: 'auto', value: cur });
      getters[c.name] = () => (control.value === '' ? null : control.value);
    } else if (c.kind === 'number') {
      control = h('input', { id: inputId, type: 'number', inputMode: 'decimal', step: 'any', value: cur });
      getters[c.name] = () => (control.value === '' ? null : Number(control.value));
    } else if (c.kind === 'date') {
      control = h('input', { id: inputId, type: 'date', value: String(cur).slice(0, 10) });
      getters[c.name] = () => (control.value === '' ? null : control.value);
    } else {
      control = h('input', { id: inputId, type: 'text', dir: 'auto', value: cur, autocomplete: 'off' });
      getters[c.name] = () => { const v = control.value.trim(); return v === '' ? null : v; };
    }
    form.append(h('div.form-field', {}, h('label', { for: inputId }, bdi(c.label)), control));
  }
  form.addEventListener('change', (e) => {
    for (const rl of reloaders) if (e.target.id === 'f-' + rl.scope) rl.load();
  });

  const error = h('p.status.error', { role: 'alert' });
  const backTo = isNew ? tableHref(T) : `#/t/${encodeURIComponent(T.name)}/${id}`;
  form.append(error, h('div.row-actions', {},
    h('button.btn.primary', { type: 'submit', id: 'save' }, t('save')),
    h('a.btn', { href: backTo }, t('cancel'))));
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const vals = {};
    for (const c of editable) {
      vals[c.name] = getters[c.name]();
      if (c.notnull && vals[c.name] === null) { error.textContent = t('required', { label: c.label }); return; }
    }
    const names = Object.keys(vals);
    try {
      let rowId = id;
      if (isNew) {
        const res = await exec(
          `INSERT INTO ${qi(T.name)} (${names.map(qi).join(', ')}) VALUES (${names.map(() => '?').join(', ')})`, names.map((n) => vals[n]));
        rowId = res.lastId;
      } else {
        await exec(`UPDATE ${qi(T.name)} SET ${names.map((n) => qi(n) + ' = ?').join(', ')} WHERE rowid = ?`, [...names.map((n) => vals[n]), id]);
      }
      await markDirty();
      toast(t('saved'));
      history.replaceState(null, '', `#/t/${encodeURIComponent(T.name)}/${rowId}`);
      render();
    } catch (err) {
      error.textContent = err.message;
    }
  });
  return { title: isNew ? t('addRow') : t('edit'), back: backTo, node: form };
}

async function viewSql() {
  const out = h('div.sql-out');
  const area = h('textarea.code', {
    rows: 5, spellcheck: false, autocapitalize: 'off', autocomplete: 'off', dir: 'ltr',
    placeholder: t('sqlPlaceholder'), value: S.sqlText, id: 'sql-text',
  });
  async function run(sql) {
    S.sqlText = area.value;
    out.replaceChildren();
    try {
      const r = await exec(sql);
      if (r.columns.length) {
        out.append(h('p.muted', {}, t('rows', { n: r.rows.length })),
          h('div.table-wrap', {}, h('table', {},
            h('thead', {}, h('tr', {}, r.columns.map((c) => h('th', {}, bdi(c))))),
            h('tbody', {}, r.rows.slice(0, 500).map((row) => h('tr', {},
              row.map((v) => h('td', { dir: 'auto' }, v === null ? h('span.muted', {}, 'NULL') : v instanceof Uint8Array ? `blob ${v.length}` : String(v)))))))));
      } else {
        out.append(h('p.status', {}, t('rowsChanged', { n: r.changes })));
      }
      if (!/^\s*(select|pragma|explain|with)\b/i.test(sql)) { await markDirty(); await loadSchema(); }
    } catch (e) {
      out.append(h('p.status.error', { role: 'alert', dir: 'ltr' }, e.message));
    }
  }
  const node = h('div', {},
    area,
    h('div.row-actions', {},
      h('button.btn.primary', { type: 'button', id: 'sql-run', onclick: () => run(area.value) }, t('run')),
      h('button.btn', {
        type: 'button',
        onclick: () => {
          area.value = "SELECT name, sql FROM sqlite_schema WHERE type = 'table' ORDER BY name";
          run(area.value);
        },
      }, t('showSchema'))),
    out);
  return { title: t('sql'), node };
}

// ---------------------------------------------------------------- backup, restore, Airtable

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

async function buildBackup(withFiles, onProgress) {
  // The backup time is written first so that the exported file carries it.
  const before = { last: S.meta.last_backup, dirty: S.meta.dirty };
  await setMeta('last_backup', new Date().toISOString());
  await setMeta('dirty', 0);
  const { bytes } = await rpc('exportDb');
  const restore = async () => {
    if (before.last === undefined) { await exec("DELETE FROM _meta WHERE key = 'last_backup'"); delete S.meta.last_backup; } else await setMeta('last_backup', before.last);
    await setMeta('dirty', before.dirty || 0);
  };
  const dbBlob = new Blob([bytes], { type: 'application/vnd.sqlite3' });
  if (!withFiles) return { file: new File([dbBlob], `craglog-${stamp()}.sqlite`, { type: dbBlob.type }), undo: restore };
  const entries = [{ name: 'craglog.sqlite', blob: dbBlob }];
  for (const f of await rows('SELECT path FROM _files ORDER BY id')) {
    const file = await readFile(f.path);
    if (file) entries.push({ name: 'files/' + f.path, blob: file });
  }
  const zip = await zipBlob(entries, onProgress);
  return { file: new File([zip], `craglog-backup-${stamp()}.zip`, { type: 'application/zip' }), undo: restore };
}

async function importFile(file, onProgress) {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const isZip = head[0] === 0x50 && head[1] === 0x4b;
  if (!isZip) {
    await rpc('importDb', { blob: file });
  } else {
    const entries = (await unzip(file)).filter((e) => !e.name.startsWith('__MACOSX/'));
    const dbEntry = entries.find((e) => /(^|\/)craglog\.sqlite$/.test(e.name)) || entries.find((e) => /\.(sqlite|db)$/i.test(e.name));
    if (!dbEntry) throw new Error('not-sqlite');
    const prefix = dbEntry.name.slice(0, dbEntry.name.lastIndexOf('/') + 1) + 'files/';
    await rpc('importDb', { blob: await dbEntry.blob() });
    await rpc('wipeFiles');
    // Only files the database refers to are restored.
    const wanted = new Set();
    try { for (const [p] of (await exec('SELECT path FROM _files')).rows) wanted.add(p); } catch (e) { /* no attachments table */ }
    const files = entries.filter((e) => e.name.startsWith(prefix) && wanted.has(e.name.slice(prefix.length)));
    let n = 0;
    for (const e of files) {
      await rpc('writeFile', { path: e.name.slice(prefix.length), blob: await e.blob() });
      if (onProgress) onProgress(++n, files.length);
    }
  }
  await loadSchema();
}

async function airtableFetch(token, overwrite, log) {
  const map = parseJson(S.meta.airtable, null);
  if (!map) throw new Error(t('airtableNoMap'));
  const api = map.apiBase || 'https://api.airtable.com/v0';
  const stats = { files: 0, rows: 0, failed: 0 };
  const downloads = [];
  for (const m of map.tables) {
    const T = table(m.table);
    if (!T) continue;
    log(t('airtableReading', { table: T.label }));
    let offset = '';
    do {
      const url = `${api}/${map.baseId}/${m.tableId}?pageSize=100&returnFieldsByFieldId=true${offset ? '&offset=' + encodeURIComponent(offset) : ''}`;
      const res = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
      if (res.status === 401 || res.status === 403) throw new Error(t('airtableAuth', { status: res.status }));
      if (!res.ok) throw new Error('Airtable ' + res.status);
      const page = await res.json();
      for (const rec of page.records) {
        const vals = {};
        for (const [col, fld] of Object.entries(m.fields || {})) {
          const v = rec.fields[fld];
          vals[col] = v === undefined ? null : typeof v === 'object' && v !== null ? (v.name ?? JSON.stringify(v)) : v;
        }
        for (const [col, link] of Object.entries(m.links || {})) {
          const first = (rec.fields[link.field] || [])[0];
          vals[col] = first ? await value(`SELECT rowid FROM ${qi(link.table)} WHERE airtable_id = ?`, [first]) : null;
        }
        const names = Object.keys(vals);
        let rowId = await value(`SELECT rowid FROM ${qi(T.name)} WHERE airtable_id = ?`, [rec.id]);
        if (rowId === null) {
          const r = await exec(
            `INSERT INTO ${qi(T.name)} (${[...names, 'airtable_id'].map(qi).join(', ')}) VALUES (${names.map(() => '?').join(', ')}, ?)`,
            [...names.map((n) => vals[n]), rec.id]);
          rowId = r.lastId;
          stats.rows++;
        } else if (overwrite) {
          await exec(`UPDATE ${qi(T.name)} SET ${names.map((n) => qi(n) + ' = ?').join(', ')} WHERE rowid = ?`, [...names.map((n) => vals[n]), rowId]);
        }
        for (const fld of m.attachments || []) {
          for (const att of rec.fields[fld] || []) {
            if ((await value('SELECT count(*) FROM _files WHERE airtable_id = ?', [att.id])) === 0) downloads.push({ tbl: T.name, rowId, att });
          }
        }
      }
      offset = page.offset || '';
    } while (offset);
  }
  let n = 0;
  for (const d of downloads) {
    log(t('airtableFile', { a: ++n, b: downloads.length }));
    try {
      const res = await fetch(d.att.url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      await storeFile(d.tbl, d.rowId, new File([blob], d.att.filename, { type: d.att.type || blob.type }), d.att.id);
      stats.files++;
    } catch (e) {
      stats.failed++;
    }
  }
  if (stats.files || stats.rows || overwrite) await markDirty();
  return stats;
}

async function viewSettings() {
  const node = h('div.settings');

  // Backup
  const backupStatus = h('p.status', { role: 'status' });
  const saveSlot = h('div');
  const dirty = +S.meta.dirty || 0;
  const last = S.meta.last_backup ? new Date(S.meta.last_backup).toLocaleString(S.lang === 'he' ? 'he-IL' : 'en-GB') : t('never');
  async function prepare(withFiles) {
    saveSlot.replaceChildren();
    backupStatus.textContent = t('preparing', { a: 0, b: 1 });
    try {
      const { file, undo } = await buildBackup(withFiles, (a, b) => { backupStatus.textContent = t('preparing', { a, b }); });
      backupStatus.textContent = fmtBytes(file.size);
      // Saving happens on a second tap: the share sheet only opens straight from a tap.
      saveSlot.replaceChildren(h('button.btn.primary', {
        type: 'button', id: 'save-backup',
        onclick: async () => { if (!(await shareOrDownload(file))) await undo(); },
      }, t('saveFile', { name: file.name })));
    } catch (e) {
      backupStatus.textContent = e.message;
    }
  }
  node.append(h('section.block', {},
    h('h2', {}, t('backupTitle')),
    h('p', {}, t('backupText')),
    h('p.muted', {}, t('lastBackup', { when: last })),
    dirty ? h('p', {}, t('unsaved', { n: dirty })) : null,
    h('div.stack', {},
      h('button.btn', { type: 'button', id: 'prepare-backup', onclick: () => prepare(true) }, t('prepareBackup')),
      h('button.btn', { type: 'button', id: 'prepare-db', onclick: () => prepare(false) }, t('prepareDb'))),
    backupStatus, saveSlot));

  // Restore
  node.append(h('section.block', {}, h('h2', {}, t('restoreTitle')), h('p', {}, t('restoreText')), importButton(t('restoreBtn'), '')));

  // Airtable
  if (S.meta.airtable) {
    const token = h('input', { type: 'password', autocomplete: 'off', placeholder: 'pat…', dir: 'ltr', id: 'at-token', 'aria-label': t('airtableToken') });
    const over = h('input', { type: 'checkbox', id: 'at-over' });
    const status = h('p.status', { role: 'status', id: 'at-status' });
    const start = h('button.btn', {
      type: 'button', id: 'at-start',
      onclick: async () => {
        if (!token.value.trim()) { token.focus(); return; }
        start.disabled = true;
        try {
          const s = await airtableFetch(token.value.trim(), over.checked, (m) => { status.textContent = m; });
          status.textContent = t('airtableDone', s);
          token.value = '';
        } catch (e) {
          status.textContent = e.message;
        }
        start.disabled = false;
      },
    }, t('airtableStart'));
    node.append(h('section.block', {},
      h('h2', {}, t('airtableTitle')),
      h('p', {}, t('airtableText')),
      h('div.stack', {}, token, h('label.check', {}, over, ' ', t('airtableOverwrite')), start),
      status));
  }

  // Storage
  const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : {};
  const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
  const offline = !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  node.append(h('section.block', {},
    h('h2', {}, t('storageTitle')),
    h('p', {}, t('storageUsed', { used: fmtBytes(est.usage || 0) })),
    h('p', {}, t('storageProtected', { v: persisted ? t('yes') : t('no') })),
    h('p', {}, t('storageOffline', { v: offline ? t('yes') : t('notYet') }))));

  // Language
  const langSel = h('select', {
    id: 'lang',
    onchange: async () => { await setMeta('lang', langSel.value); await loadSchema(); render(); },
  }, h('option', { value: 'en', selected: S.lang === 'en' }, 'English'), h('option', { value: 'he', selected: S.lang === 'he' }, 'עברית'));
  node.append(h('section.block', {}, h('h2', {}, h('label', { for: 'lang' }, t('language'))), langSel));

  // Erase
  node.append(h('section.block', {},
    h('h2', {}, t('eraseTitle')),
    h('button.btn.danger-text', {
      type: 'button', id: 'erase',
      onclick: async () => {
        if (!(await confirmSheet(t('eraseConfirm'), t('erase')))) return;
        await rpc('wipeAll');
        await loadSchema();
        toast(t('erased'));
        location.hash = '#/';
        render();
      },
    }, t('erase')),
    h('p.muted', {}, t('version', { v: APP_VERSION, s: S.sqlite }))));

  return { title: t('settings'), node };
}

// ---------------------------------------------------------------- router

async function route() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const params = new URLSearchParams(query);
  const seg = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (seg[0] === 'sql') return viewSql();
  if (seg[0] === 'settings') return viewSettings();
  if (seg[0] === 't' && seg[1]) {
    const T = table(seg[1]);
    if (!T) return viewHome();
    if (seg[2] === 'new') return viewEdit(T, null, params);
    if (seg[2] && seg[3] === 'edit') return viewEdit(T, Number(seg[2]), params);
    if (seg[2]) return viewRow(T, Number(seg[2]));
    return viewTable(T, params);
  }
  return viewHome();
}

async function render() {
  const seq = ++renderSeq;
  const oldUrls = blobUrls;
  blobUrls = [];
  let view;
  try {
    view = await route();
  } catch (e) {
    view = { title: t('appName'), back: '#/', node: h('p.status.error', { role: 'alert', dir: 'ltr' }, e.message) };
  }
  if (seq !== renderSeq) { blobUrls.push(...oldUrls); return; }
  document.getElementById('title').replaceChildren(bdi(view.title));
  const back = document.getElementById('back');
  back.hidden = !view.back;
  back.onclick = () => { location.hash = view.back; };
  document.getElementById('actions').replaceChildren(...(view.actions || []));
  document.getElementById('view').replaceChildren(view.node);
  const top = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0] || 't';
  for (const a of document.querySelectorAll('nav a')) a.classList.toggle('on', a.dataset.tab === (top === 'sql' || top === 'settings' ? top : 't'));
  window.scrollTo(0, 0);
  for (const u of oldUrls) URL.revokeObjectURL(u);
}

function fatal(message, detail) {
  document.getElementById('view').replaceChildren(
    h('div.welcome', {}, h('p', {}, message), detail ? h('p.muted', { dir: 'ltr' }, detail) : null));
}

async function start() {
  S.browserLang = (navigator.language || 'en').startsWith('he') ? 'he' : 'en';
  S.lang = S.browserLang;
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
  if (navigator.locks) {
    const free = await new Promise((res) => {
      navigator.locks.request('craglog-db', { ifAvailable: true }, (lock) => {
        res(!!lock);
        return lock ? new Promise(() => {}) : undefined;
      });
    });
    if (!free) return fatal(t('otherTab'));
  }
  try {
    const info = await rpc('init');
    S.sqlite = info.sqlite;
  } catch (e) {
    return fatal(t('noStorage'), e.message);
  }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  await loadSchema();
  window.addEventListener('hashchange', render);
  await render();
  document.documentElement.dataset.ready = '1';
}

start();

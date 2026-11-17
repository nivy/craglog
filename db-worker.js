// Database worker: owns the SQLite file and the attachment files.
// Everything lives in this browser's private storage for this site (OPFS).
// The "opfs-sahpool" storage mode is used because it needs no special HTTP
// headers, so the app can be served from plain static hosting.
import sqlite3InitModule from './lib/sqlite/index.mjs';

const DB = '/craglog.sqlite';
const TMP = '/import-check.sqlite';
// Everything sits under one folder, because all sites on the same host
// (for example every GitHub Pages project of one account) share this storage.
const APP_DIR = 'craglog';
const FILES_DIR = 'files';
const CHUNK = 4 << 20;

let sqlite3, pool, db;

async function appDir() {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(APP_DIR, { create: true });
}
async function filesDir() {
  return (await appDir()).getDirectoryHandle(FILES_DIR, { create: true });
}

function open() {
  db = new pool.OpfsSAHPoolDb(DB);
  db.exec('PRAGMA foreign_keys = ON');
}

function run(sql, bind) {
  const columns = [];
  const rows = db.exec({
    sql,
    bind: bind && bind.length ? bind : undefined,
    rowMode: 'array',
    columnNames: columns,
    returnValue: 'resultRows',
  });
  return {
    columns,
    rows,
    changes: db.changes(),
    lastId: Number(sqlite3.capi.sqlite3_last_insert_rowid(db)),
  };
}

const ops = {
  async init() {
    sqlite3 = await sqlite3InitModule({ print: () => {}, printErr: (...a) => console.warn(...a) });
    pool = await sqlite3.installOpfsSAHPoolVfs({
      name: 'craglog-pool',
      directory: APP_DIR + '/db',
      initialCapacity: 8,
    });
    await pool.reserveMinimumCapacity(8);
    open();
    return { sqlite: sqlite3.version.libVersion };
  },

  exec({ sql, bind }) {
    return run(sql, bind);
  },

  // Several statements in one transaction: all succeed or none do.
  batch({ statements }) {
    const out = [];
    db.transaction(() => {
      for (const s of statements) out.push(run(s.sql, s.bind));
    });
    return out;
  },

  exportDb() {
    const bytes = pool.exportFile(DB);
    return { bytes, transfer: [bytes.buffer] };
  },

  // Replace the database with the given SQLite file. The file is opened and
  // checked under a temporary name first, so a bad file never replaces good data.
  async importDb({ blob }) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const magic = new TextDecoder().decode(bytes.subarray(0, 15));
    if (magic !== 'SQLite format 3') throw new Error('not-sqlite');
    try { pool.unlink(TMP); } catch (e) { /* nothing to remove */ }
    await pool.importDb(TMP, bytes);
    let check;
    const t = new pool.OpfsSAHPoolDb(TMP);
    try {
      check = t.selectValue('PRAGMA quick_check');
      t.selectValue('SELECT count(*) FROM sqlite_schema');
    } finally {
      t.close();
      pool.unlink(TMP);
    }
    if (check !== 'ok') throw new Error('corrupt: ' + check);
    db.close();
    try {
      await pool.importDb(DB, bytes);
    } finally {
      open();
    }
    return { size: bytes.byteLength };
  },

  async writeFile({ path, blob }) {
    const dir = await filesDir();
    const fh = await dir.getFileHandle(path, { create: true });
    const ah = await fh.createSyncAccessHandle();
    try {
      ah.truncate(0);
      let off = 0;
      while (off < blob.size) {
        const buf = new Uint8Array(await blob.slice(off, off + CHUNK).arrayBuffer());
        ah.write(buf, { at: off });
        off += buf.byteLength;
      }
      ah.flush();
    } finally {
      ah.close();
    }
    return { size: blob.size };
  },

  async deleteFile({ path }) {
    const dir = await filesDir();
    try { await dir.removeEntry(path); } catch (e) { /* already gone */ }
    return {};
  },

  async listFiles() {
    const dir = await filesDir();
    const out = [];
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind === 'file') out.push(name);
    }
    return out;
  },

  async wipeFiles() {
    const dir = await appDir();
    try { await dir.removeEntry(FILES_DIR, { recursive: true }); } catch (e) { /* none */ }
    return {};
  },

  // Erase the database and every attachment on this device.
  async wipeAll() {
    db.close();
    try { pool.unlink(DB); } catch (e) { /* none */ }
    await ops.wipeFiles();
    open();
    return {};
  },
};

self.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const result = await ops[op](args || {});
    const transfer = result && result.transfer ? result.transfer : [];
    if (result && result.transfer) delete result.transfer;
    self.postMessage({ id, ok: true, result }, transfer);
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};

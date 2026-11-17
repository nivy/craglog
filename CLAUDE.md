# Craglog: notes for Claude Code

Craglog is an offline table browser and editor that runs in the browser on a
SQLite file kept on the device. It is hosted as static files on GitHub Pages
(`https://<user>.github.io/craglog/`) and installed on an iPhone Home Screen.
`README.md` is the user-facing description; read it first.

## Hard rules

- **This repository is public. Never commit data.** No `.sqlite` files, no
  backups, no photos or guidebook scans, no Airtable ids, no tokens. Personal
  material lives in `private/`, which is git-ignored. Check `git status`
  before every commit.
- **The app stays generic.** No table or column names in the code. The
  interface is built from the database (`loadSchema()` in `app.js`) plus the
  optional `_ui` table. Anything specific to one person's data belongs in
  their database.
- **No build step, no CDN.** Plain ES modules served as they are. Every file
  the app needs is in this repository and listed in `ASSETS` in `sw.js`.
  A new file that is not added to `ASSETS` will be missing offline.
- **Both languages.** Every interface string goes in `strings.js` in English
  and Hebrew. Use CSS logical properties (`padding-inline`, `inset-inline`,
  `text-align: start`) so right-to-left keeps working. Wrap single-line data
  values in `<bdi>`; use `dir="auto"` on multi-line text.
- **Storage names are permanent.** The OPFS folder `craglog/`, the database
  name `/craglog.sqlite` and the pool name in `db-worker.js` must not change
  once people have data, or their data becomes unreachable.

## Layout

| File | Role |
| --- | --- |
| `index.html`, `style.css` | Shell: header, bottom nav, design tokens |
| `app.js` | Schema loading, router, all views, backup, restore, Airtable fetch |
| `db-worker.js` | Module worker: owns SQLite and writes attachment files |
| `zip.js` | Dependency-free zip writer (stored) and reader (stored + deflate) |
| `strings.js` | Interface text, `en` and `he` |
| `sw.js` | Service worker: answers from cache, refreshes in the background |
| `lib/sqlite/` | `@sqlite.org/sqlite-wasm` 3.54.1, copied from its `dist/` |
| `fonts/` | IBM Plex Sans Hebrew, hebrew + latin subsets, 400 and 600 |

## How it works

- **Database.** `db-worker.js` uses the `opfs-sahpool` VFS. It needs no
  COOP/COEP headers, which GitHub Pages cannot send. It allows one connection,
  so `app.js` takes a Web Lock and a second tab stops with a message.
- **RPC.** `rpc(op, args)` in `app.js` posts to the worker; helpers `exec`,
  `rows`, `value` wrap SQL. Identifiers are always quoted with `qi()`.
- **Attachments.** Rows in `_files`; bytes in OPFS at `craglog/files/<path>`.
  The worker writes them with sync access handles (Safari has not always had
  `createWritable`); the page reads them with `getFile()`.
- **Backup.** `buildBackup()` exports the database and stitches a zip from
  Blobs without copying files into memory. Saving is a second tap because the
  share sheet only opens straight from a tap.
- **Service worker.** Stale-while-revalidate. While developing, a change shows
  up on the second reload; or unregister the worker in dev tools.
- **Routes.** `#/`, `#/t/<table>`, `#/t/<table>/<id>`, `.../edit`,
  `#/t/<table>/new?<col>=<value>`, `#/sql`, `#/settings`.

## Run and test

```
python3 -m http.server 8000      # then open http://localhost:8000/
```

`private/test.mjs` is an end-to-end run in headless Chrome at phone size
(36 checks: import, facets, search, edit, attachments, reload, offline,
backup/erase/restore, Airtable fetch against a stand-in API, delete, language,
second tab). See `private/README.md`. It depends on the owner's real database,
so it cannot be committed; a version with a synthetic database is the first
item in `docs/ROADMAP.md`.

When changing layout, take screenshots at 390×844 in both languages and in
dark mode, and check that nothing is wider than the viewport (a wide element
once blanked the whole page in right-to-left).

## Deploy

Push to `main`. Pages serves the repository root. Devices pick the new version
up on the launch after their next online launch.

## State of things

- v1 passes all checks in desktop Chrome. **It has not yet run on an iPhone.**
  The open questions there: import in the Home Screen app, data surviving a
  full close and an offline relaunch, adding a photo, and
  Settings → Storage showing "yes" twice.
- The Airtable fetch has only run against a stand-in API. Airtable may refuse
  attachment downloads from a browser.
- Next work is in `docs/ROADMAP.md`.

# Craglog

A small offline table browser and editor that runs in the browser on top of a
SQLite file kept on the device. It borrows its shape from Datasette (table
pages, facets, row pages, a SQL box) and adds editing, attachments and backups.

The app is static files only. There is no server and no account. The code in
this repository contains no data: the database and attachments live in the
browser's private storage on each device.

## Put it on GitHub Pages

1. Create a public repository and add these files at its root.
2. In the repository: Settings → Pages → Deploy from a branch → `main`, `/ (root)`.
3. The app is then at `https://<user>.github.io/<repo>/`.

Anything published through Pages is public, so never commit a database or a
backup to this repository.

## Install on an iPhone

1. Open the Pages address in Safari.
2. Share → Add to Home Screen.
3. Open it from the Home Screen icon, then import your `.sqlite` file or a
   backup `.zip`.

Import from the Home Screen app, not from the Safari tab: iOS gives the two
separate storage, and only the Home Screen app is exempt from Safari's
seven-day cleanup of unused website data. After the first launch with a
connection, the app works with no network.

## Where things are stored

| What | Where |
| --- | --- |
| App code | This site, cached on the device by `sw.js` |
| Database | One SQLite file in the browser's private file system (OPFS), under `craglog/` |
| Photos and PDFs | Files next to the database, in the same private storage |

Removing the Home Screen app, or clearing website data, deletes the database
and files. Settings → Backup produces one `.zip` with the database and all
files; save it to Files or iCloud Drive. Settings → Restore reads that zip (or
a bare `.sqlite` file) back in. The app counts changes since the last backup
and shows the count on the home page.

The exported `.sqlite` is an ordinary SQLite database. It opens in the
`sqlite3` shell, Datasette, or DuckDB (`ATTACH 'craglog.sqlite' (TYPE sqlite)`),
and a copy edited on a computer can be imported back.

## Updating the app

Push changes to the repository. Each device answers from its cache first and
refreshes in the background, so a new version appears on the launch after the
next one made with a connection.

## How the interface is built from the database

- Every table whose name does not start with `_` is listed.
- A column declared with `REFERENCES other(id)` becomes a link and a picker,
  and the other table's row page lists the rows that point at it.
- Column types pick the input: `INTEGER`/`REAL` give a number field, a column
  named `date` or `*_date` gives a date field, `notes`/`description` give a
  multi-line field.

The optional `_ui` table refines this. One row per column, plus one row per
table with `col = ''`:

| Column | Meaning |
| --- | --- |
| `label` | Name shown instead of the table or column name |
| `widget` | `text`, `textarea`, `date`, `number` or `select` |
| `facet` | `1` shows the column as filter chips above the list |
| `hidden` | `1` moves the column under "More details" and out of the form |
| `position` | Order of tables and of columns |
| `options` | JSON, see below |

Table options: `lead` (column shown in the fixed first slot of each line, or
`count:<table>.<column>` to count rows that point here), `list` (columns shown
under the name), `sort` (for example `date DESC`), `labelCol`.

Column options: `choices` (fixed list for a `select`), `scope` (limit a
`select`'s suggestions to rows sharing another column's value), `facetSort`
(`value` to order chips by value instead of by count).

Other `_` tables: `_files` (one row per attachment: table, row id, file name,
stored path) and `_meta` (key/value: `title`, `lang` = `en` or `he`,
`last_backup`, `dirty`, and an optional `airtable` mapping).

New tables and columns can be created from the SQL page; the interface picks
them up at once.

## Fetching attachments from Airtable

If `_meta` holds an `airtable` mapping (base id, table ids, field ids),
Settings shows an Airtable section. Paste a personal access token with the
`data.records:read` scope for that base. The app reads each table through the
Airtable API, adds rows it does not have yet (matched on `airtable_id`), and
downloads attachments it does not have yet. Existing text is left alone unless
the overwrite box is ticked. The token is not stored.

This path was tested against a stand-in for the Airtable API, not against
Airtable itself. If Airtable's servers refuse browser downloads, the result
line reports failed downloads; in that case add the files by hand from each
row's Files section.

## Limits

- One open tab at a time. A second tab says so and stops.
- Needs a browser with OPFS and module workers: Safari 16.4+, Chrome 108+,
  Firefox 111+. Private Browsing has no persistent storage.
- Photos larger than 2400 px on the long side are scaled down when added.
- No sync between devices. Moving data means exporting a backup on one device
  and importing it on the other.

## Third-party parts

- `lib/sqlite/` is the official SQLite WebAssembly build
  (`@sqlite.org/sqlite-wasm` 3.54.1), public domain / Apache-2.0 wrapper.
- `fonts/` is IBM Plex Sans Hebrew, SIL Open Font License 1.1 (`fonts/OFL.txt`).

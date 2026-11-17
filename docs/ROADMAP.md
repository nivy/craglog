# Roadmap

Decisions and findings carried over from the design discussion that produced
v1. "Verified" means checked in the named source on 2026-11-17.

## Requirements from the owner

- Runs on an iPhone, works offline, rows are editable.
- Hosted on GitHub Pages from this public repository.
- Each user's database is personal and private to that user.
- The app will be shared with other people: same site and code, a different
  database per person.
- Most attachments are guidebook topos. They should be shareable with all
  users of the app, but must not be treated as public domain (they may be
  scans of published guidebooks), so they must not be served from this
  repository or any public site.
- Files should be visible outside the app (phone file app, laptop), with a
  cloud drive handling sync.

## 0. Before anything else

1. **iPhone test of v1** (see "State of things" in `CLAUDE.md`). Everything
   below rests on on-device storage working there.
2. **Committable tests.** Replace the private database in `private/test.mjs`
   with a small synthetic one built by the test itself, drop the real Airtable
   ids from the stand-in API, and move the result to `tests/`.

## 1. Cloud sync of the personal database: Dropbox

Chosen over the alternatives:

| Option | Verdict |
| --- | --- |
| Dropbox | Chosen. A static app can sign in without a server and stay signed in. Files land in `Apps/Craglog/`, visible in the Dropbox apps and synced to a laptop, where DuckDB can open the `.sqlite`. |
| Google Drive | Possible second backend. Browser-only apps get roughly one-hour access tokens and no refresh token; renewal must start from a user tap. |
| S3 | Rejected for sharing: every user would need AWS credentials, and there is no consumer file app. |
| Private GitHub repo | Rejected: a token per user, and photos bloat git. |

Verified:

- PKCE in the browser with a refresh token and no client secret:
  `dropbox-sdk-js`, `examples/javascript/pkce-browser/index.html` (calls
  `getAuthenticationUrl(..., 'code', 'offline', ..., true)`), and
  `src/auth.js` (refresh without a secret when PKCE was used).
- Conflict-safe upload: `dropbox-api-spec`, `files.stone`, `WriteMode.update`
  takes the last known `rev` and refuses to overwrite a newer file (it writes a
  "conflicted copy" instead).
- A new Dropbox app can be linked only by its owner until "Enable additional
  users" is switched on in the App Console; once 50 accounts have linked,
  production approval is needed (Dropbox developer guide).

Design:

- Register a Dropbox app with **App folder** access. The app key is public by
  design and can live in the code. The redirect URI is the Pages address, so
  the repository name must not change.
- The phone keeps its working copy in OPFS (needed offline). Dropbox is the
  sync target, not a live file system: a web app on iOS cannot mount a cloud
  folder.
- Sync rule, using the stored `rev` and the local `dirty` counter in `_meta`:
  - remote unchanged, local dirty → upload with `mode: update(rev)`
  - remote newer, local clean → download and import
  - both changed → keep both: upload local as a dated copy, ask which to use
- Attachments: upload each file once under `files/`, keyed by `_files.path`;
  download on demand, with a per-row "keep offline" default of on.
- Keep manual backup and restore as they are.
- No Dropbox SDK is needed: the handful of HTTP calls (`/oauth2/token`,
  `files/upload`, `files/download`, `files/get_metadata`, `files/list_folder`)
  can be written directly, which keeps the no-dependency rule. Add
  `api.dropboxapi.com` and `content.dropboxapi.com` handling outside the
  service worker's cache (it already ignores other origins).

## 2. Sharing the app

1. A new user opens the same Pages address and adds it to the Home Screen.
2. "Start new logbook" creates an empty database from a schema template that
   ships with the app (tables and `_ui` rows, no data).
3. "Connect Dropbox" links their own account. Their database is in their own
   Dropbox; nobody else can read it.
4. An invite link (`#/join?guide=<shared link>`) attaches the shared guide.

## 3. Shared guide (topos)

- Not in this repository and not on Pages: both are world-readable, and
  publishing scans of printed guidebooks may infringe copyright. This is a risk
  for the owner to weigh, not a legal opinion.
- A Dropbox folder owned by the maintainer, shared by link with invited
  people only. Verified in `dropbox-api-spec`: `files/list_folder` accepts a
  `shared_link` argument, and `sharing/get_shared_link_file` is allowed for
  app-folder apps (`allow_app_folder_app = true`, scope `sharing.read`).
- Each device downloads the topos it wants for offline use. Only the
  maintainer can change the folder. Anyone holding the link can view it;
  removing the link cuts access.

**Open decision:** are sites (name, location, access notes) shared together
with their topos, or personal? Recommended: shared. A shared topo needs a
shared site to hang on, which splits the data into a shared *guide* (sites and
topos, read-only for most users, published by the maintainer) and a personal
*log* (routes, gear, personal photos). That means two databases attached side
by side, with personal rows pointing at guide sites by a stable id.

## Smaller items

- An "update available" hint when the service worker has fetched a new version.
- Thumbnails for image attachments instead of decoding full images in grids.
- Choices and colours for `select` columns editable from the interface.
- Table and column management without writing SQL.

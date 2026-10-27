# WebWriter

A calm, self-hosted place to write novels — in your browser, on your own server, with first-class support for the LiteWriter Android app.

<img width="1900" height="909" alt="Screenshot 2026-10-27 095906" src="https://github.com/user-attachments/assets/6f844279-9308-4b70-be09-b598afc9b5b3" />

## Features

- **Distraction-free editor** – plain Markdown, autosave, focus mode, typewriter scrolling, adjustable font/size/line length, chapter drawer and previous/next navigation, daily word goal.
- **Your text is safe** – every keystroke is mirrored to a local draft; saves retry automatically when the connection drops; edits made elsewhere (another tab, or your phone) are detected and you choose which version to keep.
- **Novels, books and chapters** – covers, synopsis, drag-and-drop ordering, renaming, moving chapters between books.
- **LiteWriter integration** – start LiteWriter's WebDAV server and edit the novels on your phone from any browser. The library never waits for the phone: device novels load in the background, requests time out instead of hanging, and word counts are cached so only changed files are downloaded.
- **Export** – EPUB, Word (.docx), print-ready HTML (→ PDF), Markdown, plain text or the raw files as ZIP. For the whole novel, a single book or a single chapter — local and LiteWriter novels alike.
- **Multiple writers** – invite people with expiring invite links; administrators can manage roles, reset passwords, disable or delete accounts. Every writer has a private library, settings and backups.
- **Backups** – one-click or scheduled (daily/weekly) backups with retention, optional snapshot of your LiteWriter novels, upload/restore, and optional Google Drive upload.
- **Statistics** – words per day, streaks, weekly trend and progress per novel, based on what you actually write.
- Light, dark and system themes, accent colours and an optional background image.

## Getting started

Requires Node.js 20 or newer.

```bash
npm install
cp .env.example .env   # optional, everything has sensible defaults
npm start
```

Open http://localhost:3000. On the first visit you create the administrator account. Invite other writers from **Users**.

### Docker

```bash
docker compose up -d
```

Data is stored in `./data` (mounted to `/data`). The container runs as the `node` user (uid 1000), so make sure that directory is writable: `mkdir -p data && sudo chown 1000:1000 data`.

### Behind a reverse proxy

WebWriter works behind Nginx, Caddy, Traefik etc. Proxies on the same machine or in a private network are trusted by default; set `TRUST_PROXY` otherwise. Cookies are automatically marked secure when the request arrives via HTTPS. Set `BASE_URL` (e.g. `https://write.example.com`) so invite links and the Google callback use your public address.

## Configuration

All settings are optional environment variables — see [`.env.example`](.env.example).

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Where to listen |
| `DATA_DIR` | `./data` | Database, novels, backups and uploads |
| `SESSION_SECRET` | generated | Signs session cookies (auto-generated and stored in `DATA_DIR` if unset) |
| `BASE_URL` | from request | Public URL for invite links and Google OAuth |
| `TRUST_PROXY` | private networks | Express `trust proxy` setting |
| `COOKIE_SECURE` | `auto` | `auto`, `true` or `false` |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | – | Enables Google Drive backup uploads |
| `LITEWRITER_TIMEOUT_MS` | `15000` | Per-request timeout when talking to the phone |
| `LITEWRITER_CONCURRENCY` | `4` | Parallel requests to the phone |
| `LITEWRITER_CACHE_MS` | `60000` | How long the device's novel list is cached |

## LiteWriter

1. In LiteWriter, start the WebDAV server and note the address it shows (e.g. `http://192.168.1.50:8080`).
2. In WebWriter go to **Settings → LiteWriter**, enter the address (and username/password if you set one in the app), press **Test connection**, then **Save**.
3. Your phone's novels appear in the library under *LiteWriter*.

Phone and server need to reach each other — the same Wi-Fi works; [Tailscale](https://tailscale.com) works from anywhere.

How LiteWriter's files are understood: every folder is a novel (`_` in the name shows as a space), `cover.jpg|png|webp` is the cover, `Synopsis.md` (or `Intro.md`) is the synopsis, `.md`/`.txt` files in the folder are the chapters of the main book and sub-folders are further books. Edits are written straight back to the phone, keeping each file's extension. You can create new chapters on the device from WebWriter; renaming, deleting and reordering are left to the app. Use **Copy to my library** to keep an independent copy on the server.

## Data layout

```
data/
  webwriter.db                 users, settings, invites, sessions, writing log
  users/<id>/library/<novel>/  meta.json, cover, Main/Synopsis.md, <Book>/<Chapter>.md
  users/<id>/backups/*.zip
  uploads/backgrounds/
```

Chapters are plain Markdown files, so your writing is never locked in.

## Upgrading from WebWriter 1.x

Just start the new version in the same directory. On first start it automatically:

- imports the accounts from `database/users.db` (passwords keep working; the old default `admin`/`admin` has to be changed on next sign-in),
- moves `data/novels` into the administrator's library and old `data/backups` into their backup list,
- carries over theme, background and LiteWriter settings.

Old 1.x backup ZIPs can be restored from the Backups page. Once you're happy, `database/` and `public/backgrounds/` can be deleted.

## Development

```bash
npm run dev   # restarts on changes
npm test      # integration tests, including a simulated LiteWriter device
```

The app is plain Express + EJS with no build step: `lib/` holds the domain logic (storage, LiteWriter client, exports, backups), `routes/` the HTTP layer, `views/` the templates and `public/` the CSS and browser scripts.

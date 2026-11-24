# Architecture

How the app works, for developers. The [README](../README.md) covers
deploying and running it.

Everything is one Cloudflare Worker (`src/worker.js`) serving four HTML
templates from `public/`. The Worker fills each template's placeholders
(`{{COUPLE}}`, `{{LOCATIONS_JSON}}`, `{{THEME_HEAD}}`, `{{STATS_TZ}}`…) from
Settings before sending it (`renderPage`). There is no build step and no
framework.

```
src/worker.js          All server logic: routes, auth, settings, themes, schema
public/index.html      Guest upload, gallery, lightbox, leaderboard
public/admin.html      Admin page (fflate and qrcode-generator inlined)
public/admin-gate.html Admin sign-in
public/admin-setup.html  Create the admin password (new sites only)
public/gate.html       Guest password page
public/themes/*.css    Optional themes (Classic is built into the pages)
scripts/setup.mjs      `npm run setup`
test/                  One file per behaviour
wrangler.toml          Cloudflare configuration
```

---

## The database

There are no migration files. `SCHEMA_STATEMENTS` in `src/worker.js` is the
current schema. `getRequestConfig`, which every request already makes, reads
`schema_version` along with the site mode and passphrase, so checking costs
nothing extra:

- **No `config` table** (a brand-new D1 database): `ensureSchema` creates
  everything in one batch and records `schema_version`.
- **An older version:** `ensureSchema` runs `SCHEMA_UPGRADES[n]` for each
  missing version, in order, in one batch.
- **Any other read error** is treated as an outage and fails closed. It is
  never treated as an empty database, which would mark an old database as
  current without upgrading it.

**To change the schema:** update `SCHEMA_STATEMENTS` (what new sites get), bump
`SCHEMA_VERSION`, and add `SCHEMA_UPGRADES[newVersion]` with the statements
that take an existing database from the previous version. Keep upgrades safe
to run twice where you can: two requests can race, and the batch is one
transaction, so a loser fails once and the next request sees the new version.

| Table | Holds |
|---|---|
| `photos` | One row per upload: R2 key, uploader name, location, time, star, uploading device |
| `likes` | One row per photo per device |
| `config` | Every setting as key/value: `site_mode`, `guest_passphrase`, `admin_password_hash`, `couple_name_1/2`, `locations`, `theme`, `stats_timezone`, `featured_min_likes`, `sweep_enabled`, `schema_version` |

---

## Sign-in

### Guests
The passphrase lives only in Settings (`guest_passphrase`). Until one is
saved, no guest can sign in. The guest cookie is an HMAC of the passphrase, so
changing it signs every guest out and retires old QR codes.

### Admin
On a new site there is no admin password, and `/admin` serves
`admin-setup.html` instead of the sign-in form. `POST /admin/setup` stores a
PBKDF2-SHA256 hash (`pbkdf2-sha256$iterations$salt$hash`) with
`INSERT … ON CONFLICT DO NOTHING`, so only the first claim wins. It is refused
once any admin password exists. `npm run setup` claims it for you right after
deploying; with the Deploy button, the owner claims it in the browser.

The iteration count (`PBKDF2_ITERATIONS`) is low by desktop standards because
PBKDF2 runs on the Worker's CPU and the free plan allows about 10 ms a request.
It runs only on sign-in and password changes, which are rate limited, and the
count is stored with each hash so it can be raised later without breaking
existing passwords.

An **`ADMIN_PASSWORD` Cloudflare secret, if set, always wins** over the stored
hash. It's an override for anyone who prefers the key outside the database
(where someone signed in to admin can't change it), and a way back in. While
it's set, Settings → Admin password points to Cloudflare instead of offering
the form.

Admin session tokens are an HMAC keyed by the *admin secret*: the
`ADMIN_PASSWORD` secret if set, otherwise the stored hash
(`withRequestConfig`). Changing either signs every admin out. The token
derivation is pinned by `test/session-cookie.test.mjs`. Changing it would sign
everyone out at the next deploy.

---

## API routes

| Route | Method | Auth | Purpose |
|---|---|---|---|
| `/` | GET | Guest session or `?p=` invite link | Password page or the guest app |
| `/auth` | POST | — | Check the guest passphrase, set the session cookie |
| `/upload` | POST | Guest | Upload a photo |
| `/photos` | GET | Guest | List photos (with likes and the Featured threshold) |
| `/photo-count` | GET | Guest | Cheap fingerprint for "has anything changed?" |
| `/like` | POST | Guest | Like or unlike a photo |
| `/image/:key` | GET | Guest | A full-resolution original |
| `/v/:variant/:key` | GET | Guest | A display size, generated on a miss |
| `/leaderboard` | GET | Guest | A guest's rank after uploading |
| `/rankings` | GET | Guest | The full leaderboard |
| `/admin` | GET | Admin (sign-in form if absent; setup form on a new site) | The admin page |
| `/admin/login` | POST | — | Check the admin password, set the admin cookie |
| `/admin/setup` | POST | — (only while no admin password exists) | Create the admin password on a new site; signs the creator in |
| `/admin/password` | GET / POST | Admin | Whether the password is managed by a Cloudflare secret / change it (needs the current one) |
| `/stats-timezone` | POST | Admin | The time zone admin stats are shown in |
| `/favorite` | POST | Admin | Star / unstar a photo |
| `/delete` | POST | Admin | Delete a photo (original, display sizes, likes) |
| `/rename` | POST | Admin | Rename an uploader across their photos |
| `/storage` | GET | Admin | R2 usage |
| `/presign` | GET | Admin | Photo list, oldest first, for ZIP downloads |
| `/derivatives` | GET / POST | Admin | Audit / rebuild missing display sizes |
| `/sweep` | GET / POST | Admin | Scheduled photo repair on/off |
| `/site-mode` | GET / POST | Admin | Live / pre-wedding / post-wedding |
| `/featured-min` | POST | Admin | Likes needed for Featured |
| `/couple-names` | GET / POST | Admin | The couple's names |
| `/locations` | POST | Admin | Upload locations (refused with 409 while photos exist) |
| `/theme` | POST | Admin | Display theme |
| `/admin/theme-preview?theme=<id>` | GET | Admin | The guest home page in any theme, for the Settings → Theme thumbnails. The only page that can be framed, and only by this site |
| `/guest-passphrase` | GET / POST | Admin | Read / change the guest passphrase |
| `/robots.txt` | GET | — | Blocks all crawlers |

---

## Cloudflare services in use

| Service | Binding | Purpose |
|---|---|---|
| Workers | — | Serves the app and all API routes; a cron every 15 minutes runs photo repair |
| R2 | `BUCKET` | Originals (`photos/`) and display sizes (`derived/`) |
| D1 | `DB` | Photo list, likes, and all Settings |
| KV | `RATE_LIMIT_KV` | Rate-limit counters |
| Images | `IMAGES` | Generates the display sizes |
| Queues | `PHOTO_QUEUE` | Builds display sizes after upload |

`wrangler.toml` names the bindings without resource IDs. `wrangler deploy` and
the Deploy to Cloudflare button create the resources on first deploy, and a
local deploy writes their IDs back into the file.

---

## Admin page

### The ⋯ menu

| Item | What it does |
|---|---|
| 📊 **View stats** | Totals, uploads by location / uploader / day / hour |
| ⬇ **Download all photos** | Every photo as ZIPs — see [Downloading photos](#downloading-photos) |
| ⚙️ **Settings** | One screen for everything below. A read-only line under it shows photo repair and site mode at a glance (`🛠 On · 🔒 Live`) |

### Settings

Settings leads with what changes during the wedding and ends with the one-time
setup, which sits behind buttons so a growing list never pushes the rest down.

| Section | What it controls |
|---|---|
| **Site mode** | Live / Pre-wedding / Post-wedding — see [Site mode](#site-mode) |
| **Photo repair** | The scheduled display-size repair — see [Photo repair](#photo-repair-the-scheduled-sweep) |
| **Featured** | How many guest likes put a photo in Featured |
| **Wedding setup → Couple** | The couple's names, shown on every guest page as "First & Second" |
| **Wedding setup → Guest access ›** | Site address (read-only), passphrase, invite link, and the invite QR code to download or copy — see [Sign-in](#sign-in). The row shows the passphrase, or "Not set" |
| **Wedding setup → Theme ›** | The display theme — see [Themes](#themes) |
| **Wedding setup → Locations ›** | The upload locations — see below |
| **Wedding setup → Time zone** | The zone admin stats use; saved from the first admin device, changeable |
| **Admin password** | Change it (needs the current one). Hidden, with a pointer to Cloudflare, while the `ADMIN_PASSWORD` secret is set |

Theme, Locations and Guest access each open their own screen; **Back** (or
Escape) returns to Settings.

### Upload locations

Guests pick one when they upload, and each becomes a gallery filter next to the
fixed **All photos** and **✨ Featured**. There can be **1 to 4**, each an
emoji and a name of up to 24 characters.

**They are locked once any photos exist.** Each photo stores its location name
as text and the filters match it exactly, so renaming or removing a location
would hide those photos from every filter. The editor greys out with a note,
and the server refuses changes too. To change them, switch to Pre-wedding mode,
then Select → Select all → Delete to clear test uploads.

The filters lay themselves out for any count — an odd one out spans the full
row in Classic.

### Select mode

Tap **Select**, tap photos, then from the bar at the bottom:

- **Rename** — change the uploader name on the selected photos (or merge into a
  name already in use), for a guest who typed their name differently on two
  devices
- **⬇ Download** — just the selected photos; see below
- **Delete N photos** — removes the originals, display sizes and likes
- **Select all** — Pre-wedding mode only, for clearing test uploads

The photo list refreshes before it is acted on — entering select mode,
applying a filter, and again immediately before a bulk delete — because guests
upload while the admin page is open. A failed refresh never blanks the grid,
and a bulk delete still completes without it (`test/admin-delete.test.mjs`).

### Other admin features

- Photo grid that loads 30 at a time as you scroll
- Location filter pills with counts; Featured pill; filter by uploader
- Star photos from the grid or lightbox — starred photos lead Featured with a
  "💍 Couple's pick" badge and get `-favorite` in download file names
- Delete a single photo from the lightbox
- Session-expired banner prompting a reload

---

## Downloading photos

Two ways, same output:

- **⋯ → Download all photos** — everything
- **Select → pick photos → ⬇ Download** — just those. Made for the photos that
  arrive *after* you've downloaded everything

Do it on a laptop: your browser fetches and zips the photos itself, and
hundreds of them on a phone is slow and can run out of memory.

### File names

`Location-Uploader-NNN.ext`, e.g. `Wedding-day-Tom---Jo-004.jpg`, with
`-favorite` added for starred photos. Numbers count per location and uploader,
in upload order.

**Numbering is always worked out across the whole gallery, even when you
download only a few.** So a late photo gets exactly the name a full download
would give it, and slots into your existing folder instead of restarting at
`001` and overwriting what you already saved. That holds as long as no earlier
photo has since been deleted or had its uploader renamed (either shifts the
numbers after it). A photo that fails to fetch keeps its number, so a retry
later gets the same name. Covered by `test/admin-download.test.mjs`.

### ZIP files

- Named from the couple's names in Settings: `alex-and-sam-photos.zip`, or
  `alex-and-sam-selected-photos.zip` for a selection
- Split at **200 MB per ZIP** using real file sizes:
  `…-photos-part-1-of-3.zip`, `part-2-of-3.zip`, …
- Each ZIP is fetched, built and downloaded before the next starts, so the
  browser never holds much more than one batch in memory
- Stored uncompressed — photos are already compressed, so deflating only costs time
- Each photo is retried 3 times before being skipped; 3 are fetched at once
- One download runs at a time; the progress window lists each ZIP and reports
  anything skipped, or selected photos deleted in the meantime

---

## Themes

A theme changes how every page looks — colours, fonts, shapes, decorative
artwork — and nothing else. Text, features and behaviour are the same in every
theme. Pick one in admin → Settings → Wedding setup → **Theme ›**; guests get it
on their next page load. Every theme follows the phone's light/dark setting.

Each choice shows a live thumbnail of the guest home page in that theme, with
your names, so you can compare before switching. The thumbnails are the real
page shrunk down, loaded with its scripts switched off and without the
passphrase, so they show the look and nothing else.

| Theme | Look |
|---|---|
| **Classic** (default) | Cream and soft purple, rounded cards, Cormorant Garamond for the names |
| **Red Rock** | Colorado: a Pikes Peak and sandstone-fin skyline over a strata band, Archivo + JetBrains Mono, square corners, ink buttons, a pinned "Add photos" bar |

How it works: Classic is each page's own stylesheet. A theme is one extra CSS
file, `public/themes/<id>.css`, which the Worker injects at `{{THEME_HEAD}}` —
after the page's styles — **only when that theme is active**. So Classic pages
are never affected by a theme, and a theme's rules override Classic by source
order without needing a theme prefix. The registry is `THEMES` in
`src/worker.js`. To build a new one, see
[THEMES.md](THEMES.md).

---

## Key things to remember

### Upload flow order
Name → location → select photos → upload. Guests commit to a location before
they open their camera roll, so photos are less likely to be tagged wrong.
Returning guests (name saved on the device) skip straight to location with a
"Welcome back" and a "Not you?" link. The name is only saved once an upload
completes.

### Likes and Featured
Guests like photos from the lightbox. The pill reads **♡ Like**, then
**3 ♥ Liked** once liked (filled, with a small pop) — the count lives inside the
pill so nothing shifts as likes come and go, and is left out at zero. On a
guest's own photo there is no button, just **Your photo · 4 likes**. Liking
needs a name (asked once if the guest hasn't uploaded yet), one like per photo
per device, never on your own photo. Double-tap in the lightbox is zoom, not like.

**Featured** shows the couple's starred photos first, then any photo with
enough likes (Settings → Featured), most liked first. `test/likes.test.mjs`.

### Leaderboard / rank display
After uploading, guests see their rank ("You're in 2nd place — just 3 photos
behind Aunt Beru"); first place gets confetti. Tapping **"Everyone's photos"**
on the gallery opens the full leaderboard, "The Memory Makers 📸" — intentionally
subtle. Being the only uploader is not the same as a first upload; see
`test/rank.test.mjs`.

### Photos only — no videos
JPEG, PNG, GIF, WebP and HEIC only, checked on the device and the server.
HEIC is converted to JPEG on the device before upload.

### Upload limits
3 uploads in parallel; per session at most **20 photos** and **95MB per file**
(Cloudflare's hard limit is 100MB per request); over 300MB total shows a WiFi
warning.

### Rate limiting
Via KV: `/auth` 10/min, `/admin/login`, `/admin/setup` and `/admin/password` 5/min combined, `/upload` 100/min per IP (high
enough for many guests sharing hotel WiFi).

### Display derivatives
Guests upload only the original. Display sizes are generated server-side by
**Cloudflare Images** and stored back in R2 under `derived/{id}/`:

| Variant | Longer edge | Format | Used for | Typical size |
|---|---|---|---|---|
| `grid` | 512px | AVIF q60 | Gallery tiles | 20–30 KB |
| `display` | 1600px | WebP q80 | Lightbox | 200–350 KB |

**Why generate once and store.** The Images free tier allows 5,000 *unique*
transformations per month, de-duplicated within a calendar month, so on-demand
transforms would re-bill every photo every month. Storing makes it one
transformation per photo per variant.

**How they get made.** Upload enqueues one Queues message per variant; the
consumer generates that one derivative. If a message never lands, `/v/`
generates it on first request instead.

**One message per variant, not per photo.** Two transforms in one invocation
exceeded the Worker CPU limit (`outcome: "exceededCpu"` in the logs) — which is
why `grid` always survived and `display`, running second, never did. Splitting
gives each its own budget. `generateVariant` returns `{ ok, retryable }` so the
consumer retries only transient failures; retries skip variants already built
and back off 30s, 60s, 120s. `[observability]` is what made this diagnosable —
keep it on. `test/derivatives.test.mjs`.

**Backfilling.** `GET /derivatives` audits what's missing; `POST /derivatives`
rebuilds up to 8 per call — re-POST until `missing_count` is zero.

**Fallbacks.** Inputs over 20MB, or HEIC (undecodable outside Enterprise),
serve the original instead of a broken tile.

### Photo repair (the scheduled sweep)
About 3% of transforms fail under burst load, occasionally through all retries.
`grid` heals quickly because every gallery load requests every tile; `display`
gaps can sit until a guest opens that photo and pays for the rebuild. A cron
every 15 minutes closes them instead.

It is **off by default**, toggled in Settings. **Switching to Live turns it on
automatically** (in the same D1 batch). Leaving Live doesn't turn it off —
turn it off yourself once photos stop arriving. `SWEEP_LIMIT` caps it at 6
transforms per run, so Images usage stays near zero once gaps are closed.

### Gallery freshness
The gallery refetches only when `/photo-count`'s fingerprint
(`count.max_id.favorites`) changes — checked when the app returns to the
foreground, and when a guest taps a filter or the sort order (10s throttle).
Never while the lightbox is open, and scroll position is preserved.
`test/gallery-filter.test.mjs`.

### Lightbox
Swipe or arrows to move, swipe down to close. Loads in three stages: the cached
grid tile instantly, the `display` size in the background, then the genuine
original after 2s on the same photo — the "Press and hold to save" tip only
appears once the original has loaded, so guests never save a downscaled copy.
Data-saver mode skips the automatic original and offers it as a tap instead.
Neighbouring photos are preloaded. `test/lightbox.test.mjs`.

### Auth cookies
Cookies hold an HMAC session token, never the passphrase or password, and are
`HttpOnly`, `Secure`, `SameSite=Lax`, **host-only** (no `Domain`), so they
belong to whatever domain the app is on.

- **Guest** (`auth`) — 1 year; re-issued on every visit.
- **Admin** (`admin_auth`) — 30 days.

Don't change the token derivation (`generateSessionToken` /
`generateAdminToken`) — it would sign everyone out at the next deploy.
`test/session-cookie.test.mjs` pins it.

### Privacy section
"Your privacy ↓" on the home page expands a short, generic notice: a private,
password-protected site for the couple's wedding; uploads are visible to the
couple and other guests and never made public or sold; photos are deleted after
the couple have saved them; ask the couple to remove a photo.

### Stats time zone
Admin stats are shown in the zone saved in Settings → Wedding setup → Time
zone (`stats_timezone`), injected into the admin page as `data-stats-tz`. On a
new site it is empty, and the first admin visit saves that device's zone, so
the wedding-day hours don't shift when the couple look from somewhere else.
`test/stats-timezone.test.mjs`.

---

## Security

- **Password page** — the passphrase is checked server-side; the password page
  never contains it. The signed-in guest page and the admin page do include it
  (for the invite link), which is fine: anyone who can see them already has it.
- **Invite link** — `?p=` is checked server-side (ignoring case and spaces)
  and the Worker sets the cookie; an empty or missing passphrase never signs
  anyone in, and with no admin password set no admin token can verify
- **Admin** — separate HMAC-signed cookie; the password is only sent in a form
  post, never in a URL, history or log. See [Sign-in](#sign-in) for how it is
  stored
- **Same-origin only** — the pages and API are served by one Worker on one
  origin; no `Access-Control-Allow-Origin` is sent, so other sites can't call the API
- **Uploads** require a guest session; non-images are rejected with 415
- **Rate limiting** on sign-in, admin sign-in and upload
- **R2 is private** — every photo goes through the Worker's auth check; keys
  must start with `photos/` and contain no `..`
- **Edge cache** — the auth check runs before the cache lookup, so an
  unauthenticated request never reaches a cached photo
- **Settings** — every value is validated server-side; names and location
  labels are always inserted as text, never markup, and JSON injected into pages
  escapes `<` so a label can't break out of its script tag
- **robots.txt** blocks all crawlers, including AI crawlers by name
- **Security headers** on every response: `X-Frame-Options: DENY`, HSTS with
  preload, a Content-Security-Policy (inline scripts, Google Fonts and
  Cloudflare Analytics only; images from the site, `data:` and `blob:`),
  `nosniff`, a strict referrer policy, and a Permissions-Policy

---

## Site mode

Admin → ⋯ → Settings → **Site mode**:

| Mode | Guests see | Admin |
|---|---|---|
| **Live** | The normal site | Normal; also switches photo repair on |
| **Pre-wedding** | A "Back soon" page | Full access, plus Select all |
| **Post-wedding** | New visitors get a "photos are now private" page; guests already signed in keep access | Full access |

Saves immediately; the current mode shows under Settings in the ⋯ menu.

### Emergency hard override

A Cloudflare variable `MAINTENANCE_MODE=true` blocks everything, admin included.
Use it only if the site must come down before you can sign in to admin:
dashboard → **Workers & Pages** → your Worker → **Settings** →
**Variables and Secrets** → add Text variable `MAINTENANCE_MODE` = `true`.
Delete it to remove the override. No redeploy needed.

---

## Tests

`npm test` runs every `test/*.test.mjs` file (`test/run-all.mjs`). Each one extracts the real functions from
`src/worker.js` or the HTML pages and drives them against stubs, so they test
the shipped code without a browser or Cloudflare.

| Test | Guards |
|---|---|
| `lightbox` | Full-quality loading and the save tip; swipe vs. button taps |
| `derivatives` | Queue ack/retry decisions |
| `admin-delete` | Refresh-before-delete; arrivals during selection |
| `admin-select-all` | Select all only in pre mode |
| `admin-rename` | Renaming and merging uploaders |
| `admin-download` | Whole-gallery file naming, selected downloads, ZIP names |
| `rank` | Leaderboard and first-upload messages |
| `gallery-filter` | Filter taps stay instant and throttled |
| `tile-loading` | The loading shimmer clears on every path a tile can finish on |
| `site-mode` | Going live turns photo repair on |
| `session-cookie` | Cookie scope and token derivation |
| `last-upload` | The leaderboard's "latest photo" time |
| `likes` | Like rules, Featured ordering, the like pill's labels |
| `couple-names` | Name validation and HTML escaping |
| `locations` | 1–4 locations, the lock, escaping |
| `themes` | Theme registry and injection; Classic injects nothing; previews are admin-only, never carry the passphrase, and only they can be framed |
| `guest-access` | Passphrase only from Settings; unset means no sign-in; validation; no hardcoded domain |
| `invite-qr` | QR print size, quiet zone, black on white, longest link fits |
| `schema` | A new database creates itself; set-up costs nothing once done; outages aren't mistaken for an empty database; upgrades run in order |
| `admin-setup` | First-visit admin password: claimed once, never while one exists, races, hashing, the Cloudflare secret wins, changing needs the current one |
| `stats-timezone` | Time zone validation and storage; nothing hardcoded |

---

## Stack

| Layer | Technology |
|---|---|
| Hosting & compute | Cloudflare Workers |
| Storage | Cloudflare R2 |
| Database & settings | Cloudflare D1 (SQLite) |
| Image processing | Cloudflare Images + Queues |
| ZIP library | fflate 0.8.2 (inline in admin.html) |
| QR codes | qrcode-generator 2.0.4, MIT (inline in admin.html) |
| Fonts | Cormorant Garamond (Classic); Archivo + JetBrains Mono (Red Rock) — Google Fonts |
| Deployment | Wrangler (`npm run setup`) or the Deploy to Cloudflare button |

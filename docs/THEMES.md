# Building a theme

Written for a developer, or an AI coding assistant such as Claude Code, asked to add a theme.
`public/themes/redrock.css` is the reference implementation — read it first.

## Ground rules

1. **Look only.** Never change text, features or behaviour. A theme is CSS and
   nothing else — no JavaScript, no new routes.
2. **Classic must not change.** Theme CSS is only injected when its theme is
   active, so a theme file can't affect Classic. If a theme truly needs new
   markup (a decorative element, a wrapper), add it to the page hidden by
   default, check that Classic renders **pixel-identically** before and after
   (see [Verifying](#verifying)), and list it under
   [Hooks](#hooks-the-pages-provide) below.
3. **Light and dark.** Every theme follows `prefers-color-scheme`. Define both.
4. **Readable.** Text at least 4.5:1 contrast against its background — check
   white-on-accent buttons in particular, and the lightbox (always on black).
5. **Within the CSP.** Fonts from Google Fonts only (`fonts.googleapis.com` /
   `fonts.gstatic.com`). Images only as inline `data:` URIs (SVG works well and
   stays small) — remote image URLs are blocked. The CSS must not contain the
   text `</style`.
6. **Phones first.** Guests are on phones; check at 390px wide.

## Steps

**1. Get the design.** A mockup, a palette, or a description from the user.
Pin down: background, text (3 levels), borders, the primary button colour and
its text colour, an accent for links/badges/progress, a danger colour, fonts,
corner radius, and any artwork — for both light and dark.

**2. Create `public/themes/<id>.css`.** `<id>` is lowercase letters and
digits, e.g. `garden`. Structure it like `redrock.css`:

```css
/* <Name> — one-line description. Injected after each page's own styles only
   when active; scoped per page with html[data-page]. Look only. */

:root {
  /* Your own palette, prefixed to avoid clashes */
  --gd-bg: #...;  --gd-text: #...;  --gd-accent: #...;

  /* Then map the shared tokens every page is written against (table below) */
  --bg-primary: var(--gd-bg);
  --text-primary: var(--gd-text);
  --accent-btn: var(--gd-accent);
  --on-accent: #ffffff;
  /* ... */
}

@media (prefers-color-scheme: dark) {
  :root { /* dark values for the same variables */ }
}

body { font-family: 'Your Font', -apple-system, sans-serif; }

/* Per-page rules */
[data-page="guest"] .header h1 { /* ... */ }
[data-page="admin"] .stat { /* ... */ }
```

Mapping the shared tokens alone recolours the whole site. Component rules on
top of that change shape and layout.

**3. Register it in `src/worker.js`.** Import the file next to `REDROCK_CSS`
and add an entry to `THEMES`:

```js
import GARDEN_CSS from '../public/themes/garden.css';

const THEMES = {
  classic: { ... },
  redrock: { ... },
  garden: {
    name: 'Garden',                                   // shown in Settings
    description: 'Sage and blush, botanical borders',  // one line, shown under it
    head:
      // Fonts, if any — only from Google Fonts
      '<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>' +
      '<link href="https://fonts.googleapis.com/css2?family=...&display=swap" rel="stylesheet">' +
      `<style>${GARDEN_CSS}</style>`,
  },
};
```

That's all the wiring there is: `wrangler.toml` already imports `.css` as text,
the Settings → Theme screen lists every registered theme automatically, with its
thumbnail, and `POST /theme` accepts any registered id. The thumbnail is the
guest home page with no script running, so anything the theme styles there
should look right without JavaScript.

**4. Verify** (below), **run `npm test`**, then deploy and choose it in
Settings → Theme.

## Shared tokens

Map these in `:root`. Not every page uses every token; defining extras is harmless.

| Token | Used for |
|---|---|
| `--bg-primary`, `--bg-secondary` | Page backgrounds |
| `--bg-card`, `--bg-input`, `--bg-subtle` | Cards, inputs, quiet panels (settings rows, privacy text) |
| `--text-primary`, `--text-secondary`, `--text-tertiary` | Text, three levels |
| `--border`, `--border-strong` | Hairlines; input borders |
| `--accent-btn`, `--on-accent` | Primary buttons and their text; selected checkmarks |
| `--accent-bg`, `--accent-border`, `--accent-text` | Active pills, selected locations, secondary buttons |
| `--accent-strong` | Icons on `--accent-bg`, radio buttons, the session banner |
| `--accent-btn-hover`, `--accent-ring` | Admin sign-in button hover and focus ring |
| `--red-bg`, `--red-border`, `--red-text`, `--red-btn` | Errors, delete buttons |
| `--danger`, `--error`, `--error-bg` | Admin sign-in and password-page errors |
| `--amber-bg`, `--amber-border`, `--amber-text`, `--amber-warn` | Upload warnings; the WiFi note |
| `--green-bg`, `--success-icon`, `--success-check` | Upload-complete icon; download log ticks |
| `--skeleton-base`, `--skeleton-sheen` | Loading photo tiles |
| `--like-fill`, `--on-like` | The liked pill in the lightbox (always on black) |
| `--confetti-colors` | Comma-separated colours for first-place confetti |

## Hooks the pages provide

| Hook | Where | Use |
|---|---|---|
| `html[data-theme="<id>"]` | Every page | The active theme |
| `html[data-page="guest" \| "admin" \| "gate" \| "admin-gate"]` | Every page | Scope rules to one page |
| `.theme-scene` | Hidden by default | Decorative artwork. `.theme-scene-hero` tops the guest home card and the password page; `.theme-scene-slim` tops the gallery and admin. Give it `display: block`, a height and a background (`redrock.css` draws its skyline as one SVG data URI) |
| `.couple-first`, `.couple-rest` | Guest and password-page headings | The names as two spans ("Alex", "& Sam"); `display: block` on `.couple-rest` stacks them |
| `.upload-cta`, `.upload-note`, `.upload-note-warn` | Guest home | The "Add your photos" block vs. the two notes under it |
| `.settings-*` classes | Admin Settings | Every Settings element has a class — no inline styles to fight |
| `.like-row`, `.like-btn`, `.like-count`, `.own-photo-note` | Lightbox | The like pill |

## Watch-outs

- **Specificity.** Theme rules win over page rules of *equal* specificity
  because they come later. A page rule with more specificity still wins — e.g.
  the filter row's `.filter-row > :last-child:nth-child(odd)`. `redrock.css`
  doubles the class (`.filter-row.filter-row`) to outrank it. Prefer that to
  `!important`; inline `style=""` attributes in the pages need `!important`.
- **Filter layout** must work for 1–4 locations after the two fixed pills; test
  every count (the editor is in Settings → Locations, unlocked when there are
  no photos).
- **Bulk bar and rename dialog** share button classes — scope bulk-bar styles
  with `.bulk-bar` or you'll restyle the dialog's buttons too.
- **The lightbox** is always on black regardless of light/dark.
- **Selecting a theme reloads the admin page**; guests see it on their next load.

## Verifying

Run locally against seeded data:

```bash
npx wrangler dev --port 8787 --var ADMIN_PASSWORD:devadmin
```

Sign in at `http://localhost:8787/admin`, set a guest passphrase in Settings →
Guest access (say `devguest`), upload a few test photos through the guest page
(`http://localhost:8787/?p=devguest`), and choose the theme in Settings → Theme
(or `POST /theme` with `{"theme":"<id>"}`).

Then screenshot **every screen at 390px wide, in light and dark**, and compare
against the mockup:

- Guest: password page, home, privacy open, name, locations (one selected),
  uploading, upload complete, gallery, leaderboard, lightbox (Like, Liked, Your
  photo), the name prompt for liking
- Admin: sign-in, main grid, ⋯ menu, Settings (scrolled to the bottom), Guest
  access, Theme, Locations, Stats, Select mode in Live and Pre-wedding, the
  lightbox, the rename dialog, the download progress window
- Filters with 1, 2, 3 and 4 locations

Headless Chrome or Brave driven over the DevTools protocol works well for this
(set the viewport with `Emulation.setDeviceMetricsOverride` and dark mode with
`Emulation.setEmulatedMedia`). If you changed any page markup, take the same
screenshots in Classic **before and after** and diff them pixel by pixel —
Classic must be unchanged.

## A prompt to start with

> Read docs/THEMES.md and `public/themes/redrock.css`. Build
> a new theme called "<Name>" from <the mockup / this palette and fonts>: create
> `public/themes/<id>.css`, register it in `THEMES` in `src/worker.js`, verify
> every screen in light and dark at phone width, run `npm test`, and show me
> screenshots before committing. Don't change any text, features or the Classic
> theme.

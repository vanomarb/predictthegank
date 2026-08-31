# HR visit tracker — server

Invite-only tool for a team to log and predict when HR roams by their stations.
Node/Express + SQLite backend, plain JS frontend, no public sign-up.

## What's in here

- `server.js` — Express app, security middleware, mounts routes
- `db.js` — SQLite schema (accounts, invites, sightings, sighting_logs)
- `routes/auth.js` — register (invite-gated), login, logout, invite generation (admin)
- `routes/sightings.js` — log a sighting (with server-side dedup), list, stats
- `middleware/auth.js` — JWT cookie auth
- `public/` — the frontend (plain HTML/JS, no build step)
- `public/timer3d.js` — the 3D countdown clock (Three.js, loaded from a CDN via importmap)
- `public/icons.js` — Phosphor icons, inlined as SVG paths (no icon font, no emoji)
- `public/shared.css` — the design tokens, and nothing else (no class selectors)
- `public/tailwind-config.js` — the Tailwind source: tokens as utilities, all keyframes
- `services/work-hours.js` — the one definition of when sightings can be logged
- `scripts/generate-confetti-lottie.js` — regenerates `public/confetti.lottie.json`,
  the burst that plays on a logged sighting and on a prediction hit
  (`npm run build:confetti`); edit the generator, not the JSON
- `scripts/generate-miss-lottie.js` — regenerates `public/miss.lottie.json`, the
  swing-and-a-miss animation for a wrong prediction (`npm run build:miss`)
- `scripts/generate-fire-lottie.js` — regenerates `public/fire.lottie.json`, the
  flames around every toast (`npm run build:fire`)
- `scripts/generate-logo.js` — rebuilds `public/logo.png` and `public/favicon.png`
  from `public/icon.jpg` (`npm run build:logo`). The source is a 260KB white-backed
  JPEG; this trims it to the artwork, resamples, and takes alpha from how dark
  each pixel is, so the mark has a transparent background and `dark:invert` turns
  it clean white on the dark theme. Replace `icon.jpg` and re-run to change the logo
- `scripts/generate-timer-typeface.js` — regenerates `public/timer-typeface.json`,
  the 12-glyph Poppins subset the 3D countdown extrudes (`npm run build:typeface`).
  Needs the `opentype.js` devDependency and network access; the output is
  committed, so a plain deploy never runs it.
- `scripts/init-admin.js` — one-time bootstrap to get your first invite code

## Local setup

```bash
npm install
cp .env.example .env
# edit .env: set JWT_SECRET to a long random string
#   node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"

node scripts/init-admin.js
# prints an invite code — the first account registered with it becomes admin

node server.js
# visit http://localhost:3000, register with that invite code
```

Once you're an admin, use the "Generate invite code" button in the app to
invite each coworker. Each code is single-use.

## Deploying to Vercel

`vercel.json` and `api/index.js` are all the configuration needed. Two details
in them are deliberate and worth knowing before you change either:

- **Everything routes to the function.** `routes` sends every path to
  `api/index.js`, which is the same Express app `node server.js` runs. Vercel
  would otherwise serve `public/` itself, and `index.html`/`admin.html` cannot be
  served statically: each carries an inline `<script type="importmap">` that the
  CSP only allows with a per-request nonce the server stamps in.
- **The cron runs once a day, at the end of the working day**, and recomputes the
  Gemini prediction (see below).

Set the environment variables from `.env.example` in the Vercel project
settings. `CRON_SECRET` is required for the cron job to run at all.

Three settings in `vercel.json` exist to stop Vercel doing things this app does
not want, and removing any of them breaks production while local stays fine:

- `"framework": null` and a no-op `buildCommand`. `public/` ships exactly as
  authored. With a framework preset detected, a build step can transpile
  `public/*.js` — and since `package.json` is `"type": "commonjs"`, an ES module
  like `timer3d.js` comes out the other side as CommonJS, so the browser hits
  `require is not defined` on its first `import`.
- `includeFiles`. `server.js` reads `public/*.html` off disk to stamp in the CSP
  nonce, and reads `vercel.json` to check the cron schedule. Vercel traces
  `require()`, not `fs.readFileSync(path.join(...))`, so those files have to be
  named or they are missing from the function bundle.
- The route order. `/`, `/admin` and `/api/*` reach Express **before**
  `handle: filesystem`; everything else is served straight from `public/` by the
  CDN. Serving the two HTML documents statically would skip the nonce and break
  the importmap the 3D countdown needs.

### How many phases a day gets

The number of roam phases is decided by the data, not fixed. An hour becomes a
phase when it holds at least 10% of all sightings **and** at least 40% of the
busiest hour's count; the busiest hour is always kept, and a ceiling of six
stops the list turning into a log. So one busy hour gives one phase, four
genuine clusters give four, and a strong peak with a scattered tail gives one
rather than dressing two-sighting hours up as predictions.

The ceiling (`PHASE_CEILING` in `routes/sightings.js`) is passed into
`computePhases` as a parameter rather than read from the constant. That is
deliberate: **if this ever becomes a product with accounts rather than one
team's toy, this is the natural thing to meter** — a free tier capped at three
phases, paid tiers up to the full ceiling — and threading a per-plan value
through the caller needs no change to the statistics. Nothing is gated today.

### The daily prediction refresh

The Gemini-refined prediction is recomputed by one scheduled call to
`/api/cron/refresh-prediction`, not by anything on a request path. Logging a
sighting used to trigger it, which meant one Gemini call per log to re-answer a
question whose answer barely moves — and a prediction that could change under a
reader mid-afternoon. Once a day, after the last window has closed, gives one
call on complete data and a prediction that holds still while people read it.

The schedule in `vercel.json` is **UTC**, and Vercel Hobby projects get one run
per day. `0 10 * * *` is 6pm in `Asia/Manila`; set it to whatever
`WORK_HOURS_END` is in your `TIMEZONE`. Get it wrong and the server says so at
boot rather than leaving you to notice the prediction refreshing at lunchtime.
Weekends are skipped inside the route, not in the schedule, so the work days stay
configured in one place (`WORK_DAYS`).

To run it by hand:

```bash
curl -H "Authorization: Bearer $CRON_SECRET" \
  https://your-app.vercel.app/api/cron/refresh-prediction
```

Until the first run, the app serves its built-in statistical prediction — the
Gemini one is a refinement on top, never a dependency.

## Deploying to your own VPS

Assumes Ubuntu/Debian. Adjust package manager commands if different.

### 1. Get Node onto the server

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
```

### 2. Copy the project over and install

```bash
# from your local machine
scp -r hrtracker-server you@your-server:/home/you/hrtracker-server

# on the server
cd /home/you/hrtracker-server
npm install --omit=dev
cp .env.example .env
nano .env   # set JWT_SECRET (long random string), NODE_ENV=production
node scripts/init-admin.js   # note the invite code, keep it safe
```

### 3. Run it as a systemd service (keeps it alive, restarts on crash/reboot)

Create `/etc/systemd/system/hrtracker.service`:

```ini
[Unit]
Description=HR tracker
After=network.target

[Service]
Type=simple
User=you
WorkingDirectory=/home/you/hrtracker-server
ExecStart=/usr/bin/node server.js
Restart=on-failure
EnvironmentFile=/home/you/hrtracker-server/.env

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now hrtracker
sudo systemctl status hrtracker
```

### 4. Put nginx in front of it (reverse proxy + HTTPS)

```bash
sudo apt-get install -y nginx certbot python3-certbot-nginx
```

`/etc/nginx/sites-available/hrtracker`:

```nginx
server {
    listen 80;
    server_name your-domain-or-subdomain.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/hrtracker /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d your-domain-or-subdomain.com
```

Certbot handles the HTTPS cert and nginx config for you, and sets up
auto-renewal. `server.js` already has `app.set('trust proxy', 1)` and
`secure: NODE_ENV === 'production'` on the session cookie, so cookies will
only be sent over HTTPS once this is live.

### 5. Firewall

Only expose 80/443 (nginx) and SSH — the app itself listens on 127.0.0.1:3000
only, not on the public interface, so there's nothing extra to lock down
there.

```bash
sudo ufw allow OpenSSH
sudo ufw allow 'Nginx Full'
sudo ufw enable
```

### 6. Backups

### The daily prediction refresh

Outside Vercel there is no scheduler, so add the same daily call to the server's
own crontab — at the end of the working day, on the server's clock:

```cron
0 18 * * 1-5 curl -sf -H "Authorization: Bearer $CRON_SECRET" http://localhost:3000/api/cron/refresh-prediction
```

The route skips non-work days on its own, so the `1-5` above is belt and braces.

The whole dataset is one file: `data/hr_tracker.db`. A simple cron job
copying it somewhere (or `sqlite3 data/hr_tracker.db ".backup backup.db"` on
a schedule) is enough for a team-sized tool like this.

## Inviting your team

You (the admin) generate a code per person from the in-app admin panel or
`POST /api/auth/invites`. Send each person their own code out of band
(Slack DM, etc.) — each code works once, so it can't be shared onward beyond
the person you gave it to.

## Styling: Tailwind only

There is not a single custom class selector left in this app. `shared.css` is
design tokens and nothing else (4.5KB, down from 20KB); every visual decision is
a Tailwind utility. Notes worth knowing before touching it:

- **Tailwind v4 via `@tailwindcss/browser` on jsdelivr**, not
  `cdn.tailwindcss.com` — that host still serves v3, the v4 browser build is
  about half the size (71KB vs 123KB gzipped), and jsdelivr was already allowed
  by `script-src` for Three.js. It did need one CSP addition after the fact:
  jsdelivr under `connect-src`, because the bundle's `//# sourceMappingURL`
  points back at the CDN and a browser with devtools open fetches it. See the
  comment in `server.js` — the host is already trusted to execute script, so
  letting it answer a fetch grants strictly less.
- **`tailwind-config.js` holds the Tailwind source** and injects it as
  `<style type="text/tailwindcss">`. It is a .js file because the browser build
  only reads that element — it ignores `<link>` — so the alternative was
  duplicating the whole block in both HTML files. It must load *before* the
  browser build; both pages do that in `<head>`.
- **Preflight is on**, so every element carries its own utilities. There is no
  base stylesheet to fall back on.
- **Colour utilities are theme-aware for free.** `@theme` maps tokens by
  reference (`--color-ink-900: var(--ink-900)`), so `bg-ink-900` compiles to
  `background-color: var(--ink-900)` and follows the light/dark switch with no
  `dark:` variant. Names sidestep Tailwind's `--font-*` / `--radius-*` /
  `--text-*` namespaces, which collide with existing token names — text colours
  are `--color-fg*`, and radii use Tailwind's own scale.
- **Opacity modifiers do NOT work on the bridged colours.** `bg-amber-500/8`
  silently compiles to a fully opaque `var(--color-amber-500)`, because Tailwind
  cannot `color-mix` a value it can't resolve at build time. Translucent fills use
  explicit `bg-[rgba(...)]` instead — check the compiled output if you add one.
- **UI state is data attributes, not extra classes** — `data-active` (tabs,
  panels, auth panes), `data-closed` (log buttons out of hours), `data-featured` /
  `data-passed` / `data-wildcard` (tier chips), `data-visible` (the tooltip). The
  attribute selector Tailwind generates outranks the base utilities, whereas a
  second competing utility on the same element would be resolved by compiled
  source order, which is arbitrary. Chip children react via `group-data-*`.
- **Markup built in JS carries utility strings from named constants** (`CHIP`,
  `TOAST`, `ENTRY`, `PILL`, `HG_CELL`, …) at the top of `viz.js`, `public.js` and
  `admin.js`. The browser build watches `[class]` with a MutationObserver, so
  those compile the first time they appear in the DOM.
- Every keyframe lives in `tailwind-config.js` as an `--animate-*` theme entry.
  Note `scale-0` sets the `scale` property while a keyframe animating `transform`
  would fight it — that is why the ripple keyframe declares its own `from`.
- **Costs, honestly:** ~71KB gzipped of JavaScript compiling CSS at runtime, so
  there is a brief unstyled flash on load (tokens are real CSS and paint
  immediately, so it is layout rather than colour), and a JS-injected component
  styles in on the next compile tick the first time it appears. For production
  Tailwind's own advice is the CLI or a bundler; the markup would not change.
- Editors flag `@theme` and `@custom-variant` as unknown at-rules. Install the
  Tailwind CSS VS Code extension or set `"css.lint.unknownAtRules": "ignore"`.

## Verifying a style change

`@tailwindcss/browser` silently ignores a class it does not recognise, so a typo
is invisible until someone looks at the page. There is a checker for that: it
compiles `tailwind-config.js` with the real Tailwind CLI and reports any class
used anywhere in `public/` that produces no CSS. Worth running after any markup
change.

## Animation credits

Three animations are third-party, from LottieFiles under the
[Lottie Simple License](https://lottiefiles.com/page/license):

| File | Animation | Author |
| --- | --- | --- |
| `public/hit-target.lottie.json` | [Target](https://lottiefiles.com/free-animation/target-f3qmaV0uV0) | Spencer Lalonde |
| `public/miss-shot.lottie.json` | [Hit Missed](https://lottiefiles.com/free-animation/hit-missed-sqnRV0tYi6) | Birju Raikwar |
| `public/fire.lottie.json` | [Fire](https://lottiefiles.com/free-animation/fire-NG4n3YU51z) | LottieFiles Mobile |

They are committed rather than hot-linked so the app serves them from its own
origin — no extra CSP allowance, and nothing breaks if the CDN does.

The rest are generated by the scripts in `scripts/` (`confetti-page`, `dud-page`,
`confetti` and the countdown typeface); `check.lottie.json` and
`cross.lottie.json` are the generated marks the LottieFiles pair replaced, kept
because `npm run build:marks` still produces them and they work as a fallback.

## Alerts

Two kinds, both opt-in behind the bell in the header:

- **Countdown warnings** at 1 minute and 30 seconds before a predicted window
  opens. Fired once per threshold per window — the 5s data poll re-rendering the
  same window does not re-alert, and a page opened with 12 seconds left gets the
  30s alert only, not the minute one it already missed.
- **The verdict**, when a window closes: a hit if a sighting was logged *for it*,
  a miss if none was. Which sightings count is defined by the window's range plus
  a **30-second grace on both sides** (`WINDOW_GRACE_S`):

  - `sure` / `likely` / `maybe` predict an hour range, so anything logged from
    30s before it opens until 30s after it closes counts. Spotting HR at 09:59:40
    for a 10:00 window — or at 11:00:20 as it wanders off — has confirmed the
    prediction, and the page has just alerted the viewer that it was seconds away.
  - `wildcard` is the exception: it predicts a *minute* ("maybe around 5:42pm"),
    so its range is that exact instant ±30s. Giving it the whole hour would make
    the loosest prediction in the app the easiest one to satisfy.

  Worked example, for a 22:00-23:00 range: a sighting at 21:59 does **not** count
  (a full minute early, outside the 30s grace); one at 22:01 does, being inside
  the range; one at 23:00:20 does, inside the trailing grace; one at 23:00:45 does
  not. The first second that counts is 21:59:30.

  Strictness applies to the VERDICT, never to whether the button works: a
  sighting logged outside every window is still posted, still recorded in the
  heatmap, and still confirmed to the user with a toast. It simply earns no
  prediction credit. (Whether the button is enabled at all is a separate
  question, answered only by work hours — a 22:00 window is unloggable under the
  default Mon-Fri 9-18.)

  Anything logged outside that span belongs to no window and reads as a miss. The
  verdict is held back until the trailing grace has elapsed, and counts only
  sightings a poll actually observed while the window was in play — so a sighting
  logged well after it closed cannot be credited to it. The consequence worth
  knowing: if the tab is hidden for the whole window (the poller pauses with the
  Page Visibility API), no poll sees those sightings and the verdict can read as a
  miss. The public tracker shows it as a modal with a
  Lottie (confetti for a hit, `miss.lottie.json` for a miss, each falling back to
  a static Phosphor icon if lottie-web is unavailable). The admin console gets a
  toast and a notification instead — it already has a toast rail, and a modal over
  a working dashboard is an interruption rather than a flourish.

Two non-obvious things about the toast, both of which caused visible bugs:

- The entrance animation is on a **wrapper**, not the bubble. Animating opacity
  or transform makes an element a stacking context, and inside one a negative-z
  child paints above its parent's background rather than behind it — animating the
  bubble directly put the flames over the bubble's face for the 250ms the
  animation ran.
- The toast's classes are **pre-warmed** at startup by a hidden element in
  `viz.js`. Tailwind's browser build compiles a class only after seeing it in the
  DOM, and every toast class first appears when the first toast is built — so for
  ~400ms that toast had no background, no padding and no `-z-10`, and what you saw
  was fire with no toast under it.

Toasts are shared between both pages (`Tracker.toast`), anchored top-centre, and
each one carries `fire.lottie.json` around its edges — flames placed on the
perimeter of a toast-shaped composition and stretched to the bubble with
`preserveAspectRatio: 'none'`, since a toast is only as wide as its text. The
animation is destroyed when the toast is removed: lottie keeps its own
requestAnimationFrame loop, so dropping the node would leak one per toast.

Each one goes out as a desktop notification as well as an in-page toast, because
the entire point of a warning is to reach someone who is *not* looking at the
page. Notifications are tagged, so the 30s alert replaces the 1-minute one
rather than stacking.

Permission is requested on the first bell click, never on load: browsers require
a user gesture for `Notification.requestPermission()`, and asking unprompted is
both rude and usually auto-denied. The on/off choice is remembered in
localStorage, and the bell disables itself if the browser has blocked
notifications for the site.

## Previewing an outcome

The hit/miss modals only appear when a real window opens and closes, which makes
them awkward to look at. Two URL flags on the public tracker show them on demand:

```
/?preview=hit     the hit modal, confetti lottie and all
/?preview=miss    the miss modal
/?preview=toast   a toast, so the fire can be seen
```

These call the same `show()` the watcher does — nothing in the prediction path is
faked or bypassed, which is why they are URL flags rather than server settings.
`COUNTDOWN_OVERRIDE_MS` deliberately does NOT trigger them: it only replaces the
countdown number, and the verdict comes from a window actually going active and
then passing (see `createPredictionWatcher` in `viz.js`).

## Checking the countdown without waiting

The interesting states only happen in the last minute of a window — the red
urgent pulse at 60s, the 1-minute and 30-second alerts. `COUNTDOWN_OVERRIDE_MS`
forces the countdown to start at a given number of milliseconds and tick down
from there, so you can see all of it on demand:

```bash
COUNTDOWN_OVERRIDE_MS=65000 npm start   # a 1:05 countdown, crossing both thresholds
```

It applies to both pages, stops at zero (reload to run it again), and takes
precedence over "HAPPENING NOW" — the point is to watch the countdown, and a
live window would hide the thing under test. While it is set, the server logs a
warning at boot and both pages show a dashed "overridden for testing" badge under
the countdown, because a page quietly displaying a fabricated countdown is worse
than no test tool at all. A non-positive or non-numeric value is ignored with a
warning.

It does not fake the hit/miss verdict: that needs a genuinely active window and a
real logged sighting, so it still follows the data.

## Work hours

Both "log a sighting" buttons — the public tracker's and the admin console's —
are only clickable during the office's working day, which is defined once in
`services/work-hours.js`, configured with `WORK_HOURS_START` / `WORK_HOURS_END` /
`WORK_DAYS` (see `.env.example`), and shipped to the browser on `/api/config`.
Defaults to Mon–Fri, 09:00–18:00. It is evaluated on the `TIMEZONE` clock, not
the viewer's, so someone travelling still sees the office's hours; and it is
re-checked every second, so a tab left open overnight closes its own button.

Note this is a UI gate plus a client-side guard on the click handler — the API
itself still accepts a sighting at any hour. If you want it enforced for real,
that belongs in `routes/sightings.js`.

## Notes on the security model

- Passwords are hashed with bcrypt (12 rounds), never stored in plaintext.
- Sessions are JWTs in httpOnly, sameSite cookies — not readable by page JS,
  not sent cross-site.
- Login/register are rate-limited (20 attempts / 15 min / IP) to slow down
  guessing.
- This is appropriately secure for an internal team tool. It has not had a
  professional security audit — don't put anything more sensitive than "who
  logged what sighting" into it.

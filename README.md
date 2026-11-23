# Cosplay Contest Judge

An offline-first scoring app for cosplay contests. It runs in any browser, installs on tablets as an app, and keeps working when the Wi-Fi drops. Every device saves its work locally and syncs with a central server whenever it can reach it.

No dependencies. You need **Node.js 18 or newer** and nothing else.

## Quick start

```bash
node server/server.js
```

On first run it creates `data/db.json` and prints a one-time **admin password**. Open `http://localhost:8080`, sign in as `admin`, and change that password (click your name, top right).

Then in **Setup**:
1. Set the event name, the stage time per contestant and when the warning starts.
2. Adjust the divisions and judging criteria. The defaults are Craftsmanship, Accuracy, Stage Presence and Overall Impact, each scored 0–10.
3. Create accounts for your judges and coordinators.
4. Import your contestant list (CSV or paste from a spreadsheet), or let coordinators add walk-ins at check-in.

## Who sees what

| Screen | Admin | Coordinator | Judge |
|---|:-:|:-:|:-:|
| Check-in (search, check in, walk-ins, no-shows) | ✓ | ✓ | |
| Stage control (running order, timer, next contestant) | ✓ | ✓ | |
| Confidence monitor | ✓ | ✓ | |
| Scoring (own sheets only, checked-in contestants only) | | | ✓ |
| Results dashboard, lock scoring, CSV export, print | ✓ | | |
| Score review and adjustment (reason required, audited) | ✓ | | |
| Setup: event, criteria, accounts, import, backup | ✓ | | |
| Audit log | ✓ | | |

These rules are enforced **on the server**, not just hidden in the UI. Judges never receive other judges' scores, the private staff notes, contact details, or contestants who haven't checked in. Coordinators never receive any scores.

The **confidence monitor** (`/#/monitor`) needs no sign-in, so you can put it on a screen facing the stage. It shows the contestant, a large countdown, and who's up next. It turns amber at the warning time and flashes red with an overtime count once time runs out. Double-click it, or use the hover button, to go full screen.

## How offline works

- Every action is saved on the device first (IndexedDB) and goes into an outbox. The sync dot in the top bar shows **Online**, **Offline · N unsynced**, or **Sign in to sync**.
- When the server is reachable, the device sends its outbox and pulls anything newer. Devices are nudged instantly through a live event stream, and also check every 15 seconds.
- A person who has signed in online once on a device can sign in there again with no connection.
- **Conflicts:** each judge owns their own score sheets, so judges never collide with each other. If an admin adjusts a sheet while that judge is offline and the judge then edits it too, the admin's version wins and the judge sees a notice. Check-ins and stage changes simply take the most recent change.
- Stage control and a monitor on the **same device** (for example a laptop with the monitor on an HDMI screen) keep working with no network at all. A monitor on a **different** device needs the server to receive updates. If the connection drops it keeps counting down from what it last received.

### HTTPS matters for tablets

Browsers only allow offline app caching and installing to the home screen on **https://** (or `localhost`). Over plain `http://192.168.x.x`, the app still works and an open tab still survives Wi-Fi drops. But reloading the page while offline won't work, and neither will offline sign-in. So for real use, put the server behind HTTPS:

- **Easiest:** deploy to a host that gives you HTTPS automatically (Render, Railway, Fly.io, a VPS with Caddy). Start command: `node server/server.js`. Set `DATA_FILE` to a persistent disk.
- **Venue laptop as the server:** run it locally and expose it with Cloudflare Tunnel or Tailscale Funnel to get an https URL. Or run Caddy with an internal certificate and trust it on the tablets.

Then on each tablet, open the URL and choose **Add to Home Screen / Install app**.

## About GitHub

GitHub is a good home for this **code**, but GitHub can't run the server or hold the database. You have two layouts:

1. **One server does everything (recommended).** Clone the repo onto your host and run `node server/server.js`. It serves the app and the API from the same address.
2. **App on GitHub Pages, server elsewhere.** Publish the `public/` folder with GitHub Pages. Set `serverUrl` in `public/config.js` to your server's https address, and start the server with `CORS_ORIGINS=https://yourname.github.io`.

## Configuration (environment variables)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port to listen on |
| `HOST` | `0.0.0.0` | Interface to bind |
| `DATA_FILE` | `data/db.json` | Where the database lives. A `.bak` copy is made on every start |
| `ADMIN_PASSWORD` | random | Password for the first admin (first run only) |
| `CORS_ORIGINS` | *(none)* | Comma-separated origins allowed to call the API when the app is hosted elsewhere |

## Scoring math

Each judge's total = Σ (criterion score × criterion weight). A contestant's result is the **average** of the submitted judge totals, so a missing judge doesn't sink anyone. Results are ranked within each division. Ties are flagged, not broken automatically. The "Judges" column shows anyone not yet scored by every judge in amber. **Lock scoring** freezes judge edits before you announce. Admins can still adjust sheets, and each adjustment is logged with a reason and its before and after values.

## Backups

- Admin → Setup → **Download full backup** (JSON of everything).
- Results → **Export CSV** gives the rankings plus every raw score sheet.
- The server keeps `db.json.bak` from its last start. Copy `data/db.json` somewhere safe after the event.

`data/` is git-ignored. Don't commit the database: it contains password hashes.

## Files

```
server/server.js   API, auth, permissions, sync, live events, static hosting
public/app.js      the whole client app (views, offline store, sync)
public/sw.js       service worker (offline app shell)
public/config.js   optional server address when hosted separately
```

When you change files in `public/`, bump `VERSION` in `public/sw.js` so installed tablets pick up the update.

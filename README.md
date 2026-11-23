# Cosplay Contest Judge

An offline-first scoring app for cosplay contests: check-in, a stage timer with a confidence monitor, judge scoring, results and audited score review. It runs in any browser, installs on tablets, and keeps working when the Wi-Fi drops.

## How it fits together

```
 Tablets / laptops                 Cloudflare (free)                      GitHub
┌──────────────────┐   https    ┌──────────────────────────┐  every ~30s  ┌──────────────────────────────┐
│ App from GitHub  │──────────▶│  Worker = gatekeeper       │────────────▶│ PRIVATE repo                 │
│ Pages            │◀──────────│  • checks logins & roles   │             │ contest_judging_data/db.json │
│ (works offline,  │ live push  │  • holds the live data     │◀────────────│ (readable from anywhere,     │
│  syncs later)    │            │  • holds the GitHub token  │  restore    │  full history in git)        │
└──────────────────┘            └──────────────────────────┘             └──────────────────────────────┘
```

- **This repo (public)** holds only code. GitHub Pages serves the app from `public/`.
- **The data** lives in a separate **private** repo as one JSON file, `db.json`. You can open it, download it, or see its full history from anywhere you can sign in to GitHub.
- **The Worker** sits in between. It checks every login and enforces the roles, and it is the only thing that holds the GitHub token. Tablets never see the token, so a judge can't touch other judges' scores or read data they shouldn't.
- The Worker keeps the live copy and writes it to GitHub **within about 30 seconds** of any change. It batches the writes because GitHub limits API writes to 500 an hour.
- If the Worker is ever redeployed from scratch, it **reloads everything from the GitHub file**. If GitHub can't be reached at that moment, it refuses to start rather than starting with an empty database.

## One-time setup (about 20 minutes)

### 1. Create the private data repo
On GitHub, create **`jw-networks/contest_judging_data`**:
- Visibility: **Private**
- ✅ Tick **"Add a README file"**, so the `main` branch exists

### 2. Create a GitHub token that can only touch that repo
GitHub → your avatar → **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**
- **Resource owner:** `jw-networks`. If it's an organization, an org owner may need to allow or approve fine-grained tokens.
- **Expiration:** a date after your event
- **Repository access:** *Only select repositories* → `contest_judging_data`
- **Permissions → Repository permissions → Contents: Read and write.** Leave everything else at "No access". Metadata read-only is added automatically.

Copy the token. You'll paste it in step 4.

### 3. Create a free Cloudflare account
1. Sign up at dash.cloudflare.com, then open **Workers & Pages** once so it creates your `*.workers.dev` subdomain.
2. Copy your **Account ID**. It's shown on the Workers & Pages overview page.
3. **My Profile → API Tokens → Create Token**, use the **"Edit Cloudflare Workers"** template, and copy the token.

### 4. Add secrets to this repo
`contest_judging` → **Settings → Secrets and variables → Actions → New repository secret**

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | the token from step 3 |
| `CLOUDFLARE_ACCOUNT_ID` | the account ID from step 3 |
| `DATA_REPO_TOKEN` | the GitHub token from step 2 |
| `ADMIN_PASSWORD` | the first admin password (8+ characters). It's only used the very first time, and you'll be made to change it at first sign-in |

### 5. Deploy the Worker
**Actions → "Deploy API (Cloudflare Worker)" → Run workflow.** When it finishes, the log shows the Worker's address, something like `https://contest-judging-api.<your-subdomain>.workers.dev`.

### 6. Point the app at it and switch on Pages
1. **Settings → Secrets and variables → Actions → Variables → New repository variable:** `API_URL` = the Worker address from step 5
2. **Settings → Pages → Build and deployment → Source: GitHub Actions**
3. **Actions → "Deploy app to GitHub Pages" → Run workflow**

### 7. Sign in
Open **https://jw-networks.github.io/contest_judging/** and sign in as `admin` with your `ADMIN_PASSWORD`. You'll be asked to choose a new password. Then go to **Setup** to set the event details and criteria, create accounts, and import contestants.

On each tablet, open the same address and choose **Add to Home Screen / Install app**.

After this, pushing changes to `public/` redeploys the app, and pushing changes to `worker/` redeploys the Worker, automatically.

## Who sees what

| Screen | Admin | Coordinator | Judge |
|---|:-:|:-:|:-:|
| Check-in (search, check in, walk-ins, no-shows) | ✓ | ✓ | |
| Stage control (running order, timer, next contestant) | ✓ | ✓ | |
| Confidence monitor | ✓ | ✓ | |
| Scoring (own sheets only, checked-in contestants only) | | | ✓ |
| Results, lock scoring, CSV export, print | ✓ | | |
| Score review and adjustment (reason required, audited) | ✓ | | |
| Setup: event, criteria, accounts, import, GitHub copy | ✓ | | |
| Audit log | ✓ | | |

The Worker enforces all of this. Judges never receive other judges' scores, staff notes, contact details, or contestants who haven't checked in. Coordinators never receive any scores.

The **confidence monitor** (`…/contest_judging/#/monitor`) needs no sign-in, so it can run on a screen facing the stage. It shows only the stage information: the contestant's number, name and character, the timer, and who's up next.

## Security summary

- **No data in the public repo.** Contest data is only in the private repo and in the Worker's storage.
- **The GitHub token never leaves Cloudflare.** It is limited to the one data repo and to file contents only, so even if it leaked it couldn't touch your other repos or settings.
- **Roles are enforced on the server** for every request, not just hidden in the app.
- **Passwords** are salted and hashed (PBKDF2). Sessions use random tokens that are stored only as hashes and expire after 14 days. Disabling an account, changing its role or resetting its password signs that person out everywhere. New accounts and password resets force the person to choose their own password at first sign-in.
- **Brute-force protection:** five wrong passwords lock that username and that address out for a minute, and the error message doesn't reveal whether a username exists.
- **Only your Pages site can call the API.** Browsers on any other website are refused, and the app's own page restricts what scripts it can load (Content-Security-Policy).
- **Audit trail.** Check-ins, score submissions and admin score edits (with reason, before and after) are logged in the app. On top of that, every saved version of `db.json` is kept in the data repo's git history.
- **What's in `db.json`:** all contest data, accounts and password *hashes* (needed so a fresh deployment can restore logins), and the audit log. Sign-in sessions are never written to it. Keep the data repo private and limit who has access to it. The **Download backup** button in Setup leaves the password hashes out.

## Using the GitHub copy

- **Setup → GitHub data copy** shows when the data was last copied and whether changes are waiting. **Copy to GitHub now** forces an immediate copy, which is a good idea before announcing winners.
- To **fix something by hand**, edit `db.json` in the data repo, then click **Restore from GitHub…** and type `RESTORE`. This replaces the live data with the file and keeps everyone signed in. Use the same button to roll back after checking out an older version of the file in GitHub.

## How offline works

- Every action is saved on the device first and goes into an outbox. The dot in the top bar shows **Online**, **Offline · N unsynced**, or **Sign in to sync**.
- When the Worker is reachable, the device sends its outbox and pulls anything newer. A live connection nudges devices instantly, and they also check every 20 seconds.
- Anyone who has signed in online once on a device can sign in on it again with no connection.
- **Conflicts:** judges own their own sheets, so they never collide with each other. If an admin adjusts a sheet while that judge is offline, the admin's version wins and the judge sees a notice.
- A monitor on the **same device** as stage control keeps working with no network. A monitor on a **different** device needs the connection to get updates, but it keeps counting down from what it last received.

## Free-plan limits

For a contest with a few dozen contestants and a handful of judges, the Cloudflare and GitHub free tiers are comfortably enough. Two things to know:
- Cloudflare's free plan gives each request very little processing time. Logins are tuned to fit. If you ever see "exceeded CPU" errors in the Worker logs, the $5/month Workers Paid plan removes that limit, with no code changes.
- Login lockouts are kept in memory, so they reset if Cloudflare restarts the Worker.

## Local testing

```bash
ADMIN_PASSWORD=changeme123 node dev/server.mjs     # Node 18+, no installs
# open http://localhost:8787
```

This runs the real Worker code, with a local folder (`dev/.data/`) standing in for Cloudflare storage and for the GitHub data repo. Use it to try changes before you push.

## Scoring math

Each judge's total = Σ (criterion score × criterion weight). A contestant's result is the **average** of the submitted judge totals, ranked within each division. Ties are flagged, not broken automatically. **Lock scoring** freezes judge edits before you announce.

## Files

```
public/                 the app (deployed to GitHub Pages)
worker/src/core.js      contest logic: accounts, roles, sync, audit
worker/src/index.js     Cloudflare Worker + Durable Object, GitHub copy, live updates
worker/wrangler.toml    Worker settings (allowed site, data repo name, copy interval)
.github/workflows/      auto-deploy for Pages and the Worker
dev/server.mjs          local test server
```

If you rename the data repo or use a custom domain for the app, update `DATA_REPO` or `ALLOWED_ORIGINS` in `worker/wrangler.toml`. When you change files in `public/`, bump `VERSION` in `public/sw.js` so installed tablets pick up the update.

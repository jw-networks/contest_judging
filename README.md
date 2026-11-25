# Spotlight

**Cosplay contest judging.** An offline-first scoring app for cosplay contests: check-in, a stage timer with a confidence monitor, judge scoring, results and audited score review. It runs in any browser, installs on tablets, and keeps working when the Wi-Fi drops.

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
Open the app at **https://spotlight.drimworksprops.com/app/** (the website is at the root; the old https://jw-networks.github.io/contest_judging/ address redirects there) and sign in as `admin` with your `ADMIN_PASSWORD`. You'll be asked to choose a new password. On the **Admin** page, create your contests and accounts. Then, in each contest's **Contest setup**, set its criteria, give people roles, and import contestants.

On each tablet, open the same address and choose **Add to Home Screen / Install app**.

After this, pushing changes to `public/` redeploys the app, and pushing changes to `worker/` redeploys the Worker, automatically.

## Organizations and events

Spotlight is organized as **organization → events → contests**.

- **Organizations** are your customers (and you). Each has its **own separate database** (its own Durable Object), its own admins and staff accounts, and its own events. Accounts never cross organizations: the same username in two orgs is two different people.
- **Signing in:** staff enter the organization's **code** on the sign-in screen once per device (it's remembered), or open its link, `https://<pages-site>/#/o/<code>`. A monitor link for another org works without signing in: `#/o/<code>/monitor/<contestId>`. Devices that never enter a code use the **default organization**, which is the original database, so everything set up before organizations existed keeps working unchanged.
- **Events:** each contest belongs to an event. **Admin → Events** creates, renames and archives them (archiving an event hides its contests from everyone but admins). The event name shows in the title bar and on the monitors. The contest picker groups contests by event.
- **Platform admins** (admins of the default org whose usernames are in the `PLATFORM_ADMINS` Worker variable) get a globe icon → **Spotlight platform**: create an organization (name, code, first admin, first event; you get a sign-in message with a temporary password to send them), rename it, change its code, reset an account's password, and suspend or reactivate it. The default org can't be suspended.
- **Open an organization:** the **Open** button on the platform screen signs you straight into that organization as its admin, using a `spotlight-support` account. The account shows in the organization's own account list, and every visit is in its audit log. A banner shows while you're inside; **Back to my organization** returns you to your own sign-in. The support account has no password anyone knows, the visit lasts up to 12 hours, and suspended organizations can't be opened.
- **Backups:** every organization is backed up to the private GitHub data repo within about a minute of any change, photos included. The default org stays at `db.json` (photos in `photos/`); other organizations go to `orgs/<id>/db.json` and `orgs/<id>/photos/`; the organization list itself is in `orgs/directory.json`. GitHub keeps every earlier version in the repo's history. The platform screen's **Backup** column shows each organization's last backup; click it for **Back up now** and **Restore** (type the org code to confirm). Restore also rebuilds an organization whose database was lost. Photos come back from the backup the first time someone opens them. Organization admins see their last backup time and can back up now, but can't see the repo or restore by themselves.

## Contests and who sees what

Spotlight runs **several contests side by side**, for example a Saturday masquerade, a kids' contest and a makers showcase. Each contest has its own contestants or entries, criteria, divisions or categories, scores, stage timer, results and audit log.

- **Cosplay contests** have a stage walk, with a timer, a running order and a confidence monitor (`…/#/monitor/<contest>`).
- **Makers contests** are judged at tables. There's no stage or timer, and each entry has a title, maker, category and materials.

Everyone signs in with one account. An **admin** sees and manages every contest and all accounts. Everyone else gets a **role per contest**, and a contest without a role is invisible to them:

| Role in a contest | Can do |
|---|---|
| **Lead** | Runs that contest: its settings, criteria, contestants, check-in, stage, results, lock scoring, score fixes, audit log. Adds and removes judges, coordinators and viewers, and can create accounts for them. Only admins add or change leads |
| **Coordinator** | Check-in, adding walk-ins, stage control and the monitor |
| **Judge** | Scores checked-in contestants. Sees only their own scores |
| **Viewer** | Read-only: the contest's contestants and results. No private notes, judge comments or score breakdowns |
| **Tech** | Cosplay only: a live tech-booth screen for whoever is on stage now and next, with music and lighting cues, the timer, and the running order |
| **Emcee** | Cosplay only: a live MC screen for whoever is on stage now and next, with name pronunciation, intro text, and the running order |

Admins create contests and accounts on the **Admin** page (the shield icon in the top bar, or in the account menu). In each contest's **Contest setup**, the **Who has access** list shows that contest's people. Add someone from the dropdown, or choose **New person…** to create an account on the spot. Removing someone's access takes effect at their next sync and clears that contest's data from their device. People who can open more than one contest get a **Contest** dropdown in the top bar to switch between them. Everyone else just sees their contest's name.

All of this is enforced by the Worker. A device only ever receives the records its account may see.

The **confidence monitor** needs no sign-in, so it can run on a screen facing the stage. It shows only the stage information for its contest.

## Run it on your own network (no internet)

Spotlight can also run entirely on a laptop or mini-PC at the venue. Every tablet, phone and laptop on the same Wi-Fi opens it in a browser and syncs through that computer: scores, check-in, photos, and the stage clock on the confidence monitors. No internet is needed. This is optional and separate from the online version.

1. Download the zip for the computer that will run the server (also linked from **Admin** in the app). Node.js is included, so there's nothing else to install:
   [Windows](https://github.com/jw-networks/contest_judging/releases/download/local-server/spotlight-local-server-windows.zip) ·
   [Mac, Apple silicon](https://github.com/jw-networks/contest_judging/releases/download/local-server/spotlight-local-server-mac-arm64.zip) ·
   [Mac, Intel](https://github.com/jw-networks/contest_judging/releases/download/local-server/spotlight-local-server-mac-x64.zip) ·
   [Linux](https://github.com/jw-networks/contest_judging/releases/download/local-server/spotlight-local-server-linux-x64.zip) ·
   [Raspberry Pi / ARM Linux](https://github.com/jw-networks/contest_judging/releases/download/local-server/spotlight-local-server-linux-arm64.zip) ·
   [without Node.js](https://github.com/jw-networks/contest_judging/releases/download/local-server/spotlight-local-server.zip) (needs Node.js 22.13+ installed, or Docker)
2. Unzip it and double-click **Start Spotlight (Windows).bat** or **Start Spotlight (Mac).command** (Linux: `./start-linux.sh`). Allow network access if asked.
3. The window shows the address to open on every device (e.g. `http://192.168.1.20:8787`) and, the first time, the admin password.

The bundled Node.js is the official build from nodejs.org (latest LTS), downloaded and checked against nodejs.org's SHA-256 list by `local/fetch-node.py` during the build.

Data lives in `spotlight-data/` next to the start files: `spotlight.db` (live) and `backups/` (a full copy every 5 minutes and on shutdown, last 48 kept). To move it, stop the server and copy that folder. There's also a Dockerfile in the zip for mini-PCs and NAS boxes. Optional: set `DATA_REPO` and `DATA_REPO_TOKEN` to also copy the data to a private GitHub repo whenever the computer has internet (it uses `local-db.json`, so it never overwrites the cloud copy).

### Moving contests between the online version and a local server

**Admin → Transfer contests** works the same on both:

1. **Before the event (online):** tick the contests, keep *Include reference photos* on, and press **Download transfer file**.
2. **On the local server:** **Choose transfer file…**, check the preview, type `IMPORT`. Contests, criteria, heats, entries, photos, scores and quick notes arrive, and the accounts that work on them come along with their passwords, so everyone signs in as usual.
3. **After the event (local server):** download a transfer file there, and load it online the same way to bring the results back.

Loading replaces the ticked contests on that server with the file's copy (other contests are untouched), so stop scoring on the other side first. Accounts are matched by username: existing ones keep their password and get the file's roles for those contests; missing ones are created. The file contains password hashes (not readable passwords): keep it private and delete it afterwards. Only admins can download or load transfer files.

From the repo: `npm run local` (same thing). The zip is rebuilt automatically by `.github/workflows/local-server.yml` on every push.

**Network notes:** use a normal (not "guest") Wi-Fi so devices can see each other, and give the server a fixed address on the router if you can. The server only answers to its IP address, `localhost`, `.local`/`.lan` names, the computer's own name, or names you add with `SPOTLIGHT_HOSTS`, and only to pages it served itself. Over plain http, browsers don't keep an offline copy of the app shell, so keep the app open on each tablet; scores are saved on the tablet either way. Put `cert.pem` and `key.pem` in `spotlight-data/` to serve https instead.

## The website

`site/` is the customer website, served at the root of the domain: home, pricing, docs and support. The judging app (`public/`) is served at `/app/`. The Pages workflow puts the two together.

- **Editing pages:** each page is built from a small Python file in `tools/site/` (the header and footer are shared). Edit it, then run `python3 tools/site/build.py`. Styles are in `site/site.css`, and the hero scoreboard, forms and docs search are in `site/site.js`.
- **Prices** are on the pricing page (`tools/site/pricing.py`).
- **Screenshots** in `site/img/` are real app screens from a demo show with invented contestants.
- **Forms:** "Get started" and "Contact us" send requests to the **Requests** inbox on the platform screen, where open "my show is today" messages come first. They're also emailed to the `CONTACT_TO` repository variable, if you set it (needs email to be on); replies go straight to the customer. A hidden trap field and a limit of 5 per address per hour keep bots out.
- **Old links keep working:** links from before the website existed (`/#/signup/…`, reset links, org links) and home-screen apps installed from the old address all open the app at `/app/`. A small `site/sw.js` retires the old offline cache from when the app lived at the root, and devices stay signed in.

## Email

Spotlight sends a few emails, all optional and all off until you set them up:

- **Sign-ups:** a confirmation with the contestant's entry number and private link (to check their entry or withdraw). Then "you're in" or "not accepted" when staff approve or decline a held sign-up.
- **Forgot password:** staff can set an email on their account (account menu → Your email; admins can also set it on the Admin page). "Forgot your password?" on the sign-in screen emails a link that works once, within an hour. Admins and leads only see the emails they're allowed to see: only admins see other people's.
- **New organizations:** put the first admin's email on the platform screen and they get their sign-in details by email.

If an email fails (for example Resend is down), nothing else is affected, and the failure is noted in that organization's audit log. Links in emails only ever point at the app's own site (`ALLOWED_ORIGINS`).

**Turning it on (about 10 minutes):**
1. Make a free account at [resend.com](https://resend.com) and verify your domain there (it gives you DNS records to add).
2. Create an API key in Resend.
3. In this GitHub repo, go to Settings → Secrets and variables → Actions:
   - add the **secret** `RESEND_API_KEY` (the API key)
   - add the **variable** `EMAIL_FROM`, e.g. `Spotlight <noreply@yourdomain.com>` (it must use the verified domain)
   - optional: add the **variable** `EMAIL_REPLY_TO`, an address that receives replies
   - optional: add the **variable** `CONTACT_TO`, where website purchase and support requests are emailed
4. Re-run the "Deploy API (Cloudflare Worker)" workflow (Actions tab → Run workflow).
5. On the platform screen, **Email** shows "On"; use **Send test** to check it.

The local network server never sends email.

## Contestant sign-up links

Each contest can have its own sign-up form. Contest leads and admins turn it on in **Setup → Sign-ups**, which gives a link and a QR code (download it as a PNG for posters and tables).

- **Review:** sign-ups wait as *pending review* in Check-in until someone taps Approve or Decline. Turn review off to accept everyone straight away.
- **Form:** name, character and email are required by default. Each built-in question can be required, optional or off. You can rename it, or add your own questions (short answer, long answer, choose one, tick box). Contestants can attach up to 3 reference photos.
- **Limits:** an optional closing time and maximum. With heats on, sign-ups fill regular heat places only, so walk-up places stay free.
- **Withdrawing:** after signing up, each contestant gets a private link to their entry and can withdraw from it until they go on stage. The link's secret is stored only as a hash.
- **Privacy:** emails, phone numbers and answers are visible to leads, coordinators and admins only, never to judges, tech, emcees or the public monitor. **New link** stops the old link and QR code working straight away.
- **Spam:** a hidden trap field, plus at most 8 sign-ups per network address per hour.
- **Organizations:** links for other organizations include the org code (`#/o/<code>/signup/…`), so entries always land in the right organization. Sign-ups also work on the local network server.
- **Export:** "Download sign-ups (CSV)" lists everyone who signed up online, with their answers.

## Contestant feedback

**Results → Contestant feedback** (contest leads and admins). For each contestant: their average score, their average for each category, the quick notes the judges ticked (most-ticked first) and, if you allow it, the judges' written comments. It never says which judge gave what: no names, and comments are listed alphabetically, not in judge order. Only submitted score sheets count. With heats, heats and finals are shown separately.

- **Print feedback sheets:** one page per contestant. Each contestant's Review page also has **Print feedback** for just them.
- **Email feedback** (when email is on): goes to every scored contestant with an email address, each getting only their own. It's sent in batches and never twice, unless you choose **Send again to everyone**.
- **Show feedback on contestants' private sign-up pages:** contestants who signed up online see it on their private entry page.
- **Include the judges' written comments:** on by default. Turn it off to share only scores and quick notes.

## Paper score cards

A backup for when tablets can't be used: **Setup → Judging criteria → Print paper score cards**, or **Results → Paper score cards**.

- **Cards:** one per contestant, two per page (one per page if there are many criteria or quick notes). Each has a box per criterion with its maximum, a total box, quick-note tick boxes and comment lines.
- **Judge sheet:** one landscape table per judge, a row per contestant in running order.
- Print for everyone, one heat, finals, or blank cards only. Add blank extras for walk-ups, print only people who have checked in, and print a named copy for each judge.

Type the scores in later from each contestant's Review page.

## Heats and finals

In **Setup → Contest**, set **Heats** (0 = no heats) and **Finalists from all heats combined** (default 3).

- Coordinators put each entry in a heat when adding or editing it. New entries go to the heat with the fewest people by default.
- Stage control has a round picker (Heat 1, Heat 2 … Finals). The confidence monitor shows the round.
- Judges pick the heat they're scoring at the top of their list. If the stage moves to another heat, they're offered a one-tap switch. **My ranking** ranks within the heat on screen.
- **Results → Heats** ranks every heat entry together. The contest lead presses **Confirm top N as finalists**, or uses the ☆ column to settle a tie by hand. Finalists walk the finals lowest qualifier first.
- **Heat size:** *Max contestants per heat* (default 14) is for pre-registered and imported entries. *Extra walk-up slots per heat* (default 4) are kept for people who sign up on the day, who can also use any unused regular place. Check-in shows how full each heat is. Coordinators can't add to a full heat; a contest lead can override. No-shows free up their place.
- **Import with heats:** add a `heat` column (and optionally a `walk-up` yes/no column) to the CSV. Rows with no heat, or a heat that doesn't exist, go to the heat with the most room. Rows over a heat's limit are still imported, with a warning.
- Finals are scored again from zero, on separate score sheets. **Results → Finals** shows the top 3 podium. The CSV export includes both rounds.

## Show details, photos and after the event

- **Show details:** in a cosplay contestant's editor, coordinators fill in *music & sound cue*, *lighting notes*, *name pronunciation* and an *emcee intro*. These can also be CSV columns. The tech and emcee screens update on their own as the stage moves. Coordinators, leads and admins can open them from **Stage → Tech view / Emcee view**.
- **Reference photos:** open an entry, then **Add photos**. A tablet can take them with its camera or pick them from the library. Photos are shrunk on the device before uploading, with up to 8 per entry. Judges see them on the score sheet and can tap one for full screen. Judges' devices keep copies, so photos still work offline at the table. Photos are stored in Cloudflare with the live data and are **not** copied to GitHub.
- **After the event** (bottom of **Contest setup**):
  - **Clear personal data** (admins and leads) removes contact details and private staff notes, and optionally reference photos and judge comments, from every entry. Names, scores and results are kept.
  - **Delete contest** (admins only) removes the contest and everything in it: entries, scores, photos, its audit log, and everyone's roles in it.
  - Both ask you to type the contest name to confirm.

### Removing old data from GitHub history

Spotlight overwrites `db.json` in the data repo, but **git keeps every earlier version**. Data you cleared or deleted therefore still exists in the repo's history. To remove it there too:

1. In the app, use **Admin → GitHub data copy → Copy to GitHub now**, so the latest clean file is in the repo.
2. Download that `db.json` from the data repo.
3. Delete the data repo on GitHub (Settings → Danger zone), then create it again with the same name, private, with a README.
4. Upload the clean `db.json` to it, or just click **Copy to GitHub now** again.
5. If you recreated the repo, edit your fine-grained token so it includes the new repo, then **Admin → GitHub data copy** should show a fresh copy.

## Security summary

- **No data in the public repo.** Contest data is only in the private repo and in the Worker's storage.
- **The GitHub token never leaves Cloudflare.** It is limited to the one data repo and to file contents only, so even if it leaked it couldn't touch your other repos or settings.
- **Roles are enforced on the server** for every request, not just hidden in the app.
- **Passwords** are salted and hashed (PBKDF2). Sessions use random tokens that are stored only as hashes and expire after 14 days. Disabling an account, changing its role or resetting its password signs that person out everywhere. New accounts and password resets force the person to choose their own password at first sign-in.
- **Brute-force protection:** five wrong passwords lock that username and that address out for a minute, and the error message doesn't reveal whether a username exists.
- **Only your Pages site can call the API.** Browsers on any other website are refused, and the app's own page restricts what scripts it can load (Content-Security-Policy).
- **Audit trail.** Check-ins, score submissions and admin score edits (with reason, before and after) are logged in the app. On top of that, every saved version of `db.json` is kept in the data repo's git history.
- **What's in `db.json`:** all contest data, accounts and password *hashes* (needed so a fresh deployment can restore logins), and the audit log. Sign-in sessions are never written to it. Keep the data repo private and limit who has access to it. The **Download full backup** button on the Admin page leaves the password hashes out.

## Using the GitHub copy

- **Admin → GitHub data copy** shows when the data was last copied and whether changes are waiting. **Copy to GitHub now** forces an immediate copy, which is a good idea before announcing winners.
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

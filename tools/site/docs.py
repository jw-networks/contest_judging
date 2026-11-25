import os, sys; HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
SITE = os.path.join(HERE, '..', '..', 'site')
from common import head, foot
toc = [
  ('Getting started', [('overview', 'How Spotlight is organized'), ('signing-in', 'Signing in'), ('roles', 'Roles')]),
  ('Before the show', [('setup', 'Setting up a contest'), ('signups', 'Sign-up links'), ('heats', 'Heats and finals')]),
  ('On the day', [('checkin', 'Check-in'), ('stage', 'Running the stage'), ('judging', 'Judging'), ('paper', 'Paper score cards'), ('offline', 'Offline and local mode')]),
  ('After the show', [('results', 'Results'), ('feedback', 'Contestant feedback')]),
  ('Your organization', [('accounts', 'Accounts and passwords'), ('data', 'Backups and your data')]),
]
nav = ''.join(f'<div class="group">{g}</div>' + ''.join(f'<a href="#{i}">{t}</a>' for i, t in items) for g, items in toc)
body = '''
<section id="overview">
  <h2>How Spotlight is organized</h2>
  <p>Spotlight has three levels:</p>
  <ul>
    <li><b>Your organization</b>: your convention, club or group. It has its own accounts and data, separate from everyone else's.</li>
    <li><b>Events</b>: a show on a date, like “Spring Con 2027”.</li>
    <li><b>Contests</b>: the competitions within an event, like “Cosplay masquerade” or “Prop makers”. Each contest has its own criteria, entries, judges and results.</li>
  </ul>
  <p>Contests are either <b>cosplay</b> (with a stage, running order, tech booth and emcee) or <b>makers</b> (judged entries, no stage).</p>
  <p>Everyone uses the same app at <a href="/app/">spotlight.drimworksprops.com/app</a>. What each person sees depends on their role in the contest they're working on.</p>
</section>

<section id="signing-in">
  <h2>Signing in</h2>
  <p>Open the app, enter your <b>organization code</b>, your username and your password. The easiest way is your organization's sign-in link, which fills in the code for you.</p>
  <ul>
    <li><b>First sign-in:</b> you'll be asked to choose your own password.</li>
    <li><b>Forgot your password?</b> Use the link on the sign-in screen. If your account has an email address, you'll get a link to choose a new one. Otherwise, ask an admin to reset it.</li>
    <li><b>Sharing a tablet:</b> use <b>Switch person</b> in the account menu. Each person keeps their own sign-in and scores.</li>
    <li><b>Install it:</b> add the app to the home screen (Share → Add to Home Screen on iPad, or the install option in Chrome). It opens full screen and works offline.</li>
  </ul>
</section>

<section id="roles">
  <h2>Roles</h2>
  <p>Admins manage the whole organization. Everyone else gets a role in each contest they work on, and can have different roles in different contests.</p>
  <div class="role"><b>Admin</b><span>Everything: events, contests, accounts, backups. Admins see every contest.</span></div>
  <div class="role"><b>Lead</b><span>Runs a contest: setup, criteria, sign-ups, results, score review, feedback and the audit log.</span></div>
  <div class="role"><b>Coordinator</b><span>Check-in and the stage: confirms who's here, runs the order, calls people on stage. Can't see scores.</span></div>
  <div class="role"><b>Judge</b><span>Scores entries. Sees only their own scores and their own ranking.</span></div>
  <div class="role"><b>Tech</b><span>The tech booth: who's on stage and their music and lighting cues.</span></div>
  <div class="role"><b>Emcee</b><span>Who's on stage and next, with pronunciation and intro notes.</span></div>
  <div class="role"><b>Viewer</b><span>Read-only results and check-in, for organizers who just want to watch.</span></div>
</section>

<section id="setup">
  <h2>Setting up a contest</h2>
  <p>Admins create events and contests on the <b>Admin</b> page. Then, in each contest's <b>Setup</b>:</p>
  <ol>
    <li><b>Criteria:</b> what judges score, each with a maximum and an optional weight. The total is each score times its weight.</li>
    <li><b>Quick notes:</b> the tick boxes judges can use, like “extraordinary paint” or “great weathering”. They're used for contestant feedback later.</li>
    <li><b>Divisions</b> (or categories, for makers), if you split entries by skill level or type.</li>
    <li><b>People:</b> give accounts a role in this contest. Admins create accounts on the Admin page.</li>
    <li><b>Entries:</b> add them one at a time, open <a href="#signups">sign-ups</a>, or paste rows from a spreadsheet or choose a CSV file. Columns can include number, name, character, series, division, heat, contact details and stage notes.</li>
  </ol>
  <p class="note">Do a short practice run with your judges before the show: score two or three test entries so everyone knows the screen.</p>
</section>

<section id="signups">
  <h2>Sign-up links</h2>
  <p>In <b>Setup → Sign-ups</b>, turn sign-ups on to get a link and a QR code for the contest. Download the QR code as an image for posters and tables.</p>
  <ul>
    <li><b>Review:</b> by default, sign-ups wait as <i>pending review</i> in Check-in until someone approves or declines them. Turn review off to accept everyone straight away.</li>
    <li><b>Your questions:</b> name, character and email are required by default. Each built-in question can be required, optional or off. You can also add your own questions, and contestants can attach up to three reference photos.</li>
    <li><b>Limits:</b> set a closing time or a maximum. With heats, sign-ups only fill regular places, so walk-up places stay free.</li>
    <li><b>Withdrawing:</b> each contestant gets a private link to their entry, and can withdraw until they go on stage.</li>
    <li><b>New link:</b> stops the old link and QR code working straight away.</li>
  </ul>
  <p>With email set up, contestants get a confirmation with their private link, then an email when you approve or decline them.</p>
</section>

<section id="heats">
  <h2>Heats and finals</h2>
  <p>Turn on heats in Setup for big contests. Each heat has a number of regular places plus walk-up places (14 and 4 by default).</p>
  <ul>
    <li>Entries can be placed in heats on import (a heat column), at sign-up, or at check-in.</li>
    <li>Judges pick the heat they're scoring. Each judge has an <b>All heats</b> tab to look back at earlier rounds.</li>
    <li><b>Finalists</b> are the top entries across all heats combined (three by default), not the top of each heat.</li>
    <li><b>Finals</b> are scored from zero. The podium comes from the finals scores.</li>
  </ul>
</section>

<section id="checkin">
  <h2>Check-in</h2>
  <p>The <b>Check-in</b> screen lists every entry, with search by name, character, number or email.</p>
  <ul>
    <li>Tap an entry to check them in, or to edit their details.</li>
    <li>Pending online sign-ups show at the top with <b>Approve</b> and <b>Decline</b>.</li>
    <li>Add walk-ups on the spot. With heats on, Spotlight shows how many places are left in each heat.</li>
    <li>Mark people who don't turn up as no-shows. They're left out of results.</li>
  </ul>
</section>

<section id="stage">
  <h2>Running the stage</h2>
  <p>On the <b>Stage</b> screen, the coordinator sees the running order and calls each entry on stage. Everyone else's screens follow along live.</p>
  <ul>
    <li>The <b>Tech booth</b> sees who's on and their music and lighting cues.</li>
    <li>The <b>Emcee</b> sees who's on and who's next, with pronunciation and intro notes.</li>
    <li>The <b>confidence monitor</b> is a full-screen view for a screen backstage or by the stage. Open it from the monitor button in the top bar. It needs no sign-in.</li>
  </ul>
</section>

<section id="judging">
  <h2>Judging</h2>
  <p>Judges see the <b>Scoring</b> screen with the entry on stage, or they can pick any entry in the running order.</p>
  <ul>
    <li>Score each criterion, tick any quick notes, and add a comment if you like.</li>
    <li>Scores save as you go. They're a <b>draft</b> until you tap <b>Submit</b>. Only submitted scores count in results.</li>
    <li>Your running ranking shows gold, silver and bronze for your current top three. It's yours alone: judges never see each other's scores.</li>
  </ul>
  <p>Leads and admins can check every judge's sheet on the <b>Review</b> page, and correct a score if needed. Every change is in the audit log.</p>
</section>

<section id="paper">
  <h2>Paper score cards</h2>
  <p>A backup for when tablets can't be used. Print them from <b>Setup → Judging criteria</b> or from <b>Results</b>.</p>
  <ul>
    <li><b>Cards:</b> one per entry, two per page, with a box for each criterion, a total, quick-note tick boxes and comment lines.</li>
    <li><b>Judge sheet:</b> one table per judge, a row per entry in running order.</li>
    <li>Print for everyone, a heat, the finals, or blank cards only. Add blank cards for walk-ups, and a named copy for each judge.</li>
  </ul>
  <p>Afterwards, type the scores in on each entry's Review page.</p>
</section>

<section id="offline">
  <h2>Offline and local mode</h2>
  <h3>When the Wi-Fi drops</h3>
  <p>Every device keeps working. Scores, check-ins and stage changes are saved on the device and sent as soon as it's back online. The status in the top bar shows whether a device is online and synced.</p>
  <p class="note">Before switching off or changing devices, make sure the status shows everything is synced.</p>
  <h3>No internet at all</h3>
  <p>Run Spotlight on a laptop on your own network (a travel router works well). Download it from the <b>Admin</b> page: it runs on Windows, Mac, Linux or a Raspberry Pi, with nothing else to install. Devices connect to the laptop's address, and everything syncs between them, including the stage, without internet.</p>
  <p>To move contests between the online app and a local server, use <b>Transfer contests</b> on the Admin page: export a file from one, import it into the other, then bring the results back after the show.</p>
</section>

<section id="results">
  <h2>Results</h2>
  <p>The <b>Results</b> page ranks entries by their average: the mean of each judge's weighted total. It updates as scores are submitted.</p>
  <ul>
    <li><b>Ties</b> are flagged for you to decide. Spotlight never breaks a tie silently.</li>
    <li>With heats, finalists are marked, and the finals have their own standings and podium.</li>
    <li>Print the results, or export them as a spreadsheet (CSV).</li>
  </ul>
</section>

<section id="feedback">
  <h2>Contestant feedback</h2>
  <p>In <b>Results → Contestant feedback</b>, leads and admins can share each contestant's own feedback:</p>
  <ul>
    <li>their average score and their average for each category</li>
    <li>the quick notes the judges ticked, most-ticked first</li>
    <li>the judges' written comments, if you allow them</li>
  </ul>
  <p>It never says which judge gave what. Print a sheet for everyone (or one from an entry's Review page), email each contestant their own, or show it on their private sign-up page.</p>
</section>

<section id="accounts">
  <h2>Accounts and passwords</h2>
  <ul>
    <li>Admins create accounts on the <b>Admin</b> page with a temporary password, which the person changes at first sign-in.</li>
    <li>Add an email to an account, or let people add their own in the account menu, so they can reset a forgotten password themselves.</li>
    <li>Admins can reset a password or turn an account off at any time. Turning an account off signs that person out everywhere.</li>
  </ul>
</section>

<section id="data">
  <h2>Backups and your data</h2>
  <ul>
    <li>Spotlight backs up your organization automatically, photos included, within about a minute of any change. Earlier versions are kept.</li>
    <li>Admins can download a full backup from the Admin page at any time, and export results as spreadsheets.</li>
    <li>The <b>Audit log</b> records who changed what and when: scores, entries, check-ins and settings.</li>
    <li>Contact details are only shown to leads, coordinators and admins. Judges, tech and emcees never see contestants' emails or phone numbers.</li>
  </ul>
  <p>Need a backup restored? <a href="/support/#contact">Contact support</a>.</p>
</section>

<p class="empty" hidden>Nothing matches that. Try another word, or <a href="/support/#contact">ask us</a>.</p>
'''
html = head('Docs · Spotlight', 'How to set up and run a contest with Spotlight: sign-ups, check-in, the stage, judging, results, feedback and running offline.', 'docs') + f'''
<div class="page-head"><div class="wrap">
  <h1>Docs</h1>
  <p class="lede">Everything you need to set up a contest and run it on the day.</p>
</div></div>
<div class="wrap docs">
  <aside class="toc">
    <button type="button" aria-label="Show sections">Sections</button>
    <input type="search" placeholder="Search the docs" aria-label="Search the docs">
    <nav aria-label="Docs sections">{nav}</nav>
  </aside>
  <article class="doc">{body}</article>
</div>
''' + foot()
open(os.path.join(SITE, 'docs/index.html'), 'w').write(html)
print('ok')

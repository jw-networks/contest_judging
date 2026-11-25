import os, sys; HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
SITE = os.path.join(HERE, '..', '..', 'site')
from common import head, foot
redirect = '''<script>
  // Links made before the website existed (sign-up links, reset links, org links) and installed
  // home-screen apps still open the judging app.
  (function () {
    var h = location.hash, standalone = window.matchMedia && matchMedia('(display-mode: standalone)').matches;
    if (/^#\\//.test(h) || standalone) location.replace('/app/' + h);
  })();
</script>
'''
html = head('Spotlight: contest judging for cosplay and maker shows',
  'Run your cosplay contest or maker showcase from sign-up to standings. Judges score on tablets, the stage crew sees who is next, and results are ready the moment the last score lands.',
  'home', redirect) + '''
<section class="hero">
  <div class="wrap">
    <div>
      <h1><span>Your stage.</span><span>Your judges.</span><span>Your time.</span></h1>
      <p class="lede">Spotlight runs cosplay contests and maker showcases from sign-up to standings. Judges score on tablets, your stage crew always knows who's next, and the results are ready the moment the last score lands.</p>
      <div class="hero-ctas">
        <a class="btn primary" href="/pricing/#request">Get started</a>
        <a class="btn ghost" href="#how">See how a show runs</a>
      </div>
      <p class="hero-note">Works on the tablets and phones you already have. Keeps going when the venue Wi&#8209;Fi doesn't.</p>
    </div>

    <div class="stage" aria-label="Example: a contestant on stage while three judges score and the standings update">
      <div class="stage-bar"><span class="live"><i></i>On stage</span><span class="clock">00:00</span></div>
      <div class="onstage">
        <div class="num">#14</div>
        <div class="who"><b>Clockwork Witch</b><span>Cosplay, Master division</span></div>
      </div>
      <div class="judges">
        <div class="judge"><small>Judge 1</small><div class="sc wait">Scoring…</div></div>
        <div class="judge"><small>Judge 2</small><div class="sc wait">Scoring…</div></div>
        <div class="judge"><small>Judge 3</small><div class="sc wait">Scoring…</div></div>
      </div>
      <div class="board-h"><span>Standings</span><span>Average of 40</span></div>
      <ol class="board"></ol>
    </div>
  </div>
</section>

<div class="wrap">
  <div class="for"><strong>Built for</strong><span>Cosplay contests</span><span>Convention masquerades</span><span>Maker showcases</span><span>Prop and craft competitions</span></div>
</div>

<section class="band" id="how">
  <div class="wrap">
    <div class="section-head">
      <h2>How a show runs</h2>
      <p>One app for everyone working the contest. Each person signs in and sees only their part of it.</p>
    </div>
    <ol class="steps">
      <li><h3>Open sign-ups</h3><p>Share a link or QR code. Entries land in your contest, waiting for your approval.</p></li>
      <li><h3>Check people in</h3><p>The desk checks entrants in, places walk-ups in heats, and fixes details on the spot.</p></li>
      <li><h3>Run the stage</h3><p>Your crew sees who's on and who's next. A monitor backstage shows the emcee the same.</p></li>
      <li><h3>Judge</h3><p>Each judge scores alone, on their own tablet, with quick notes and their own running ranking.</p></li>
      <li><h3>Announce and follow up</h3><p>Standings, finals and the podium are ready at once. Contestants get their feedback.</p></li>
    </ol>
  </div>
</section>

<section class="band tight" style="padding-top:0">
  <div class="wrap">
    <div class="feature">
      <div class="shot"><img src="/img/judge.webp" alt="A judge's scoring screen on a tablet: criteria sliders, quick notes and the judge's own top three" width="1600" height="1098" loading="lazy"></div>
      <div>
        <h3>Every judge scores on their own</h3>
        <p>Judges can't see each other's scores, so nobody anchors on the loudest voice at the table. Each judge sees their own running ranking, with gold, silver and bronze for their current top three.</p>
        <ul>
          <li>Your criteria, maximums and weights</li>
          <li>Quick notes, like “extraordinary paint”, in one tap</li>
          <li>Scores save on the tablet first, so nothing is lost if the Wi-Fi drops</li>
        </ul>
      </div>
    </div>

    <div class="feature flip">
      <div class="shot"><img src="/img/results.webp" alt="Results screen with heats combined, finalists marked and the podium" width="1600" height="1003" loading="lazy"></div>
      <div>
        <h3>Heats and finals, without the spreadsheet</h3>
        <p>Split a big contest into heats with a set number of places, and keep walk-up places free. Spotlight finds the finalists across all heats, then scores the finals from zero.</p>
        <ul>
          <li>Places and walk-up slots per heat</li>
          <li>Finalists picked from all heats combined</li>
          <li>Ties are flagged for you to decide, never broken silently</li>
        </ul>
      </div>
    </div>

    <div class="feature">
      <div class="shot pair"><img src="/img/stage.webp" alt="Stage manager's screen showing who is on stage and the running order" width="1600" height="1098" loading="lazy"><img src="/img/signup.webp" alt="A contestant's sign-up form on a phone" width="780" height="1520" loading="lazy"></div>
      <div>
        <h3>From sign-up link to stage call</h3>
        <p>Contestants sign up on their phones with your own questions and reference photos. You approve them, the check-in desk confirms who's here, and the running order is ready for the stage.</p>
        <ul>
          <li>A link and QR code for each contest</li>
          <li>Contestants can withdraw with their own private link</li>
          <li>A backstage monitor for the emcee, no sign-in needed</li>
        </ul>
      </div>
    </div>

    <div class="feature flip">
      <div class="shot"><img src="/img/feedback.webp" alt="A printed feedback sheet: average score, category averages, the judges' quick notes and comments" width="1240" height="982" loading="lazy"></div>
      <div>
        <h3>Contestants leave with more than a placing</h3>
        <p>Every contestant can get their average score, their average for each category, the notes the judges ticked and their written comments. It never says which judge gave what.</p>
        <ul>
          <li>Print a sheet for everyone, or one at a time</li>
          <li>Email each contestant their own feedback</li>
          <li>Or show it on their private sign-up page</li>
        </ul>
      </div>
    </div>
  </div>
</section>

<section class="band" id="offline" style="background:var(--panel);border-top:1px solid var(--line);border-bottom:1px solid var(--line)">
  <div class="wrap split">
    <div>
      <h2>Keeps working when the Wi&#8209;Fi doesn't</h2>
    </div>
    <div>
      <p class="lede" style="margin-top:0">Convention Wi-Fi fails at the worst moment. Spotlight is built for it.</p>
      <p>Every tablet keeps working offline and catches up when it reconnects. For venues with no internet at all, run Spotlight on a laptop on your own network: everything still syncs between devices, including the stage timer. And if a tablet dies, print paper score cards in a few seconds.</p>
      <p><a href="/docs/#offline">How offline and local mode work</a></p>
    </div>
  </div>
</section>

<section class="band">
  <div class="wrap">
    <div class="section-head"><h2>Also in every plan</h2></div>
    <div class="also">
      <div><b>Roles for your whole crew</b><span>Leads, coordinators, judges, tech and emcees each see only what they need.</span></div>
      <div><b>Events and contests</b><span>Several contests in one event, and every event in one place.</span></div>
      <div><b>Backed up every minute</b><span>Every change is saved, photos included, with earlier versions kept.</span></div>
      <div><b>Paper score cards</b><span>Print cards or judge sheets as a backup, named for each judge.</span></div>
      <div><b>An audit log</b><span>Who changed what, and when, for every score and entry.</span></div>
      <div><b>Your data, your way</b><span>Export results as a spreadsheet, or take a full backup any time.</span></div>
    </div>
  </div>
</section>

<section class="closer">
  <div class="wrap">
    <h2>Bring Spotlight to your next show</h2>
    <p>Tell us about your event and we'll have your organization ready, usually the same day.</p>
    <div class="hero-ctas"><a class="btn primary" href="/pricing/#request">Get started</a><a class="btn ghost" href="/pricing/">See pricing</a></div>
  </div>
</section>
''' + foot()
open(os.path.join(SITE, 'index.html'), 'w').write(html)
print('ok')

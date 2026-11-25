import os, sys; HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, HERE)
SITE = os.path.join(HERE, '..', '..', 'site')
from common import head, foot
html = head('Support · Spotlight', 'Get help with Spotlight: answers to common questions, the documentation, and a way to reach the team.', 'support') + '''
<div class="page-head"><div class="wrap">
  <h1>Support</h1>
  <p class="lede">Most answers are in the docs. For anything else, send us a message: a real person replies.</p>
</div></div>

<section class="band" style="padding-top:0">
  <div class="wrap split">
    <div>
      <h2 style="font-size:34px;margin-bottom:22px">Quick answers</h2>
      <div class="help-list">
        <a href="/docs/#signing-in"><b>Someone can't sign in</b><span>Organization codes, forgotten passwords and first sign-in.</span></a>
        <a href="/docs/#judging"><b>A judge's scores look wrong</b><span>Drafts, submitting, and how admins adjust a score.</span></a>
        <a href="/docs/#offline"><b>The Wi-Fi is down</b><span>What keeps working, and how devices catch up.</span></a>
        <a href="/docs/#paper"><b>A tablet died mid-show</b><span>Print paper score cards and type them in later.</span></a>
        <a href="/docs/#heats"><b>Heats and finals</b><span>Places, walk-ups and how finalists are chosen.</span></a>
        <a href="/docs/#signups"><b>Sign-up links</b><span>Reviewing entries, closing sign-ups, new links.</span></a>
      </div>
      <div class="urgent">
        <b>Is your show today?</b>
        <p style="margin:6px 0 0">Tick “My show is today” on the form. Those messages go to the top of the queue.</p>
      </div>
    </div>

    <div id="contact">
      <h2 style="font-size:34px;margin-bottom:22px">Contact us</h2>
      <form class="form" data-kind="support" novalidate>
        <label class="field"><span>Your name</span><input name="name" autocomplete="name" required maxlength="120"></label>
        <label class="field"><span>Email</span><input name="email" type="email" autocomplete="email" required maxlength="200"></label>
        <label class="field"><span>Organization code <em>(if you have one)</em></span><input name="org" maxlength="60" autocapitalize="none"></label>
        <label class="field"><span>What's it about?</span><select name="topic"><option>A problem during setup</option><option>A problem during a show</option><option>Accounts and sign-in</option><option>Billing and plans</option><option>A question</option><option>An idea for Spotlight</option></select></label>
        <label class="field full"><span>Message</span><textarea name="message" required maxlength="4000" placeholder="What happened, on which screen, and what you expected."></textarea></label>
        <label class="check full"><input type="checkbox" name="urgent" value="1">My show is today</label>
        <div class="hp" aria-hidden="true"><label>Leave this empty <input name="website" tabindex="-1" autocomplete="off"></label></div>
        <p class="form-msg" role="alert"></p>
        <div class="full"><button class="btn primary" type="submit">Send message</button></div>
      </form>
    </div>
  </div>
</section>
''' + foot()
open(os.path.join(SITE, 'support/index.html'), 'w').write(html)
print('ok')

// Spotlight website: header, mobile menu, the live-stage demo, request forms, docs navigation.
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- header
  const top = $('.top');
  const onScroll = () => top && top.classList.toggle('scrolled', scrollY > 8);
  addEventListener('scroll', onScroll, { passive: true }); onScroll();
  const menu = $('.menu-btn'), nav = $('.nav');
  menu?.addEventListener('click', () => { const open = nav.classList.toggle('open'); menu.setAttribute('aria-expanded', open); });

  // ---------- the hero: a contestant on stage, judges' scores arriving, the standings settling
  const stage = $('.stage');
  if (stage) {
    const field = [
      { n: 7, name: 'Ember Knight', avg: 34.3 },
      { n: 3, name: 'Tidecaller', avg: 33.0 },
      { n: 11, name: 'Brass Automaton', avg: 31.7 },
      { n: 5, name: 'Moth Queen', avg: 29.3 },
    ];
    const show = [
      { n: 14, name: 'Clockwork Witch', maker: 'Craftsmanship, accuracy, presence', scores: [36, 35, 37] },
      { n: 15, name: 'Glass Ronin', maker: 'Craftsmanship, accuracy, presence', scores: [30, 33, 31] },
    ];
    const board = $('.board', stage), judges = $$('.judge', stage), clock = $('.clock', stage);
    const num = $('.onstage .num', stage), who = $('.onstage .who b', stage);
    const draw = (list, fresh) => {
      const rects = new Map($$('li', board).map(li => [li.dataset.n, li.getBoundingClientRect().top]));
      board.replaceChildren(...list.slice(0, 5).map((p, i) => {
        const li = document.createElement('li');
        li.dataset.n = p.n;
        if (p.n === fresh) li.className = 'fresh';
        li.innerHTML = `<span class="rk">${i < 3 ? `<i class="medal ${'gsb'[i]}" title="${['First', 'Second', 'Third'][i]}"></i>` : i + 1}</span><span class="n">#${p.n}</span><span class="nm"></span><span class="avg">${p.avg.toFixed(1)}</span>`;
        li.querySelector('.nm').textContent = p.name;
        return li;
      }));
      if (reduced) return;
      // Slide rows from where they were to where they are now.
      $$('li', board).forEach(li => {
        const was = rects.get(li.dataset.n), now = li.getBoundingClientRect().top;
        if (was == null) { li.animate([{ opacity: 0, transform: 'translateY(8px)' }, { opacity: 1, transform: 'none' }], { duration: 500, easing: 'cubic-bezier(.2,.8,.2,1)' }); return; }
        if (was !== now) li.animate([{ transform: `translateY(${was - now}px)` }, { transform: 'none' }], { duration: 650, easing: 'cubic-bezier(.2,.8,.2,1)' });
      });
    };
    const setJudge = (j, v) => {
      const el = judges[j], sc = el.querySelector('.sc');
      if (v == null) { el.classList.remove('in'); sc.className = 'sc wait'; sc.textContent = 'Scoring…'; }
      else { el.classList.add('in'); sc.className = 'sc'; sc.textContent = v; }
    };
    const wait = ms => new Promise(r => setTimeout(r, ms));
    let list = [...field];
    const run = async () => {
      draw(list);
      for (const c of show) {
        num.textContent = '#' + c.n; who.textContent = c.name;
        judges.forEach((_, j) => setJudge(j, null));
        let s = 0;
        const t = setInterval(() => { s++; clock.textContent = `0${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; }, 1000);
        for (let j = 0; j < 3; j++) { await wait(1300 + j * 500); setJudge(j, c.scores[j]); }
        clearInterval(t);
        await wait(700);
        list = [...list, { n: c.n, name: c.name, avg: c.scores.reduce((a, b) => a + b, 0) / 3 }].sort((a, b) => b.avg - a.avg);
        draw(list, c.n);
        await wait(2600);
      }
    };
    if (reduced) {
      const c = show[0];
      num.textContent = '#' + c.n; who.textContent = c.name; clock.textContent = '01:12';
      c.scores.forEach((v, j) => setJudge(j, v));
      list = [...list, { n: c.n, name: c.name, avg: c.scores.reduce((a, b) => a + b, 0) / 3 }].sort((a, b) => b.avg - a.avg);
      draw(list, c.n);
    } else {
      // Start when the stage is on screen (it usually is, on load).
      const io = new IntersectionObserver(es => { if (es.some(e => e.isIntersecting)) { io.disconnect(); run(); } }, { threshold: .3 });
      draw(list); judges.forEach((_, j) => setJudge(j, null)); io.observe(stage);
    }
  }

  // ---------- request forms (purchase, support): they go to the Spotlight team's inbox
  const api = () => (window.APP_CONFIG && window.APP_CONFIG.serverUrl) || '';
  $$('form[data-kind]').forEach(form => {
    const msg = $('.form-msg', form), btn = $('button[type=submit]', form);
    // "Get started" buttons on the pricing page pick the plan.
    $$('[data-plan]').forEach(a => a.addEventListener('click', () => { const sel = form.elements.plan; if (sel) sel.value = a.dataset.plan; }));
    if (form.elements.plan && location.hash.startsWith('#request-')) form.elements.plan.value = location.hash.slice(9);
    form.addEventListener('submit', async e => {
      e.preventDefault();
      msg.textContent = ''; msg.className = 'form-msg';
      const data = Object.fromEntries(new FormData(form));
      for (const el of $$('[required]', form)) {
        if (!String(data[el.name] || '').trim()) { msg.textContent = `Please fill in “${el.closest('.field')?.querySelector('span')?.firstChild?.textContent?.trim() || el.name}”.`; msg.classList.add('err'); el.focus(); return; }
      }
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(data.email || '').trim())) { msg.textContent = 'Please check your email address.'; msg.classList.add('err'); form.elements.email.focus(); return; }
      if (!api()) { msg.textContent = 'This form isn\'t connected yet. Please email us instead.'; msg.classList.add('err'); return; }
      btn.disabled = true; const label = btn.textContent; btn.textContent = 'Sending…';
      try {
        const res = await fetch(api() + '/api/site/request', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ kind: form.dataset.kind, ...data, urgent: !!data.urgent, page: location.pathname }) });
        const body = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(body.error || 'Something went wrong sending this. Please try again.');
        const done = document.createElement('div');
        done.className = 'form-done'; done.setAttribute('role', 'status'); done.tabIndex = -1;
        done.innerHTML = form.dataset.kind === 'support'
          ? '<h3>Got it</h3><p>Your message is with the Spotlight team. We reply by email, usually within one business day, and faster on show days.</p>'
          : '<h3>Request sent</h3><p>Thanks! We\'ll email you to set up your organization and answer any questions. Most organizations are ready the same day.</p>';
        form.replaceWith(done); done.focus();
      } catch (x) {
        msg.textContent = x.message === 'Failed to fetch' ? 'Couldn\'t reach Spotlight. Check your connection and try again.' : x.message; msg.classList.add('err');
        btn.disabled = false; btn.textContent = label;
      }
    });
  });

  // ---------- docs: filter, and highlight where you are
  const toc = $('.toc');
  if (toc) {
    const links = $$('nav a', toc), secs = links.map(a => $(a.getAttribute('href'))).filter(Boolean);
    $('button', toc)?.addEventListener('click', () => toc.classList.toggle('open'));
    const q = $('input', toc);
    q?.addEventListener('input', () => {
      const v = q.value.trim().toLowerCase();
      links.forEach((a, i) => { const s = secs[i]; const hit = !v || a.textContent.toLowerCase().includes(v) || (s && s.textContent.toLowerCase().includes(v)); a.hidden = !hit; if (s) s.hidden = !hit; });
      $$('.group', toc).forEach(g => { let el = g.nextElementSibling, any = false; while (el && !el.classList.contains('group')) { if (!el.hidden) any = true; el = el.nextElementSibling; } g.hidden = !any; });
      $('.doc .empty')?.toggleAttribute('hidden', links.some(a => !a.hidden));
    });
    const spy = () => {
      let cur = secs[0];
      for (const s of secs) if (!s.hidden && s.getBoundingClientRect().top < 140) cur = s;
      links.forEach(a => a.classList.toggle('on', cur && a.getAttribute('href') === '#' + cur.id));
    };
    addEventListener('scroll', spy, { passive: true }); spy();
    links.forEach(a => a.addEventListener('click', () => toc.classList.remove('open')));
  }
})();

(() => {
  const POLL_MS = 5000;
  let currentUser = null;
  let poller = null;

  const el = (id) => document.getElementById(id);

  // Utility strings for the markup this file generates. Named constants because
  // these are built as HTML strings — there is no element in admin.html to hang
  // classes on — and because several are used from more than one place.
  // State (selected tab, visible panel, closed button, chip tier) rides on data
  // attributes so Tailwind's data-* / group-data-* variants can style it: an
  // attribute selector outranks the base utilities, whereas a second competing
  // utility would be resolved by compiled source order, which is arbitrary.
  const RIPPLE = 'pointer-events-none absolute animate-ripple rounded-full bg-[rgba(23,17,10,0.35)]';
  const ENTRY = 'flex justify-between border-b border-line px-3.5 py-3 text-[13px] last:border-b-0';
  const ENTRY_TIME = 'tabular-nums text-fg';
  const PILL = 'inline-flex items-center gap-[7px] rounded-full border border-line bg-ink-800 py-[7px] pr-3 pl-2 text-[13px]';
  const PILL_COUNT = 'tabular-nums text-amber-300';
  const INVITE_ROW = 'flex items-center justify-between gap-2.5 border-b border-line py-2.5 text-[13px] tabular-nums last:border-b-0';
  const INVITE_CODE = 'tracking-[0.03em] text-fg';
  const EMPTY = 'p-4 text-[13px] text-fg-muted';
  // The admin console's phase cards are the compact variant of the public
  // tracker's — same idea: the range is the card, the tiers are rows inside it.
  const PHASE_CARD = 'group overflow-hidden rounded-xl border border-line bg-ink-950 '
    + 'data-featured:border-amber-500 data-passed:opacity-45';
  const PHASE_HEAD = 'flex cursor-pointer list-none items-center gap-2 px-3 py-1.5 '
    + 'hover:bg-ink-900 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-400 '
    + 'group-data-featured:bg-[rgba(242,169,59,0.08)] [&::-webkit-details-marker]:hidden';
  const PHASE_LEAD = 'text-[11px] tabular-nums text-fg-muted group-data-featured:text-amber-300';
  const PHASE_CARET = 'shrink-0 text-fg-faint transition-transform duration-200 group-open:rotate-180';
  const PHASE_NUM = 'inline-flex size-[18px] shrink-0 items-center justify-center rounded-full border border-line text-[9px] tabular-nums text-fg-faint '
    + 'group-data-featured:border-amber-500 group-data-featured:text-amber-300';
  const PHASE_RANGE = 'text-[13px] font-semibold tracking-[-0.01em] text-fg group-data-featured:text-amber-300 '
    + 'group-data-passed:line-through group-data-passed:decoration-fg-faint';
  const PHASE_META = 'ml-auto text-[10px] tabular-nums text-fg-faint';
  const TIER_ROW = 'flex items-center gap-2 border-t border-line px-3 py-1.5';
  // The wildcard goes between the cards — see the note in public.js.
  // Hidden while its own phase is collapsed — see the note in public.js.
  const WILD_LINK = 'mx-4 hidden [details[open]+&]:flex items-center gap-2 border-l-2 border-dashed border-line py-1 pl-3';
  const WILD_TIME = 'w-[60px] shrink-0 text-[12px] font-semibold tabular-nums text-fg-muted';
  const WILD_SUB = 'min-w-0 flex-1 truncate text-[10px] text-fg-faint';
  const WILD_BADGE = 'shrink-0 rounded-full border border-dashed border-line px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-fg-faint';
  const TIER_TIME = 'w-[64px] shrink-0 text-[13px] font-semibold tabular-nums text-fg data-next:text-amber-300';
  const TIER_SUB = 'min-w-0 flex-1 truncate text-[10px] text-fg-faint';
  const TIER_BADGE = 'shrink-0 rounded-full border border-line px-2 py-0.5 text-[9px] uppercase tracking-[0.08em] text-fg-muted '
    + 'data-next:border-amber-500 data-next:text-amber-300';

  // Toggles a boolean data attribute — the app's standard way of carrying UI
  // state now that Tailwind variants do the styling.
  function setFlag(target, name, on) {
    if (!target) return;
    if (on) target.dataset[name] = '';
    else delete target.dataset[name];
  }
  const tooltip = Tracker.attachTooltip(el('tooltip'));
  const themeButtons = [el('themeToggleAuth'), el('themeToggleApp')];
  Tracker.initThemeToggle(themeButtons);

  const URGENT_THRESHOLD_S = 60;

  // Alerts, same thresholds as the public tracker. The console gets toasts and
  // desktop notifications rather than modals — it already has a toast rail, and
  // a modal over a working dashboard is an interruption, not a flourish.
  Tracker.initNotifyToggle(el('notifyToggle'), (on, permission) => {
    if (permission === 'denied') showToast('Your browser is blocking notifications for this site.');
    else showToast(on ? 'Roam alerts on — heads-up at 1 min and 30 s.' : 'Roam alerts off.');
  });

  const checkCountdownAlert = Tracker.createCountdownAlerter((threshold, secondsLeft, window_) => {
    const title = threshold >= 60 ? 'HR roam in ~1 minute' : 'HR roam in ~30 seconds';
    Tracker.notify(title, `${window_.label} window · ${window_.targetLabel}`, 'countdown');
    showToast(`Heads up — predicted roam at ${window_.targetLabel}, in ${threshold >= 60 ? '1 minute' : '30 seconds'}.`, { fire: true });
  });

  const checkPrediction = Tracker.createPredictionWatcher({
    onHit: (line, count) => {
      Tracker.notify('Called it — HR showed up', line, 'outcome');
      showToast(`Prediction hit · ${count} sighting${count === 1 ? '' : 's'} in the window`);
    },
    onMiss: (line) => {
      Tracker.notify('Wrong prediction', line, 'outcome');
      showToast('Prediction missed — nobody roamed in that window');
    },
  });
  let timer3d = null;
  function isDarkTheme() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function startTimer3D() { timer3d = window.Timer3D.init(el('countdownCanvas'), '--:--:--'); timer3d.setTheme(isDarkTheme()); }
  if (window.Timer3D) startTimer3D();
  else window.addEventListener('timer3d-ready', startTimer3D, { once: true });
  themeButtons.forEach((b) => b.addEventListener('click', () => { if (timer3d) timer3d.setTheme(isDarkTheme()); }));

  // { fire: true } is the urgent variant, reserved for the countdown alerts.
  function showToast(msg, opts) {
    Tracker.toast(el('toastHost'), msg, opts);
  }

  // Every load, no memory of the last one — see initAdvisory in viz.js. Shown
  // when the console appears rather than at boot: over the sign-in form it would
  // be advice about a button the reader cannot see yet.
  const advisory = Tracker.initAdvisory();
  function showAuthError(msg) {
    const box = el('authError');
    box.textContent = msg;
    box.style.display = 'block';
  }
  function clearAuthError() {
    el('authError').style.display = 'none';
  }

  // ---- bootstrap (first-run) registration ----
  // Mirrors a first-run flow like Coolify's: while no admin exists yet,
  // registration needs no invite code and the registrant becomes admin.
  async function applyBootstrapUI() {
    let needsBootstrap = false;
    try {
      ({ needsBootstrap } = await Tracker.api('/auth/register-status'));
    } catch (e) { /* fall back to requiring an invite, the safe default */ }
    el('inviteFieldGroup').style.display = needsBootstrap ? 'none' : '';
    el('bootstrapNotice').style.display = needsBootstrap ? '' : 'none';
    if (needsBootstrap) setAuthTab('register');
  }

  // ---- auth tabs ----
  function setAuthTab(tab) {
    const isSignIn = tab === 'signin';
    setFlag(el('tabSignIn'), 'active', isSignIn);
    setFlag(el('tabRegister'), 'active', !isSignIn);
    setFlag(el('signInPane'), 'active', isSignIn);
    setFlag(el('registerPane'), 'active', !isSignIn);
    clearAuthError();
  }
  el('tabSignIn').addEventListener('click', () => setAuthTab('signin'));
  el('tabRegister').addEventListener('click', () => setAuthTab('register'));

  el('signInPane').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();
    try {
      const data = await Tracker.api('/auth/login', {
        method: 'POST',
        body: { name: el('siName').value.trim(), password: el('siPassword').value },
      });
      currentUser = data;
      switchToApp();
    } catch (err) { showAuthError(err.message); }
  });

  el('registerPane').addEventListener('submit', async (e) => {
    e.preventDefault();
    clearAuthError();
    try {
      const data = await Tracker.api('/auth/register', {
        method: 'POST',
        body: {
          name: el('regName').value.trim(),
          password: el('regPassword').value,
          inviteCode: el('regInvite').value.trim(),
        },
      });
      currentUser = data;
      switchToApp();
    } catch (err) { showAuthError(err.message); }
  });

  el('logoutBtn').addEventListener('click', async () => {
    await Tracker.api('/auth/logout', { method: 'POST' });
    currentUser = null;
    if (poller) poller.stop();
    ticker.stop();
    switchToAuth();
  });

  // ---- log / undo ----
  el('logBtn').addEventListener('click', async (e) => {
    if (logging) return;
    // Belt and braces, as on the public page: the button is disabled out of
    // hours, but a click that slips through must not post either.
    if (workHours && !Tracker.workHoursState(timeZone, workHours).open) {
      showToast('Logging is closed right now.');
      return;
    }
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = RIPPLE;
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);

    logging = true;
    btn.disabled = true;
    try {
      const data = await Tracker.api('/sightings', { method: 'POST' });
      if (data.alreadyLogged) showToast('You already logged this one.');
      else if (data.merged) showToast('Merged with a sighting logged moments ago by someone else.');
      else showToast('Sighting logged.');
      await refresh();
    } catch (err) {
      showToast(err.message);
    } finally {
      logging = false;
      syncLogButton();
    }
  });

  el('undoBtn').addEventListener('click', async () => {
    try {
      await Tracker.api('/sightings/mine/latest', { method: 'DELETE' });
      showToast('Undone.');
      await refresh();
    } catch (err) { showToast(err.message); }
  });

  // ---- invites (admin only) ----
  el('genInviteBtn').addEventListener('click', async () => {
    try {
      const data = await Tracker.api('/auth/invites', { method: 'POST' });
      await loadInvites();
      showToast('New invite code: ' + data.code);
    } catch (err) { showToast(err.message); }
  });

  async function loadInvites() {
    const data = await Tracker.api('/auth/invites');
    const list = el('inviteList');
    if (data.invites.length === 0) {
      list.innerHTML = `<p class="${EMPTY}">No invites yet.</p>`;
      return;
    }
    list.innerHTML = data.invites.map((i) => {
      const used = !!i.used_by;
      return `<div class="${INVITE_ROW}"><span class="${INVITE_CODE}">${i.code}</span>`
        + `<span class="${used ? 'text-fg-faint' : 'text-good'}">${used ? 'used by ' + i.used_by : 'unused'}</span></div>`;
    }).join('');
  }

  // ---- tabs ----
  // Selected by attribute, not by class: the buttons and panels carry
  // data-tab / data-active rather than component classes.
  document.querySelectorAll('[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-tab]').forEach((b) => setFlag(b, 'active', false));
      document.querySelectorAll('[id^="panel-"]').forEach((p) => setFlag(p, 'active', false));
      setFlag(btn, 'active', true);
      setFlag(el('panel-' + btn.dataset.tab), 'active', true);
    });
  });

  // ---- rendering ----
  async function renderList(sightings) {
    const list = el('logList');
    if (sightings.length === 0) {
      list.innerHTML = `<div class="${EMPTY}">No entries yet.</div>`;
      return;
    }
    // Render in the server's configured TIMEZONE, not the viewer's own browser
    // timezone — otherwise this list can disagree with the heatmap (which is
    // always TIMEZONE-bucketed) badly enough to show a different weekday.
    const timeZone = await Tracker.getTimezone();
    list.innerHTML = sightings.map((s) => {
      const d = new Date(s.ts * 1000);
      const label = d.toLocaleString(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `<div class="${ENTRY}"><time class="${ENTRY_TIME}">${label}</time>`
        + `<span class="text-fg-muted">${s.logged_by}</span></div>`;
    }).join('');
  }

  let timeZone = 'UTC';
  let workHours = null; // the office's logging window, from /api/config
  let countdownOverride = null; // COUNTDOWN_OVERRIDE_MS, testing only
  let featured = null; // the currently-featured tier window, updated every poll

  // Same gate as the public tracker's "I see them" button: a sighting can only
  // be logged during the office's working day (services/work-hours.js). Driven
  // off the one-second ticker, so a console left open past closing time
  // disables its own button rather than going stale.
  let logging = false;
  function syncLogButton() {
    if (!workHours) return;
    const { open, label } = Tracker.workHoursState(timeZone, workHours);
    el('logBtn').disabled = !open || logging;
    setFlag(el('logBtn'), 'closed', !open);
    el('logHint').textContent = open ? '' : label;
    if (typeof Icons !== 'undefined') {
      Icons.set(el('logBtnIcon'), open ? 'eye' : 'lock-simple');
      if (!open) el('logHint').innerHTML = Icons.svg('clock-countdown') + ' ' + label;
    }
    el('logBtnLabel').textContent = open ? 'Log sighting' : 'Logging closed';
  }

  // Ticks every second: shows a live countdown to the featured window's start,
  // or "HAPPENING NOW" while inside it — independent of the 5s data poll.
  // Under 60s remaining, the 3D digits pulse red for urgency.
  function tickCountdown() {
    syncLogButton();
    if (!featured) return;
    // The override wins over "happening now" — see the note in public.js.
    if (featured.active && !countdownOverride) {
      el('countdownCanvas').style.display = 'none';
      el('countdownNow').style.display = 'block';
      el('countdownSr').textContent = 'Happening now';
      return;
    }
    el('countdownCanvas').style.display = 'block';
    el('countdownNow').style.display = 'none';
    // To the exact predicted moment — see the note in public.js.
    const secondsLeft = countdownOverride
      ? countdownOverride.secondsLeft()
      : Tracker.secondsUntilPrediction(featured, timeZone, workHours);
    checkCountdownAlert(featured, secondsLeft);
    const text = Tracker.formatCountdown(secondsLeft);
    el('countdownSr').textContent = text;
    if (timer3d) {
      timer3d.setText(text);
      timer3d.setUrgent(secondsLeft > 0 && secondsLeft < URGENT_THRESHOLD_S);
    }
  }
  const ticker = Tracker.createTicker(tickCountdown);

  // Returns the classified windows so refresh() can feed the outcome watcher
  // without classifying a second time.
  async function renderTiers(stats) {
    const config = await Tracker.getConfig();
    timeZone = config.timezone;
    workHours = config.workHours;
    if (config.countdownOverrideMs && !countdownOverride) {
      countdownOverride = Tracker.createCountdownOverride(config.countdownOverrideMs);
      const note = el('countdownOverrideNote');
      note.textContent = `Countdown overridden for testing — ${Math.round(config.countdownOverrideMs / 1000)}s from page load`;
      note.style.display = 'inline-flex';
    }
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone, workHours);
    const chips = el('tierChips');

    if (windows.length === 0) {
      featured = null;
      el('featuredTierLabel').textContent = 'Not enough data yet';
      el('countdownSr').textContent = '--:--:--';
      if (timer3d) { timer3d.setText('--:--:--'); timer3d.setUrgent(false); }
      el('windowLabel').textContent = '';
      el('featuredDetail').textContent = 'Log a few sightings to see a pattern emerge.';
      chips.innerHTML = '';
      return windows;
    }

    featured = windows.find((w) => w.featured);
    el('featuredTierLabel').textContent = `Next roam phase${featured.dayLabel ? ` · ${featured.dayLabel}` : ''}`;
    el('windowLabel').textContent = `${featured.targetLabel}${featured.dayLabel ? ` ${featured.dayLabel}` : ''}`
      + ` · somewhere in ${featured.timeLabel}`;
    el('featuredDetail').textContent = !featured.todayIsWorkDay
      ? `No roams expected today — the pattern only turns up on work days. Next window ${featured.dayLabel || 'soon'}.`
      : featured.dayOffset > 0
        ? `Today's windows have passed — this pattern usually repeats ${featured.dayLabel}.`
        : featured.detail;
    tickCountdown();

    // Collapsed unless it is the phase in play, wildcard between the cards —
    // see the notes in public.js.
    const caret = typeof Icons !== 'undefined' ? Icons.svg('caret-down', { size: '0.8em' }) : '';
    const wildcardOf = (w) => w.tiers.find((t) => t.tier === 'wildcard');
    chips.innerHTML = windows.map((w, i) => `
      <details class="${PHASE_CARD}" ${w.featured ? 'open data-featured' : ''} ${w.passed && !w.featured ? 'data-passed' : ''}>
        <summary class="${PHASE_HEAD}">
          <span class="${PHASE_NUM}">${i + 1}</span>
          <span class="${PHASE_RANGE}">${w.timeLabel}</span>
          <span class="${PHASE_LEAD}">${w.targetLabel}</span>
          <span class="${PHASE_META}">${w.count ? `${w.count} logged` : w.badge}</span>
          <span class="${PHASE_CARET}">${caret}</span>
        </summary>
        ${w.tiers.filter((t) => t.tier !== 'wildcard').map((t) => `
          <div class="${TIER_ROW}">
            <span class="${TIER_TIME}" ${w.featured && t.tier === 'sure' ? 'data-next' : ''}>${t.targetLabel}</span>
            <span class="${TIER_SUB}">${t.from ? `${t.from} in the ${t.quarter} stretch` : `${t.quarter} midpoint`}</span>
            <span class="${TIER_BADGE}" ${w.featured && t.tier === 'sure' ? 'data-next' : ''}>${t.label}</span>
          </div>
        `).join('')}
      </details>
      ${wildcardOf(w) ? `
        <div class="${WILD_LINK}" data-wildcard>
          <span class="${WILD_TIME}">${wildcardOf(w).targetLabel}</span>
          <span class="${WILD_SUB}">${wildcardOf(w).note || 'projected from the usual gap'}</span>
          <span class="${WILD_BADGE}">${wildcardOf(w).label}</span>
        </div>` : ''}
    `).join('');
    return windows;
  }

  function renderByPerson(byPerson) {
    const wrap = el('byPerson');
    const names = Object.keys(byPerson || {});
    if (names.length === 0) {
      wrap.innerHTML = `<span class="text-[13px] text-fg-muted">No entries yet.</span>`;
      return;
    }
    wrap.innerHTML = names
      .sort((a, b) => byPerson[b] - byPerson[a])
      .map((n) => `<span class="${PILL}">${n} <span class="${PILL_COUNT}">${byPerson[n]}</span></span>`)
      .join('');
  }

  async function refresh() {
    const [{ sightings }, stats] = await Promise.all([
      Tracker.api('/sightings'),
      Tracker.api('/sightings/stats'),
    ]);
    await renderList(sightings);
    Tracker.renderHeatmap(el('heatmapGrid'), stats.heatmap, tooltip);
    const windows = await renderTiers(stats);
    checkPrediction(windows, stats.total, Tracker.windowPhase(windows.find((w) => w.featured), timeZone));
    renderByPerson(stats.byPerson);
    el('totalStat').textContent = stats.total;
    el('peakStat').textContent = Tracker.peakLabel(stats);
  }

  function switchToApp() {
    el('authView').style.display = 'none';
    el('appView').style.display = 'block';
    el('whoamiText').textContent = currentUser.name;
    el('invitesTabBtn').style.display = currentUser.isAdmin ? '' : 'none';
    if (currentUser.isAdmin) loadInvites();
    poller = Tracker.createPoller(refresh, POLL_MS);
    poller.start();
    ticker.start();
    // Here rather than at boot: the console is only now on screen, and the
    // advice is about its log button.
    if (advisory) advisory.show();
  }
  function switchToAuth() {
    el('appView').style.display = 'none';
    el('authView').style.display = 'block';
    ['siName', 'siPassword', 'regName', 'regPassword', 'regInvite'].forEach((id) => { el(id).value = ''; });
    applyBootstrapUI();
  }

  (async () => {
    try {
      currentUser = await Tracker.api('/auth/me');
      switchToApp();
    } catch (e) {
      switchToAuth();
    }
  })();
})();

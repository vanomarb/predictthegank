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
  const ENTRY = 'flex items-center justify-between gap-2.5 border-b border-line px-3.5 py-3 text-[13px] last:border-b-0';
  const ENTRY_TIME = 'tabular-nums text-fg';
  const ENTRY_LEFT = 'flex min-w-0 items-center gap-2.5';
  const ENTRY_RIGHT = 'flex shrink-0 items-center gap-2.5';
  const ROW_CHECK = 'log-row-check shrink-0 cursor-pointer accent-amber-500';
  const ROW_DELETE = 'log-row-delete inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-full '
    + 'border border-transparent text-fg-faint transition-colors duration-150 hover:border-bad hover:text-bad '
    + 'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-amber-400';
  const PILL = 'inline-flex items-center gap-[7px] rounded-full border border-line bg-ink-800 py-[7px] pr-3 pl-2 text-[13px]';
  const PILL_COUNT = 'tabular-nums text-amber-300';
  const INVITE_ROW = 'flex items-center justify-between gap-2.5 border-b border-line py-2.5 text-[13px] tabular-nums last:border-b-0';
  const INVITE_CODE = 'tracking-[0.03em] text-fg';
  const EMPTY = 'p-4 text-[13px] text-fg-muted';
  // The admin console's phase cards are the compact variant of the public
  // tracker's — same idea: the range is the card, the tiers are rows inside it.
  const PHASE_CARD = 'group overflow-hidden rounded-xl border border-line bg-ink-950 '
    + 'data-featured:border-amber-500 data-passed:opacity-70';
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
  // Whether each predicted moment landed — see the note in public.js. The
  // console shows them too: it is where the person most likely to care whether
  // the pattern is holding up actually works.
  const VERDICT = 'shrink-0 rounded-full border px-1.5 py-px text-[8px] font-semibold uppercase tracking-[0.08em]';
  const VERDICT_HIT = `${VERDICT} border-good bg-[rgba(var(--status-good-rgb),0.12)] text-good`;
  const VERDICT_MISS = `${VERDICT} border-bad bg-[rgba(var(--status-bad-rgb),0.12)] text-bad`;

  function verdictBadge(row) {
    const outcome = Tracker.momentOutcome(row, activeMinutes(), activeNowMin(), featured || {});
    if (!outcome) return '';
    return outcome === 'hit'
      ? `<span class="${VERDICT_HIT}">Hit</span>`
      : `<span class="${VERDICT_MISS}">Missed</span>`;
  }

  // The wildcard goes between the cards — see the note in public.js.
  // Hidden while its own phase is collapsed, unless `data-force` — see the
  // fuller note on WILD_LINK in public.js.
  const WILD_LINK = 'mx-4 hidden [details[open]+&]:flex data-force:flex items-center gap-2 border-l-2 border-dashed border-line py-1 pl-3';
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

  // One pair of alerts per predicted moment — see the note in public.js.
  const checkCountdownAlert = Tracker.createCountdownAlerter((threshold, secondsLeft, entry) => {
    const { moment, window: w } = entry;
    const title = threshold >= 60 ? 'HR roam in ~1 minute' : 'HR roam in ~30 seconds';
    const strength = typeof moment.pct === 'number' ? ` (${moment.pct}%)` : '';
    Tracker.notify(title, `${moment.targetLabel} · ${moment.label}${strength} · ${w.timeLabel}`, 'countdown');
    showToast(`Heads up — ${moment.label.toLowerCase()} roam predicted at ${moment.targetLabel}, `
      + `in ${threshold >= 60 ? '1 minute' : '30 seconds'}.`, { fire: true });
  });

  const checkPrediction = Tracker.createPredictionWatcher({
    onHit: (line, hits, moments) => {
      Tracker.notify('Called it — HR showed up', line, 'outcome');
      showToast(`Prediction hit · ${hits} of ${moments} predicted times landed`);
    },
    onMiss: (line) => {
      Tracker.notify('Wrong prediction', line, 'outcome');
      showToast('Prediction missed — nothing logged on a predicted minute');
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
      if (data.alreadyLogged) {
        showToast('You already logged this one.');
      } else {
        // Immediate verdict on THIS log, same rule as the badges — not the
        // phase-close sweep's recap of the whole hour, but "did what I just
        // did land on a predicted minute," told right away. No modal here —
        // the console gets toasts and notifications, see the note above.
        const { hit, line } = Tracker.loggedOutcome(phases, Tracker.nowMinutes(timeZone));
        showToast(data.merged ? `Merged with a sighting logged moments ago — ${line}` : line);
        Tracker.notify(hit ? 'Called it — HR showed up' : 'Wrong prediction', line, 'outcome');
      }
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
      // Lazily, and once. The config panel costs a live call to the provider to
      // list models, and most sessions never open it.
      if (btn.dataset.tab === 'config' && !cfLoaded) {
        loadConfig();
        loadConfigLists();
      }
    });
  });

  // ---- rendering ----
  // Which rows the admin has checked for bulk delete. Module-scoped, not tied
  // to one renderList call, because the 5s poller rebuilds #logList's markup
  // out from under any mid-selection checkboxes — same problem openState
  // solves for the phase cards above.
  const selectedLogIds = new Set();

  function syncLogBulkBar() {
    if (!currentUser || !currentUser.isAdmin) return;
    const rowChecks = [...el('logList').querySelectorAll('.log-row-check')];
    const checkedCount = selectedLogIds.size;
    const delBtn = el('logDeleteSelectedBtn');
    delBtn.disabled = checkedCount === 0;
    delBtn.textContent = checkedCount > 0 ? `Delete selected (${checkedCount})` : 'Delete selected';
    const selectAll = el('logSelectAll');
    selectAll.checked = rowChecks.length > 0 && checkedCount === rowChecks.length;
    selectAll.indeterminate = checkedCount > 0 && checkedCount < rowChecks.length;
  }

  async function renderList(sightings) {
    const list = el('logList');
    // Drop selections for rows that no longer exist (deleted elsewhere, or
    // aged off the 500-row window) so a stale id can't ride along into a
    // future bulk delete.
    const liveIds = new Set(sightings.map((s) => s.id));
    for (const id of selectedLogIds) if (!liveIds.has(id)) selectedLogIds.delete(id);

    if (sightings.length === 0) {
      list.innerHTML = `<div class="${EMPTY}">No entries yet.</div>`;
      syncLogBulkBar();
      return;
    }
    // Render in the server's configured TIMEZONE, not the viewer's own browser
    // timezone — otherwise this list can disagree with the heatmap (which is
    // always TIMEZONE-bucketed) badly enough to show a different weekday.
    const timeZone = await Tracker.getTimezone();
    const isAdmin = !!(currentUser && currentUser.isAdmin);
    const xIcon = typeof Icons !== 'undefined' ? Icons.svg('x', { size: '0.85em' }) : '×';
    list.innerHTML = sightings.map((s) => {
      const d = new Date(s.ts * 1000);
      const label = d.toLocaleString(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      const checked = selectedLogIds.has(s.id) ? ' checked' : '';
      return `<div class="${ENTRY}">`
        + `<div class="${ENTRY_LEFT}">`
        + (isAdmin ? `<input type="checkbox" class="${ROW_CHECK}" data-id="${s.id}"${checked}>` : '')
        + `<time class="${ENTRY_TIME}">${label}</time></div>`
        + `<div class="${ENTRY_RIGHT}"><span class="text-fg-muted">${s.logged_by}</span>`
        + (isAdmin ? `<button type="button" class="${ROW_DELETE}" data-id="${s.id}" aria-label="Delete entry">${xIcon}</button>` : '')
        + `</div></div>`;
    }).join('');
    syncLogBulkBar();
  }

  // Delegated on the container, not per-row: renderList rebuilds #logList's
  // innerHTML on every 5s poll, which would silently drop per-element listeners.
  el('logList').addEventListener('change', (e) => {
    const cb = e.target.closest('.log-row-check');
    if (!cb) return;
    const id = Number(cb.dataset.id);
    if (cb.checked) selectedLogIds.add(id); else selectedLogIds.delete(id);
    syncLogBulkBar();
  });

  el('logList').addEventListener('click', async (e) => {
    const btn = e.target.closest('.log-row-delete');
    if (!btn) return;
    const id = Number(btn.dataset.id);
    if (!window.confirm('Delete this entry? This cannot be undone.')) return;
    try {
      await Tracker.api(`/sightings/${id}`, { method: 'DELETE' });
      selectedLogIds.delete(id);
      showToast('Entry deleted.');
      await refresh();
    } catch (err) { showToast(err.message); }
  });

  el('logSelectAll').addEventListener('change', (e) => {
    const rowChecks = [...el('logList').querySelectorAll('.log-row-check')];
    rowChecks.forEach((cb) => {
      cb.checked = e.target.checked;
      const id = Number(cb.dataset.id);
      if (e.target.checked) selectedLogIds.add(id); else selectedLogIds.delete(id);
    });
    syncLogBulkBar();
  });

  el('logDeleteSelectedBtn').addEventListener('click', async () => {
    const ids = [...selectedLogIds];
    if (ids.length === 0) return;
    if (!window.confirm(`Delete ${ids.length} selected ${ids.length === 1 ? 'entry' : 'entries'}? This cannot be undone.`)) return;
    try {
      await Tracker.api('/sightings', { method: 'DELETE', body: { ids } });
      selectedLogIds.clear();
      showToast('Entries deleted.');
      await refresh();
    } catch (err) { showToast(err.message); }
  });

  let timeZone = 'UTC';
  let workHours = null; // the office's logging window, from /api/config
  let countdownOverride = null; // COUNTDOWN_OVERRIDE_MS, testing only
  let featured = null; // the phase owning the next predicted moment
  let phases = []; // the day's phases, refreshed each poll — the ticker reads this
  let todayMinutes = []; // today's sightings, minutes since midnight — drives the hit/miss badges
  // Cards the reader opened or closed by hand — see the note in public.js.
  const openState = new Map();

  // ---- day filter (Recent work days row) — see the fuller note in public.js ----
  // Picking a day swaps the phase cards for THAT day's own frozen phases (see
  // phase_history / snapshotTodayPhases in routes/sightings.js) rather than
  // re-coloring today's live cards — a past day's own predicted times can
  // genuinely differ from today's, since the pattern moves as new sightings
  // come in. The live countdown/hero stays untouched, always about today.
  let selectedDate = null;
  let dayHistory = []; // this poll's Recent work days entries

  function activeDay() {
    if (!selectedDate) return null;
    return dayHistory.find((d) => d.date === selectedDate) || null;
  }
  function activeMinutes() {
    const day = activeDay();
    return day ? day.minutes : todayMinutes;
  }
  function activeNowMin() {
    const day = activeDay();
    return day && !day.today ? 1440 : Tracker.nowMinutes(timeZone);
  }
  // Whichever windows the phase cards should show right now — see the fuller
  // note in public.js. Re-evaluated on every render so a frozen selection
  // survives the 5s poll instead of being overwritten by it.
  function activeCardsWindows() {
    const day = activeDay();
    return day && Array.isArray(day.windows)
      ? Tracker.classifyFinishedDay(Tracker.normalizeWindows({ windows: day.windows, smartWindows: day.smartWindows }))
      : phases;
  }
  function onDaySelect(date) {
    // Clicking the already-selected day releases it back to today's live
    // cards — there is no separate "today" button to click back to.
    selectedDate = selectedDate === date ? null : date;
    renderPhaseCards(activeCardsWindows());
    Tracker.renderDayTimeline(el('dayTimeline'), dayHistory, selectedDate, onDaySelect);
  }

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

  // A fact about the page, not about one window — see public.js.
  const dayDone = () => !!(phases[0] && phases[0].dayDone);

  // Ticks every second: shows a live countdown to the featured window's start,
  // or "HAPPENING NOW" while inside it — independent of the 5s data poll.
  // Under 60s remaining, the 3D digits pulse red for urgency.
  function tickCountdown() {
    syncLogButton();
    // Every predicted moment, not just the sure one — see the note in public.js.
    const next = Tracker.nextMoment(phases, timeZone, workHours);
    if (!next) return;
    if (next.window !== featured) featured = next.window;

    // Today's predictions are spent but the day is not — see public.js.
    if (dayDone() && !countdownOverride) {
      const tally = Tracker.dayTally(phases, todayMinutes, Tracker.nowMinutes(timeZone));
      const landed = `${tally.hits} of ${tally.total} landed`;
      el('countdownCanvas').style.display = 'none';
      el('countdownNow').style.display = 'none';
      el('dayDoneNote').style.display = 'block';
      el('featuredTierLabel').textContent = 'Today\u2019s roams · all done';
      el('windowLabel').textContent = `${landed} · ${tally.logged} logged today`;
      el('countdownSr').textContent = `No predicted roams left today. ${landed}.`;
      if (timer3d) { timer3d.setText('--:--:--'); timer3d.setUrgent(false); }
      return;
    }
    el('dayDoneNote').style.display = 'none';
    const { moment, window: w, dayLabel } = next;
    const pct = typeof moment.pct === 'number' ? ` · ${moment.pct}%` : '';
    el('windowLabel').textContent = `${moment.targetLabel}${dayLabel ? ` ${dayLabel}` : ''}`
      + ` · ${moment.label}${pct} · ${w.timeLabel}`;

    // The override wins over "happening now" — see the note in public.js.
    if (next.now && !countdownOverride) {
      el('countdownCanvas').style.display = 'none';
      el('countdownNow').style.display = 'block';
      el('countdownSr').textContent = 'Happening now';
      return;
    }
    el('countdownCanvas').style.display = 'block';
    el('countdownNow').style.display = 'none';
    const secondsLeft = countdownOverride
      ? countdownOverride.secondsLeft()
      : Tracker.secondsUntilTarget(moment.targetSec, timeZone, workHours);
    checkCountdownAlert(next, secondsLeft);
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
    todayMinutes = Array.isArray(stats.todayMinutes) ? stats.todayMinutes : [];
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone, workHours, todayMinutes);
    phases = windows;
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
    el('featuredDetail').textContent = featured.dayDone
      ? 'Every predicted time has been and gone, but the day has not — logging '
        + 'stays open. Tonight\u2019s analysis rebuilds these phases.'
      : !featured.todayIsWorkDay
      ? `No roams expected today — the pattern only turns up on work days. Next window ${featured.dayLabel || 'soon'}.`
      : featured.dayOffset > 0
        ? `Today's windows have passed — this pattern usually repeats ${featured.dayLabel}.`
        : featured.detail;
    tickCountdown();

    renderPhaseCards(activeCardsWindows());
    return windows;
  }

  // Just the cards: hourStart/tiers/badges, nothing about the hero above them.
  // Split out of renderTiers so the "Recent work days" filter (onDaySelect)
  // can swap these for a picked day's own frozen phases without touching the
  // live countdown, which stays about today no matter what day is selected.
  function renderPhaseCards(windows) {
    const chips = el('tierChips');
    // Collapsed unless it is the phase in play, wildcard between the cards —
    // see the notes in public.js.
    const caret = typeof Icons !== 'undefined' ? Icons.svg('caret-down', { size: '0.8em' }) : '';
    const wildcardOf = (w) => w.tiers.find((t) => t.tier === 'wildcard');
    // A card the reader opened must survive the poll's rebuild — see public.js.
    // w.highlight, not w.featured — see public.js.
    const isOpen = (w) => (openState.has(w.hourStart) ? openState.get(w.hourStart) : w.highlight);
    chips.innerHTML = windows.map((w, i) => `
      <details class="${PHASE_CARD}" data-hour="${w.hourStart}" ${isOpen(w) ? 'open' : ''} ${w.highlight ? 'data-featured' : ''} ${w.struck ? 'data-passed' : ''}>
        <summary class="${PHASE_HEAD}">
          <span class="${PHASE_NUM}">${i + 1}</span>
          <span class="${PHASE_RANGE}">${w.timeLabel}</span>
          <span class="${PHASE_LEAD}">${w.targetLabel}</span>
          <span class="${PHASE_META}">${w.count ? `${w.count} logged` : w.badge}</span>
          ${w.isSmart && typeof Icons !== 'undefined'
            ? `<span class="inline-flex shrink-0 items-center text-amber-400" data-ai`
              + ` title="Predicted by AI · ${w.confidence}% confident">`
              + `${Icons.svg('sparkle', { size: '0.9em' })}</span>`
            : ''}
          <span class="${PHASE_CARET}">${caret}</span>
        </summary>
        ${w.tiers.filter((t) => t.tier !== 'wildcard').map((t) => `
          <div class="${TIER_ROW}">
            <span class="${TIER_TIME}" ${w.highlight && t.tier === 'sure' ? 'data-next' : ''}>${t.targetLabel}</span>
            <span class="${TIER_SUB}">${t.source === 'ai'
              ? 'AI-picked minute'
              : (t.from ? `${t.from} in the ${t.quarter} stretch` : `${t.quarter} midpoint`)}</span>
            ${verdictBadge(t)}
            <span class="${TIER_BADGE}" ${w.highlight && t.tier === 'sure' ? 'data-next' : ''}>${t.label}</span>
          </div>
        `).join('')}
      </details>
      ${wildcardOf(w) ? `
        <div class="${WILD_LINK}" data-wildcard ${w.wildcardFeatured ? 'data-force' : ''}>
          <span class="${WILD_TIME}">${wildcardOf(w).targetLabel}</span>
          <span class="${WILD_SUB}">${wildcardOf(w).note || 'projected from the usual gap'}</span>
          ${verdictBadge(wildcardOf(w))}
          <span class="${WILD_BADGE}">${wildcardOf(w).label}</span>
        </div>` : ''}
    `).join('');

    // The summary's click, not the card's `toggle` — see public.js.
    chips.querySelectorAll('details[data-hour]').forEach((card) => {
      card.querySelector('summary').addEventListener('click', () => {
        openState.set(Number(card.dataset.hour), !card.open);
      });
    });
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
    dayHistory = Array.isArray(stats.history) ? stats.history : [];
    const windows = await renderTiers(stats);
    // Same inputs the badges use — see the note in public.js.
    checkPrediction(windows, todayMinutes, Tracker.nowMinutes(timeZone),
      { todayIsWorkDay: windows.length > 0 ? windows[0].todayIsWorkDay !== false : false });
    Tracker.renderDayTimeline(el('dayTimeline'), dayHistory, selectedDate, onDaySelect);
    renderByPerson(stats.byPerson);
    el('totalStat').textContent = stats.total;
    el('peakStat').textContent = Tracker.peakLabel(stats);
  }

  function switchToApp() {
    el('authView').style.display = 'none';
    el('appView').style.display = 'block';
    el('whoamiText').textContent = currentUser.name;
    el('invitesTabBtn').style.display = currentUser.isAdmin ? '' : 'none';
    el('logBulkBar').style.display = currentUser.isAdmin ? '' : 'none';
    if (currentUser.isAdmin) loadInvites();
    poller = Tracker.createPoller(refresh, POLL_MS);
    poller.start();
    ticker.start();
    // Here rather than at boot: the console is only now on screen, and the
    // advice is about its log button.
    if (advisory) advisory.show();
  }
  /* ============================ the Config tab ============================ */
  //
  // Every setting the prediction machinery runs on, editable, except two:
  // secrets, which are reported set/not-set and never read, and the cron
  // schedule, which lives in vercel.json and is deployed - a control for it here
  // would be lying.
  //
  // Each field says where its value came from - this form, the environment, or
  // the built-in default - because an admin whose env var appears to be ignored
  // needs to see that something here is overriding it.

  let cfLoaded = false;
  const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  const AGO_UNITS = [[60, 'second'], [60, 'minute'], [24, 'hour'], [7, 'day']];

  // "3 hours ago", from a unix timestamp in seconds. `brief` drops the absolute
  // time, which only earns its space in the wider slots.
  function agoLabel(seconds, brief) {
    if (!seconds) return 'never';
    let n = Math.max(0, Math.floor(Date.now() / 1000) - seconds);
    let unit = 'second';
    for (const [size, name] of AGO_UNITS) {
      if (n < size) { unit = name; break; }
      n = Math.floor(n / size);
      unit = name;
    }
    const rel = n === 0 ? 'just now' : `${n} ${unit}${n === 1 ? '' : 's'} ago`;
    if (brief) return rel;
    // 12-hour, office clock, like every other time the app shows.
    const abs = new Date(seconds * 1000).toLocaleString(undefined, {
      timeZone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    return `${rel} \u00b7 ${abs}`;
  }

  // One writer for the form's message, so a failure's colour can never be left
  // on the next success.
  function cfMsg(text, bad) {
    const box = el('cfMsg');
    box.textContent = text;
    box.className = `text-[12px] ${bad ? 'text-bad' : 'text-fg-muted'}`;
  }

  const h12 = (hour) => {
    const h = ((hour % 24) + 24) % 24;
    return `${h % 12 === 0 ? 12 : h % 12}${h < 12 ? 'am' : 'pm'}`;
  };

  // "set here", "from TIMEZONE", "default" - the same three words everywhere, so
  // the column reads as one thing rather than seven different phrasings.
  function sourceLine(f) {
    const base = f.source === 'admin' ? 'set here'
      : f.source === 'environment' ? `from ${f.env}`
        : 'default';
    return f.source === 'admin' && f.changedBy
      ? `${base} \u00b7 ${f.changedBy}, ${agoLabel(f.changedAt, true)}`
      : base;
  }

  const fillOptions = (id, values, selected, label) => {
    el(id).innerHTML = values.map((v) => {
      const value = typeof v === 'object' ? v.value : v;
      const text = typeof v === 'object' ? v.text : (label ? label(v) : v);
      return `<option value="${value}"${String(value) === String(selected) ? ' selected' : ''}>${text}</option>`;
    }).join('');
  };

  function renderConfig(payload) {
    const { config: c, status: st, cron } = payload;

    const ai = st.servingToPage === 'ai';
    el('cfServing').textContent = ai ? 'AI analysis' : 'Statistical pattern';
    el('cfServing').className = `mt-1 text-[15px] font-semibold ${ai ? 'text-good' : 'text-fg'}`;
    // The one sentence worth keeping: WHY it is on the fallback.
    el('cfServingNote').textContent = ai ? ''
      : (!st.keyConfigured ? 'No API key'
        : st.legacyRow ? 'Stored answer predates the current format'
          : st.computedAt ? 'Stored answer survived none of the office rules'
            : 'Nothing analysed yet');

    // Hours 0-23 for the start, 1-24 for the end: a day may end at midnight.
    fillOptions('cfWorkStart', Array.from({ length: 24 }, (_, i) => i), c.workStart.value, h12);
    fillOptions('cfWorkEnd', Array.from({ length: 24 }, (_, i) => i + 1), c.workEnd.value,
      (h) => (h === 24 ? 'midnight' : h12(h)));
    fillOptions('cfPhaseCeiling', Array.from({ length: 12 }, (_, i) => i + 1), c.phaseCeiling.value);

    el('cfBreaks').value = c.breaks.text;
    el('cfWorkDays').innerHTML = DAY_LABELS.map((name, i) => {
      const on = c.workDays.value.includes(i);
      return `<label class="${el('cfWorkDays').dataset.dayClass}">`
        + `<input type="checkbox" value="${i}"${on ? ' checked' : ''} class="accent-amber-500">`
        + `${name}</label>`;
    }).join('');

    el('cfModelSrc').textContent = sourceLine(c.aiModel)
      + (st.producedBy && st.producedBy !== c.aiModel.value
        ? ` \u00b7 showing ${st.producedBy}` : '');
    el('cfTimeZoneSrc').textContent = sourceLine(c.timeZone);
    el('cfWorkSrc').textContent = c.workStart.source === c.workEnd.source
      ? sourceLine(c.workStart)
      : `${sourceLine(c.workStart)} / ${sourceLine(c.workEnd)}`;
    el('cfPhaseSrc').textContent = sourceLine(c.phaseCeiling);
    el('cfWorkDaysSrc').textContent = sourceLine(c.workDays);
    el('cfBreaksSrc').textContent = sourceLine(c.breaks);

    el('cfProvider').textContent = st.provider;
    el('cfApi').textContent = st.api;
    el('cfSecrets').innerHTML = `<span class="${st.keyConfigured ? 'text-good' : 'text-bad'}">`
      + `${st.keyConfigured ? 'set' : 'not set'}</span> \u00b7 `
      + `<span class="${st.cronSecretConfigured ? 'text-good' : 'text-bad'}">`
      + `${st.cronSecretConfigured ? 'set' : 'not set'}</span>`;

    if (cron.configured) {
      el('cfCron').textContent = `${cron.local} ${cron.everyDay ? 'daily' : cron.schedule}`;
      el('cfCronNote').textContent = !st.cronSecretConfigured
        ? 'Refused while CRON_SECRET is unset'
        : cron.aligned
          ? `${cron.utc} UTC \u00b7 work days only`
          : `Misaligned: the day ends at ${cron.endOfDay}, schedule should be "${cron.shouldBe}"`;
      el('cfCronNote').className = `mt-0.5 text-[11px] ${
        cron.aligned && st.cronSecretConfigured ? 'text-fg-faint' : 'text-bad'}`;
    } else {
      el('cfCron').textContent = 'not configured';
      el('cfCronNote').textContent = cron.note || '';
    }

    el('cfLast').textContent = agoLabel(st.computedAt);
    el('cfLastNote').textContent = st.computedAt
      ? `${st.phases} phases, ${st.moments} moments, ${st.wildcards} wildcards`
        + `${st.fromSightings ? ` \u00b7 ${st.fromSightings} sightings` : ''}`
        + `${st.droppedPhases > 0 ? ` \u00b7 ${st.droppedPhases} dropped` : ''}`
      : '';
  }

  async function loadConfig() {
    try {
      renderConfig(await Tracker.api('/admin/config'));
      cfLoaded = true;
    } catch (e) {
      el('cfServing').textContent = 'could not load';
      cfMsg(e.message, true);
    }
  }

  // Both lists come from the server: the models are the recommended few this key
  // can actually reach, and the zones are the ones this runtime knows - an
  // unknown zone makes every Intl call in the app throw.
  async function loadConfigLists() {
    try {
      const { models, inUse, offList } = await Tracker.api('/admin/config/models');
      fillOptions('cfModel', models, inUse);
      if (offList) el('cfModelSrc').textContent += ' \u00b7 off the recommended list';
    } catch (e) {
      el('cfModel').innerHTML = '<option value="">could not list models</option>';
    }
    try {
      const { zones, inUse } = await Tracker.api('/admin/config/timezones');
      fillOptions('cfTimeZone', zones.length ? zones : [inUse], inUse);
    } catch (e) {
      el('cfTimeZone').innerHTML = '<option value="">could not list zones</option>';
    }
  }

  const readForm = () => ({
    aiModel: el('cfModel').value,
    timeZone: el('cfTimeZone').value,
    workStart: Number(el('cfWorkStart').value),
    workEnd: Number(el('cfWorkEnd').value),
    workDays: [...el('cfWorkDays').querySelectorAll('input:checked')].map((i) => Number(i.value)),
    breaks: el('cfBreaks').value.trim(),
    phaseCeiling: Number(el('cfPhaseCeiling').value),
  });

  el('cfReloadBtn').addEventListener('click', () => { loadConfig(); loadConfigLists(); });

  el('cfSaveBtn').addEventListener('click', async () => {
    const btn = el('cfSaveBtn');
    btn.disabled = true;
    try {
      const body = readForm();
      // An empty day list would disable the app on every day of the week, and
      // the server rejects it - but saying so here beats a round trip.
      if (body.workDays.length === 0) throw new Error('Pick at least one work day.');
      await Tracker.api('/admin/config', { method: 'PUT', body });
      // One reload, not three. The PUT returns the new config, but the panel also
      // shows status and cron, and the first version of this fetched the whole
      // payload twice more to get them.
      await loadConfig();
      cfMsg('Saved. Run the analysis to rebuild the phases.');
      showToast('Config saved');
      // The office clock may have moved, and every time on this page is drawn
      // against it — including the heatmap's day buckets.
      await refresh();
    } catch (e) {
      cfMsg(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  el('cfResetBtn').addEventListener('click', async () => {
    const btn = el('cfResetBtn');
    btn.disabled = true;
    try {
      const cleared = {};
      for (const k of ['aiModel', 'timeZone', 'workStart', 'workEnd', 'workDays', 'breaks',
        'phaseCeiling']) cleared[k] = null;
      await Tracker.api('/admin/config', { method: 'PUT', body: cleared });
      await loadConfig();
      await loadConfigLists();
      cfMsg('Reset \u2014 every field back to the environment.');
    } catch (e) {
      cfMsg(e.message, true);
    } finally {
      btn.disabled = false;
    }
  });

  // One call, on purpose. Not the trigger that was removed from the logging path
  // - that one fired on every sighting. This is a person deciding to spend one.
  el('cfRefreshBtn').addEventListener('click', async () => {
    const btn = el('cfRefreshBtn');
    const was = btn.textContent;
    btn.disabled = true;
    btn.textContent = 'Running\u2026';
    cfMsg('');
    try {
      const r = await Tracker.api('/admin/config/refresh', { method: 'POST' });
      cfMsg(r.skipped
        ? `Nothing to do: ${r.skipped}.`
        : `${r.windows} phases, ${r.moments} moments, ${r.wildcards} wildcards from ${r.model}.`);
      showToast('Analysis complete');
    } catch (e) {
      // The provider's own words: "quota exceeded, retry in 47s" is actionable,
      // "failed" is not.
      cfMsg(e.message, true);
      showToast('Analysis failed');
    } finally {
      btn.disabled = false;
      btn.textContent = was;
      await loadConfig();
    }
  });

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

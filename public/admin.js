(() => {
  const POLL_MS = 5000;
  let currentUser = null;
  let poller = null;

  const el = (id) => document.getElementById(id);
  const tooltip = Tracker.attachTooltip(el('tooltip'));
  const themeButtons = [el('themeToggleAuth'), el('themeToggleApp')];
  Tracker.initThemeToggle(themeButtons);

  const URGENT_THRESHOLD_S = 60;
  let timer3d = null;
  function isDarkTheme() { return document.documentElement.getAttribute('data-theme') === 'dark'; }
  function startTimer3D() { timer3d = window.Timer3D.init(el('countdownCanvas'), '--:--:--'); timer3d.setTheme(isDarkTheme()); }
  if (window.Timer3D) startTimer3D();
  else window.addEventListener('timer3d-ready', startTimer3D, { once: true });
  themeButtons.forEach((b) => b.addEventListener('click', () => { if (timer3d) timer3d.setTheme(isDarkTheme()); }));

  function showToast(msg) {
    const bubble = document.createElement('div');
    bubble.className = 'toast-bubble toast';
    bubble.textContent = msg;
    el('toastHost').appendChild(bubble);
    setTimeout(() => bubble.remove(), 3200);
  }
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
    el('tabSignIn').classList.toggle('active', isSignIn);
    el('tabRegister').classList.toggle('active', !isSignIn);
    el('signInPane').classList.toggle('active', isSignIn);
    el('registerPane').classList.toggle('active', !isSignIn);
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
    const btn = e.currentTarget;
    const rect = btn.getBoundingClientRect();
    const ripple = document.createElement('span');
    ripple.className = 'ripple';
    const size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(() => ripple.remove(), 650);

    try {
      const data = await Tracker.api('/sightings', { method: 'POST' });
      if (data.alreadyLogged) showToast('You already logged this one.');
      else if (data.merged) showToast('Merged with a sighting logged moments ago by someone else.');
      else showToast('Sighting logged.');
      await refresh();
    } catch (err) { showToast(err.message); }
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
      list.innerHTML = '<p class="muted" style="font-size:13px;">No invites yet.</p>';
      return;
    }
    list.innerHTML = data.invites.map((i) => {
      const used = !!i.used_by;
      return `<div class="invite-row"><span class="code">${i.code}</span><span class="status ${used ? 'used' : 'unused'}">${used ? 'used by ' + i.used_by : 'unused'}</span></div>`;
    }).join('');
  }

  // ---- tabs ----
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      el('panel-' + btn.dataset.tab).classList.add('active');
    });
  });

  // ---- rendering ----
  async function renderList(sightings) {
    const list = el('logList');
    if (sightings.length === 0) {
      list.innerHTML = '<div class="muted" style="padding:16px;">No entries yet.</div>';
      return;
    }
    // Render in the server's configured TIMEZONE, not the viewer's own browser
    // timezone — otherwise this list can disagree with the heatmap (which is
    // always TIMEZONE-bucketed) badly enough to show a different weekday.
    const timeZone = await Tracker.getTimezone();
    list.innerHTML = sightings.map((s) => {
      const d = new Date(s.ts * 1000);
      const label = d.toLocaleString(undefined, { timeZone, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      return `<div class="entry"><time>${label}</time><span class="muted">${s.logged_by}</span></div>`;
    }).join('');
  }

  let timeZone = 'UTC';
  let featured = null; // the currently-featured tier window, updated every poll

  // Ticks every second: shows a live countdown to the featured window's start,
  // or "HAPPENING NOW" while inside it — independent of the 5s data poll.
  // Under 60s remaining, the 3D digits pulse red for urgency.
  function tickCountdown() {
    if (!featured) return;
    if (featured.active) {
      el('countdownCanvas').style.display = 'none';
      el('countdownNow').style.display = 'block';
      el('countdownSr').textContent = 'Happening now';
      return;
    }
    el('countdownCanvas').style.display = 'block';
    el('countdownNow').style.display = 'none';
    const secondsLeft = Tracker.secondsUntilHour(featured.hourStart, timeZone);
    const text = Tracker.formatCountdown(secondsLeft);
    el('countdownSr').textContent = text;
    if (timer3d) {
      timer3d.setText(text);
      timer3d.setUrgent(secondsLeft > 0 && secondsLeft < URGENT_THRESHOLD_S);
    }
  }
  const ticker = Tracker.createTicker(tickCountdown);

  async function renderTiers(stats) {
    timeZone = await Tracker.getTimezone();
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone);
    const chips = el('tierChips');

    if (windows.length === 0) {
      featured = null;
      el('featuredTierLabel').textContent = 'Not enough data yet';
      el('countdownSr').textContent = '--:--:--';
      if (timer3d) { timer3d.setText('--:--:--'); timer3d.setUrgent(false); }
      el('windowLabel').textContent = '';
      el('featuredDetail').textContent = 'Log a few sightings to see a pattern emerge.';
      chips.innerHTML = '';
      return;
    }

    featured = windows.find((w) => w.featured);
    el('featuredTierLabel').textContent = featured.label + (featured.wrapsToTomorrow ? ' · tomorrow' : '');
    el('windowLabel').textContent = featured.wrapsToTomorrow ? `${featured.timeLabel} tomorrow` : featured.timeLabel;
    el('featuredDetail').textContent = featured.wrapsToTomorrow
      ? `Today's windows have passed — this pattern usually repeats tomorrow.`
      : featured.detail;
    tickCountdown();

    chips.innerHTML = windows.map((w) => `
      <div class="tier-chip ${w.featured ? 'is-featured' : ''} ${w.passed && !w.featured ? 'is-passed' : ''} ${w.tier === 'wildcard' ? 'is-wildcard' : ''}">
        <span class="tc-label">${w.label}</span>
        <span class="tc-time">${w.timeLabel}</span>
      </div>
    `).join('');
  }

  function renderByPerson(byPerson) {
    const wrap = el('byPerson');
    const names = Object.keys(byPerson || {});
    if (names.length === 0) {
      wrap.innerHTML = '<span class="muted">No entries yet.</span>';
      return;
    }
    wrap.innerHTML = names
      .sort((a, b) => byPerson[b] - byPerson[a])
      .map((n) => `<span class="person-pill">${n} <span class="count">${byPerson[n]}</span></span>`)
      .join('');
  }

  async function refresh() {
    const [{ sightings }, stats] = await Promise.all([
      Tracker.api('/sightings'),
      Tracker.api('/sightings/stats'),
    ]);
    await renderList(sightings);
    Tracker.renderHeatmap(el('heatmapGrid'), stats.heatmap, tooltip);
    await renderTiers(stats);
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

(() => {
  const POLL_MS = 5000;
  const URGENT_THRESHOLD_S = 60;

  const featuredTierLabel = document.getElementById('featuredTierLabel');
  const countdownCanvas = document.getElementById('countdownCanvas');
  const countdownNow = document.getElementById('countdownNow');
  const countdownSr = document.getElementById('countdownSr');
  const windowLabel = document.getElementById('windowLabel');
  const featuredDetail = document.getElementById('featuredDetail');
  const tierChips = document.getElementById('tierChips');
  const heatmapGrid = document.getElementById('heatmapGrid');
  const totalStat = document.getElementById('totalStat');
  const peakStat = document.getElementById('peakStat');
  const tooltip = Tracker.attachTooltip(document.getElementById('tooltip'));
  const spotBtn = document.getElementById('spotBtn');

  Tracker.initThemeToggle(document.getElementById('themeToggle'));

  let timeZone = 'UTC';
  let featured = null; // the currently-featured tier window, updated every poll
  let timer3d = null;

  function isDarkTheme() { return document.documentElement.getAttribute('data-theme') === 'dark'; }

  function startTimer3D() {
    timer3d = window.Timer3D.init(countdownCanvas, '--:--:--');
    timer3d.setTheme(isDarkTheme());
  }
  if (window.Timer3D) startTimer3D();
  else window.addEventListener('timer3d-ready', startTimer3D, { once: true });

  // Keep the 3D clock's palette in sync when the theme toggle is used.
  document.getElementById('themeToggle').addEventListener('click', () => {
    if (timer3d) timer3d.setTheme(isDarkTheme());
  });

  function showToast(msg) {
    const bubble = document.createElement('div');
    bubble.className = 'toast-bubble toast';
    bubble.style.cssText = 'background:var(--ink-800); border:1px solid var(--line-strong); border-radius:12px; padding:11px 18px; margin-top:8px; box-shadow:0 8px 24px rgba(0,0,0,0.3);';
    bubble.textContent = msg;
    document.getElementById('toastHost').appendChild(bubble);
    setTimeout(() => bubble.remove(), 3200);
  }

  const missedModal = document.getElementById('missedModal');
  function showMissedModal(line) {
    document.getElementById('missedModalText').textContent = line;
    missedModal.style.display = 'flex';
  }
  function hideMissedModal() { missedModal.style.display = 'none'; }
  document.getElementById('missedModalClose').addEventListener('click', hideMissedModal);
  document.getElementById('missedModalOk').addEventListener('click', hideMissedModal);
  missedModal.addEventListener('click', (e) => { if (e.target === missedModal) hideMissedModal(); });
  const checkMissedPrediction = Tracker.createMissedPredictionWatcher(showMissedModal);

  // Ticks every second: shows a live countdown to the featured window's start,
  // or "HAPPENING NOW" while inside it. Independent of the 5s data poll so it
  // doesn't visibly stall between refreshes. Under 60s remaining, the 3D
  // digits pulse red for urgency.
  function tickCountdown() {
    if (!featured) return;
    if (featured.active) {
      countdownCanvas.style.display = 'none';
      countdownNow.style.display = 'block';
      countdownSr.textContent = 'Happening now';
      return;
    }
    countdownCanvas.style.display = 'block';
    countdownNow.style.display = 'none';
    const secondsLeft = Tracker.secondsUntilHour(featured.hourStart, timeZone);
    const text = Tracker.formatCountdown(secondsLeft);
    countdownSr.textContent = text;
    if (timer3d) {
      timer3d.setText(text);
      timer3d.setUrgent(secondsLeft > 0 && secondsLeft < URGENT_THRESHOLD_S);
    }
  }
  const ticker = Tracker.createTicker(tickCountdown);

  function renderTiers(windows) {
    if (windows.length === 0) {
      featured = null;
      featuredTierLabel.textContent = 'Next predicted roam';
      countdownSr.textContent = '--:--:--';
      if (timer3d) { timer3d.setText('--:--:--'); timer3d.setUrgent(false); }
      windowLabel.textContent = 'Still watching…';
      featuredDetail.textContent = 'No sightings logged yet — check back once the team starts spotting.';
      tierChips.innerHTML = '';
      return;
    }

    featured = windows.find((w) => w.featured);
    featuredTierLabel.textContent = featured.label + (featured.wrapsToTomorrow ? ' · tomorrow' : '');
    windowLabel.textContent = featured.wrapsToTomorrow ? `${featured.timeLabel} tomorrow` : featured.timeLabel;
    featuredDetail.textContent = featured.wrapsToTomorrow
      ? `Today's windows have passed. This pattern usually repeats — check back tomorrow.`
      : featured.detail;
    tickCountdown();

    tierChips.innerHTML = windows.map((w) => `
      <div class="tier-chip ${w.featured ? 'is-featured' : ''} ${w.passed && !w.featured ? 'is-passed' : ''} ${w.tier === 'wildcard' ? 'is-wildcard' : ''}">
        <span class="tc-label">${w.label}</span>
        <span class="tc-time">${w.timeLabel}</span>
      </div>
    `).join('');
  }

  async function pollStats() {
    const stats = await Tracker.api('/sightings/stats');
    timeZone = await Tracker.getTimezone();
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone);
    renderTiers(windows);
    checkMissedPrediction(windows, stats.total);
    Tracker.renderHeatmap(heatmapGrid, stats.heatmap, tooltip);
    totalStat.textContent = stats.total;
    peakStat.textContent = Tracker.peakLabel(stats);
  }

  Tracker.createPoller(pollStats, POLL_MS).start();
  ticker.start();

  // Confetti: a real Lottie animation (see scripts/generate-confetti-lottie.js)
  // played into a full-screen overlay, positioned over the button that was pressed.
  function playConfettiLottie(originEl) {
    if (typeof lottie === 'undefined') { Tracker.confettiBurst(originEl); return; }
    const rect = originEl.getBoundingClientRect();
    const host = document.getElementById('confettiLottie');
    const box = document.createElement('div');
    const size = 240;
    box.style.cssText = `position:absolute; left:${rect.left + rect.width / 2 - size / 2}px; top:${rect.top + rect.height / 2 - size / 2}px; width:${size}px; height:${size}px;`;
    host.appendChild(box);
    const anim = lottie.loadAnimation({
      container: box,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path: '/confetti.lottie.json',
    });
    anim.addEventListener('complete', () => { anim.destroy(); box.remove(); });
  }

  let spotting = false;
  spotBtn.addEventListener('click', async () => {
    if (spotting) return;
    spotting = true;
    spotBtn.disabled = true;
    try {
      const data = await Tracker.api('/sightings/anonymous', { method: 'POST' });
      playConfettiLottie(spotBtn);
      if (data.alreadyLogged) showToast('Someone already logged this one moments ago.');
      else showToast('Logged! Thanks for the tip.');
      await pollStats();
    } catch (e) {
      showToast(e.message);
    } finally {
      spotting = false;
      spotBtn.disabled = false;
    }
  });
})();

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
  const spotHint = document.getElementById('spotHint');
  const heatmapGrid = document.getElementById('heatmapGrid');
  const totalStat = document.getElementById('totalStat');
  const peakStat = document.getElementById('peakStat');
  const tooltip = Tracker.attachTooltip(document.getElementById('tooltip'));
  const spotBtn = document.getElementById('spotBtn');

  Tracker.initThemeToggle(document.getElementById('themeToggle'));

  let timeZone = 'UTC';
  let workHours = null; // the office's logging window, from /api/config
  let countdownOverride = null; // COUNTDOWN_OVERRIDE_MS, testing only
  let featured = null; // the currently-featured tier window, updated every poll
  let timer3d = null;

  const OPEN_HINT = spotHint.textContent;

  // Toggles a boolean data attribute, the app's standard way of carrying UI
  // state now that Tailwind variants (data-closed:*) do the styling.
  function setFlag(el, name, on) {
    if (on) el.dataset[name] = '';
    else delete el.dataset[name];
  }

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

  // Sightings can only be logged during the office's working day (see
  // services/work-hours.js — the definition is the server's, so it does not
  // shift with the viewer's own timezone). Re-evaluated on every one-second
  // tick rather than once at load, so a page left open overnight disables its
  // own button at closing time instead of going stale.
  let spotting = false;
  function syncSpotButton() {
    if (!workHours) return;
    const { open, label } = Tracker.workHoursState(timeZone, workHours);
    spotBtn.disabled = !open || spotting;
    // data-closed, not a class: the markup styles the shut state with
    // data-closed:* variants, whose attribute selector outranks the base look.
    setFlag(spotBtn, 'closed', !open);
    setFlag(spotHint, 'closed', !open);
    if (typeof Icons !== 'undefined') {
      Icons.set(document.getElementById('spotBtnIcon'), open ? 'eye' : 'lock-simple');
      spotHint.innerHTML = open ? OPEN_HINT : Icons.svg('clock-countdown') + label;
    } else {
      spotHint.textContent = open ? OPEN_HINT : label;
    }
    document.getElementById('spotBtnLabel').textContent = open ? 'I see them — log it!' : 'Logging closed';
  }

  function showToast(msg) {
    Tracker.toast(document.getElementById('toastHost'), msg);
  }

  // ---- outcome modals ----
  // The two marks are LottieFiles animations (Lottie Simple License) rather than
  // generated: "Target" by Spencer Lalonde for a hit, "Hit Missed" by Birju
  // Raikwar for a miss. See the credits section in README.md.
  // Two verdicts on a prediction, presented the same way: a Lottie playing over
  // the message. confetti.lottie.json for a hit, miss.lottie.json for a miss
  // (see scripts/generate-*-lottie.js). Each modal ships a Phosphor icon inside
  // its art slot as the fallback, so a blocked or failed CDN leaves a sensible
  // static modal rather than a hole.
  function playModalLottie(mountId, path) {
    const mount = document.getElementById(mountId);
    const lottie = Tracker.lottieLib();
    if (!mount || !lottie) return null; // leaves the static fallback icon in place
    mount.innerHTML = '';
    // Deliberately NOT looped. The mark draws itself on and holds: a tick that
    // keeps re-drawing reads as a spinner, i.e. as if something were still
    // loading. The celebration is the full-page layer instead.
    return lottie.loadAnimation({
      container: mount, renderer: 'svg', loop: false, autoplay: true, path,
    });
  }

  // The whole-page layer behind the modal: confetti for a hit, a grey dud for a
  // miss. It fills the viewport by cropping ('slice') rather than stretching —
  // scaling confetti into ovals is the one thing a page-scale animation must not
  // do — and clears itself up when it finishes so the overlay does not sit there
  // holding a finished animation's rAF loop.
  const pageOverlay = document.getElementById('confettiLottie');
  let pageAnim = null;
  function playPageLottie(path) {
    const lottie = Tracker.lottieLib();
    if (!pageOverlay || !lottie) return;
    if (pageAnim) { pageAnim.destroy(); pageAnim = null; }
    pageOverlay.innerHTML = '';
    pageAnim = lottie.loadAnimation({
      container: pageOverlay,
      renderer: 'svg',
      loop: false,
      autoplay: true,
      path,
      rendererSettings: { preserveAspectRatio: 'xMidYMid slice' },
    });
    pageAnim.addEventListener('complete', () => {
      if (pageAnim) { pageAnim.destroy(); pageAnim = null; }
      pageOverlay.innerHTML = '';
    });
  }

  function makeOutcomeModal({ id, textId, artId, lottiePath, pagePath, closeIds }) {
    const modal = document.getElementById(id);
    let anim = null;
    function hide() {
      modal.style.display = 'none';
      if (anim) { anim.destroy(); anim = null; }
    }
    function show(line) {
      document.getElementById(textId).textContent = line;
      modal.style.display = 'flex';
      if (anim) anim.destroy();
      anim = playModalLottie(artId, lottiePath);
      playPageLottie(pagePath);
    }
    closeIds.forEach((cid) => document.getElementById(cid).addEventListener('click', hide));
    modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });
    return { show, hide };
  }

  const missModal = makeOutcomeModal({
    id: 'missedModal', textId: 'missedModalText', artId: 'missedModalArt',
    lottiePath: '/miss-shot.lottie.json', pagePath: '/dud-page.lottie.json',
    closeIds: ['missedModalClose', 'missedModalOk'],
  });
  const hitModal = makeOutcomeModal({
    id: 'hitModal', textId: 'hitModalText', artId: 'hitModalArt',
    lottiePath: '/hit-target.lottie.json', pagePath: '/confetti-page.lottie.json',
    closeIds: ['hitModalClose', 'hitModalOk'],
  });

  const checkPrediction = Tracker.createPredictionWatcher({
    onHit: (line, count) => {
      hitModal.show(line);
      Tracker.notify('Called it — HR showed up', line, 'outcome');
      showToast(`Prediction hit · ${count} sighting${count === 1 ? '' : 's'} logged in the window`);
    },
    onMiss: (line) => {
      missModal.show(line);
      Tracker.notify('Wrong prediction', line, 'outcome');
      showToast('Prediction missed — nobody roamed in that window');
    },
  });

  // ---- ?preview=hit|miss|toast ----
  // Shows an outcome on demand so the presentation — lottie, copy, layout — can
  // be checked without waiting for a real window to open and close. It only
  // reads the URL and calls the same show() the watcher does; nothing in the
  // prediction path is faked or bypassed, which is why this is a URL flag and
  // not another server setting.
  const previewMatch = /[?&]preview=(hit|miss|toast)\b/.exec((window.location && window.location.search) || '');
  if (previewMatch) {
    const which = previewMatch[1];
    if (which === 'hit') hitModal.show('Preview — this is what a hit looks like.');
    else if (which === 'miss') missModal.show('Preview — this is what a miss looks like.');
    else showToast('Preview — a toast, fully ablaze.');
  }

  // ---- countdown alerts ----
  // A warning is only useful if it reaches someone who is NOT staring at the
  // page, so each one goes out as a desktop notification (when the bell is on)
  // as well as a toast.
  Tracker.initNotifyToggle(document.getElementById('notifyToggle'), (on, permission) => {
    if (permission === 'denied') showToast('Your browser is blocking notifications for this site.');
    else showToast(on ? 'Roam alerts on — you will get a heads-up at 1 min and 30 s.' : 'Roam alerts off.');
  });

  const checkCountdownAlert = Tracker.createCountdownAlerter((threshold, secondsLeft, window_) => {
    const when = threshold >= 60 ? '1 minute' : `${threshold} seconds`;
    const title = threshold >= 60 ? 'HR roam in ~1 minute' : 'HR roam in ~30 seconds';
    Tracker.notify(title, `${window_.label} window · ${window_.timeLabel}`, 'countdown');
    showToast(`Heads up — predicted roam in ${when}.`);
  });

  // Ticks every second: shows a live countdown to the featured window's start,
  // or "HAPPENING NOW" while inside it. Independent of the 5s data poll so it
  // doesn't visibly stall between refreshes. Under 60s remaining, the 3D
  // digits pulse red for urgency.
  function tickCountdown() {
    syncSpotButton();
    if (!featured) return;
    // The override wins over "happening now": the point of it is to watch the
    // countdown itself, and a live window would hide the thing under test.
    if (featured.active && !countdownOverride) {
      countdownCanvas.style.display = 'none';
      countdownNow.style.display = 'block';
      countdownSr.textContent = 'Happening now';
      return;
    }
    countdownCanvas.style.display = 'block';
    countdownNow.style.display = 'none';
    const secondsLeft = countdownOverride
      ? countdownOverride.secondsLeft()
      : Tracker.secondsUntilWindow(featured.hourStart, timeZone, workHours);
    checkCountdownAlert(featured, secondsLeft);
    const text = Tracker.formatCountdown(secondsLeft);
    countdownSr.textContent = text;
    if (timer3d) {
      timer3d.setText(text);
      timer3d.setUrgent(secondsLeft > 0 && secondsLeft < URGENT_THRESHOLD_S);
    }
  }
  const ticker = Tracker.createTicker(tickCountdown);

  // Tier-chip markup. State rides on data attributes rather than extra classes:
  // the attribute selector (and group-data-* for the children) outranks the base
  // utilities, whereas a second competing utility would be decided by compiled
  // source order. `group` is what lets the label and time react to the chip's
  // own state.
  const CHIP = 'group flex min-w-[92px] flex-col items-center gap-[3px] rounded-xl border border-line bg-ink-900 px-[18px] py-2.5 transition-[border-color,background-color,transform] duration-200 '
    + 'data-featured:border-amber-500 data-featured:bg-[rgba(242,169,59,0.08)] data-featured:-translate-y-0.5 '
    + 'data-passed:opacity-45 data-wildcard:border-dashed';
  const CHIP_LABEL = 'text-[10px] uppercase tracking-[0.1em] text-fg-faint group-data-featured:text-amber-300';
  const CHIP_TIME = 'text-[19px] font-semibold tracking-[-0.01em] text-fg '
    + 'group-data-passed:line-through group-data-passed:decoration-fg-faint group-data-wildcard:text-[15px]';

  // Three cases, and the weekend one is the reason this exists: the pattern is
  // learned from work-day sightings, so on a Saturday there is nothing to wait
  // for today and saying "check back tomorrow" would be wrong twice over.
  function featuredDetailText(featured) {
    if (!featured.todayIsWorkDay) {
      return `No roams expected today — the pattern only turns up on work days. Next window ${featured.dayLabel || 'soon'}.`;
    }
    if (featured.dayOffset > 0) {
      return `Today's windows have passed. This pattern usually repeats — check back ${featured.dayLabel}.`;
    }
    return featured.detail;
  }

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
    featuredTierLabel.textContent = featured.label + (featured.dayLabel ? ` · ${featured.dayLabel}` : '');
    windowLabel.textContent = featured.dayLabel ? `${featured.timeLabel} ${featured.dayLabel}` : featured.timeLabel;
    featuredDetail.textContent = featuredDetailText(featured);
    tickCountdown();

    tierChips.innerHTML = windows.map((w) => `
      <div class="${CHIP}" ${w.featured ? 'data-featured' : ''} ${w.passed && !w.featured ? 'data-passed' : ''} ${w.tier === 'wildcard' ? 'data-wildcard' : ''}>
        <span class="${CHIP_LABEL}">${w.label}</span>
        <span class="${CHIP_TIME}">${w.timeLabel}</span>
      </div>
    `).join('');
  }

  async function pollStats() {
    const stats = await Tracker.api('/sightings/stats');
    const config = await Tracker.getConfig();
    timeZone = config.timezone;
    workHours = config.workHours;
    if (config.countdownOverrideMs && !countdownOverride) {
      countdownOverride = Tracker.createCountdownOverride(config.countdownOverrideMs);
      const note = document.getElementById('countdownOverrideNote');
      note.textContent = `Countdown overridden for testing — ${Math.round(config.countdownOverrideMs / 1000)}s from page load`;
      note.style.display = 'inline-flex';
    }
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone, workHours);
    renderTiers(windows);
    // The watcher needs where the clock sits relative to the window — before,
    // inside, or past it — so a sighting logged just outside the range still
    // counts (see the grace period in createPredictionWatcher).
    checkPrediction(windows, stats.total, Tracker.windowPhase(windows.find((w) => w.featured), timeZone));
    Tracker.renderHeatmap(heatmapGrid, stats.heatmap, tooltip);
    totalStat.textContent = stats.total;
    peakStat.textContent = Tracker.peakLabel(stats);
  }

  Tracker.createPoller(pollStats, POLL_MS).start();
  ticker.start();

  // Confetti: a real Lottie animation (see scripts/generate-confetti-lottie.js)
  // played into a full-screen overlay, positioned over the button that was pressed.
  function playConfettiLottie(originEl) {
    const lottie = Tracker.lottieLib();
    if (!lottie) { Tracker.confettiBurst(originEl); return; }
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

  spotBtn.addEventListener('click', async () => {
    if (spotting) return;
    // Belt and braces: the button is disabled out of hours, but a click that
    // slips through (a stale DOM, devtools) must not post either.
    if (workHours && !Tracker.workHoursState(timeZone, workHours).open) {
      showToast('Logging is closed right now.');
      return;
    }
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
      syncSpotButton();
    }
  });
})();

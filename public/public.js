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
  const phasesNote = document.getElementById('phasesNote');
  const breakNote = document.getElementById('breakNote');
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

  // opts is passed straight through to Tracker.toast; { fire: true } is the
  // urgent variant and belongs to the countdown alerts alone.
  function showToast(msg, opts) {
    Tracker.toast(document.getElementById('toastHost'), msg, opts);
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

  // ---- the logging advisory ----
  // Every load, no memory of the last one — see initAdvisory in viz.js.
  const advisory = Tracker.initAdvisory();

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
    else showToast('Preview — a countdown toast, fully ablaze.', { fire: true });
  } else if (advisory) {
    advisory.show();
  }

  // ---- countdown alerts ----
  // A warning is only useful if it reaches someone who is NOT staring at the
  // page, so each one goes out as a desktop notification (when the bell is on)
  // as well as a toast.
  Tracker.initNotifyToggle(document.getElementById('notifyToggle'), (on, permission) => {
    if (permission === 'denied') showToast('Your browser is blocking notifications for this site.');
    else showToast(on ? 'Roam alerts on — you will get a heads-up at 1 min and 30s.' : 'Roam alerts off.');
  });

  const checkCountdownAlert = Tracker.createCountdownAlerter((threshold, secondsLeft, window_) => {
    const when = threshold >= 60 ? '1 minute' : `${threshold} seconds`;
    const title = threshold >= 60 ? 'HR roam in ~1 minute' : 'HR roam in ~30 seconds';
    Tracker.notify(title, `${window_.label} window · ${window_.targetLabel}`, 'countdown');
    showToast(`Heads up — predicted roam at ${window_.targetLabel}, in ${when}.`, { fire: true });
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
    // To the predicted MOMENT (9:34), not the top of its hour — the page shows
    // that time, so the clock has to agree with it.
    const secondsLeft = countdownOverride
      ? countdownOverride.secondsLeft()
      : Tracker.secondsUntilPrediction(featured, timeZone, workHours);
    checkCountdownAlert(featured, secondsLeft);
    const text = Tracker.formatCountdown(secondsLeft);
    countdownSr.textContent = text;
    if (timer3d) {
      timer3d.setText(text);
      timer3d.setUrgent(secondsLeft > 0 && secondsLeft < URGENT_THRESHOLD_S);
    }
  }
  const ticker = Tracker.createTicker(tickCountdown);

  // Phase-card markup.
  //
  // A PHASE is one time range — one stretch of the day HR is expected to be out
  // — and Sure/Likely/Maybe/Wildcard are the moments INSIDE it, not four rival
  // windows to choose between. So the range is the card, and the tiers are its
  // rows: each row leads with a real clock time and carries its tier as a badge.
  // The next range is simply the next card, which is what "phase" means here.
  //
  // State rides on data attributes rather than extra classes: the attribute
  // selector (and group-data-* for the children) outranks the base utilities,
  // whereas a second competing utility would be decided by compiled source
  // order. `group` is what lets the children react to the card's own state.
  // The card is a <details>: only the phase actually coming up is worth the
  // vertical space, so every other one collapses to its summary line. Native
  // disclosure rather than a class toggle — it is keyboard-operable, it works
  // before any of this JS runs, and there is no open/closed state of our own to
  // keep in sync across the five-second poll.
  const PHASE_CARD = 'group overflow-hidden rounded-2xl border border-line bg-ink-900 transition-[border-color] duration-200 '
    + 'data-featured:border-amber-500 data-passed:opacity-45';
  // list-none plus the webkit marker rule removes the browser's own triangle;
  // the chevron below replaces it so it can be styled and rotated.
  const PHASE_HEAD = 'flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2.5 '
    + 'transition-colors duration-150 hover:bg-ink-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-400 '
    + 'group-data-featured:bg-[rgba(242,169,59,0.08)] [&::-webkit-details-marker]:hidden';
  const PHASE_NUM = 'inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border border-line text-[10px] font-semibold tabular-nums text-fg-faint '
    + 'group-data-featured:border-amber-500 group-data-featured:text-amber-300';
  const PHASE_RANGE = 'text-[15px] font-semibold tracking-[-0.01em] text-fg group-data-featured:text-amber-300 '
    + 'group-data-passed:line-through group-data-passed:decoration-fg-faint';
  // The phase's headline moment, kept in the summary so a COLLAPSED card still
  // answers "when" without being opened. That is the point of collapsing them:
  // less space, not less information.
  const PHASE_LEAD = 'text-[13px] tabular-nums text-fg-muted group-data-featured:text-amber-300';
  const PHASE_META = 'ml-auto text-[11px] tabular-nums text-fg-faint';
  const PHASE_CARET = 'shrink-0 text-fg-faint transition-transform duration-200 group-open:rotate-180';

  // One moment inside the range. The separator is on the TOP of each row rather
  // than the bottom of the header: a collapsed card has no rows, and a header
  // with a bottom border and nothing under it is a line hanging in mid-air.
  const TIER_ROW = 'flex items-center gap-3 border-t border-line px-4 py-2.5';
  const TIER_TIME = 'w-[76px] shrink-0 text-[17px] font-semibold tabular-nums tracking-[-0.01em] text-fg data-next:text-amber-300';
  const TIER_SUB = 'min-w-0 flex-1 text-[11px] leading-snug text-fg-faint';
  const TIER_BADGE = 'shrink-0 self-start rounded-full border border-line px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-fg-muted '
    + 'data-next:border-amber-500 data-next:text-amber-300';

  // The wildcard sits BETWEEN the cards, not inside one.
  //
  // It is projected forward off the end of a phase and usually lands outside it
  // — 10:35am for a 9–10am window — so filing it under that window's range was
  // a small lie about where it happens. In the gap between two cards it says
  // what it actually is: not part of either phase, just the chance of a roam on
  // the way from one to the next. The dashed rule down its left is what makes it
  // read as a link between them rather than a card of its own.
  // Wraps on a phone: at 360px the time and the badge leave the note about
  // 100px of column, and "projected from the usual 53-minute gap" came out as a
  // seven-line ribbon. Under 480px the note drops to its own full-width line
  // underneath instead, with the time and badge sharing the one above.
  // Hidden while the phase above it is collapsed. The wildcard belongs to that
  // phase — it is the chance of a roam on the way OUT of it — so a row of
  // collapsed cards with dangling projections between them reads as three
  // wildcards belonging to nothing.
  //
  // The adjacent-sibling selector, not Tailwind's `peer`: peer variants use the
  // general sibling combinator, so every wildcard after the one open card would
  // match it and show. `details[open] + &` is true only for the card directly
  // above.
  const WILD_LINK = 'mx-5 hidden [details[open]+&]:flex flex-wrap items-center gap-x-3 gap-y-1 border-l-2 border-dashed border-line py-1.5 pl-4';
  const WILD_TIME = 'shrink-0 text-[15px] font-semibold tabular-nums text-fg-muted min-[481px]:w-[68px]';
  const WILD_SUB = 'min-w-0 flex-1 text-[11px] leading-snug text-fg-faint '
    + 'max-[480px]:order-last max-[480px]:w-full max-[480px]:flex-none';
  const WILD_BADGE = 'shrink-0 rounded-full border border-dashed border-line px-2.5 py-1 text-[10px] uppercase tracking-[0.08em] text-fg-faint max-[480px]:ml-auto';

  // Three cases, and the weekend one is the reason this exists: the pattern is
  // learned from work-day sightings, so on a Saturday there is nothing to wait
  // for today and saying "check back tomorrow" would be wrong twice over.
  function featuredDetailText(featured) {
    if (!featured.todayIsWorkDay) {
      return `No roams expected today — the pattern only turns up on work days. `
        + `Next window ${featured.dayLabel || 'soon'}. ${sourceOfExactTime(featured)}`;
    }
    if (featured.dayOffset > 0) {
      return `Today's windows have passed. This pattern usually repeats — check back `
        + `${featured.dayLabel}. ${sourceOfExactTime(featured)}`;
    }
    return `${featured.detail} ${sourceOfExactTime(featured)}`.trim();
  }

  // Where the minute on the countdown comes from. A countdown reads as a far more
  // precise claim than the data supports, so the page says outright how the
  // number was arrived at rather than letting it look like certainty.
  function sourceOfExactTime(w) {
    const row = Tracker.sureRow(w);
    if (!row) return '';
    if (!row.from) {
      return `${row.targetLabel} is the middle of the ${row.quarter || 'window'} stretch — nothing has been logged there yet.`;
    }
    return `${row.targetLabel} is the median of ${row.from} sighting${row.from === 1 ? '' : 's'} logged in the ${row.quarter} stretch of that window.`;
  }

  // A phase card holds the moments the data actually places inside its range;
  // the wildcard is pulled out and rendered between the cards instead (see
  // WILD_LINK), because that is where it lands.
  const momentsOf = (w) => w.tiers.filter((t) => t.tier !== 'wildcard');
  const wildcardOf = (w) => w.tiers.find((t) => t.tier === 'wildcard');

  // The line under each moment: what the number is actually based on. A
  // projection and a measurement must not read the same.
  function tierSubtitle(t) {
    if (t.tier === 'wildcard') return t.note || 'projected from the usual gap between sightings';
    if (!t.from) return `nothing logged in the ${t.quarter} stretch yet — this is its midpoint`;
    return `${t.from} sighting${t.from === 1 ? '' : 's'} in the ${t.quarter} stretch`;
  }

  function renderTiers(windows, total) {
    if (windows.length === 0) {
      featured = null;
      featuredTierLabel.textContent = 'Next predicted roam';
      countdownSr.textContent = '--:--:--';
      if (timer3d) { timer3d.setText('--:--:--'); timer3d.setUrgent(false); }
      windowLabel.textContent = 'Still watching…';
      // Two different empty states. Nothing logged at all is the ordinary one;
      // sightings logged but no phase built from them means every one of them
      // landed in break time, and telling that person "no sightings logged yet"
      // reads as the app having lost their data.
      featuredDetail.textContent = total > 0
        ? 'Sightings logged, but none outside break time yet — nothing to predict from so far.'
        : 'No sightings logged yet — check back once the team starts spotting.';
      tierChips.innerHTML = '';
      if (phasesNote) phasesNote.textContent = 'nothing to schedule yet';
      return;
    }

    featured = windows.find((w) => w.featured);
    // The header names the PHASE, not a tier: the tiers are inside it now.
    featuredTierLabel.textContent = `Next roam phase${featured.dayLabel ? ` · ${featured.dayLabel}` : ''}`;
    // Exact time first, range second: the range is the evidence behind the
    // prediction, not the prediction itself.
    windowLabel.textContent = `${featured.targetLabel}${featured.dayLabel ? ` ${featured.dayLabel}` : ''}`
      + ` · somewhere in ${featured.timeLabel}`;
    featuredDetail.textContent = featuredDetailText(featured);
    tickCountdown();

    if (phasesNote) {
      const left = windows.filter((w) => !w.passed).length;
      phasesNote.textContent = featured.todayIsWorkDay
        ? `${left} of ${windows.length} still to come`
        : `next work day · ${windows.length} phase${windows.length === 1 ? '' : 's'}`;
    }
    // Only the phase in play is expanded. `open` is set from the data on every
    // render, so a phase that closes while the page is left open collapses on
    // its own and the next one takes the space.
    const caret = typeof Icons !== 'undefined' ? Icons.svg('caret-down', { size: '0.85em' }) : '';
    tierChips.innerHTML = windows.map((w, i) => `
      <details class="${PHASE_CARD}" ${w.featured ? 'open data-featured' : ''} ${w.passed && !w.featured ? 'data-passed' : ''}>
        <summary class="${PHASE_HEAD}">
          <span class="${PHASE_NUM}">${i + 1}</span>
          <span class="${PHASE_RANGE}">${w.timeLabel}</span>
          <span class="${PHASE_LEAD}">${w.targetLabel}</span>
          <span class="${PHASE_META}">${w.count ? `${w.count} logged` : w.badge}</span>
          <span class="${PHASE_CARET}">${caret}</span>
        </summary>
        ${momentsOf(w).map((t) => `
          <div class="${TIER_ROW}">
            <span class="${TIER_TIME}" ${w.featured && t.tier === 'sure' ? 'data-next' : ''}>${t.targetLabel}</span>
            <span class="${TIER_SUB}">${tierSubtitle(t)}</span>
            <span class="${TIER_BADGE}" ${w.featured && t.tier === 'sure' ? 'data-next' : ''}>${t.label}</span>
          </div>
        `).join('')}
      </details>
      ${wildcardOf(w) ? `
        <div class="${WILD_LINK}" data-wildcard>
          <span class="${WILD_TIME}">${wildcardOf(w).targetLabel}</span>
          <span class="${WILD_SUB}">${tierSubtitle(wildcardOf(w))}</span>
          <span class="${WILD_BADGE}">${wildcardOf(w).label}</span>
        </div>` : ''}
    `).join('');
  }

  async function pollStats() {
    const stats = await Tracker.api('/sightings/stats');
    const config = await Tracker.getConfig();
    timeZone = config.timezone;
    workHours = config.workHours;
    // Why there is no phase over lunch, and why a wildcard skips past it.
    if (breakNote && config.breaks && config.breaks.length) {
      breakNote.textContent = `Nothing is predicted during break time — `
        + `${Tracker.breaksLabel(config.breaks)}. Sightings logged then still count.`;
      breakNote.style.display = 'block';
    }
    if (config.countdownOverrideMs && !countdownOverride) {
      countdownOverride = Tracker.createCountdownOverride(config.countdownOverrideMs);
      const note = document.getElementById('countdownOverrideNote');
      note.textContent = `Countdown overridden for testing — ${Math.round(config.countdownOverrideMs / 1000)}s from page load`;
      note.style.display = 'inline-flex';
    }
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone, workHours);
    renderTiers(windows, stats.total);
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

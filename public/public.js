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
  let phases = []; // the day's phases, refreshed each poll — the ticker reads this
  let todayMinutes = []; // today's sightings, minutes since midnight — drives the hit/miss badges
  // Which phase cards the reader has opened or closed by hand, keyed on the
  // phase's start hour. Deliberately not persisted: it is the state of this
  // reading session, not a preference.
  const openState = new Map();
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
    // Looped. The mark used to draw itself on once and hold, on the theory that a
    // re-drawing tick reads as a spinner; in practice the modal sits open until
    // it is dismissed, and a still frame under a heading makes the panel look
    // like a screenshot of itself. The page-wide layer behind it stays one-shot
    // — confetti that never stops is a different problem.
    return lottie.loadAnimation({
      container: mount, renderer: 'svg', loop: true, autoplay: true, path,
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

  // Judged exactly as the per-moment badges are: a sighting has to land in a
  // predicted minute. The modal and the badges under it cannot disagree.
  const checkPrediction = Tracker.createPredictionWatcher({
    onHit: (line, hits, moments) => {
      hitModal.show(line);
      Tracker.notify('Called it — HR showed up', line, 'outcome');
      showToast(`Prediction hit · ${hits} of ${moments} predicted times landed`);
    },
    onMiss: (line) => {
      missModal.show(line);
      Tracker.notify('Wrong prediction', line, 'outcome');
      showToast('Prediction missed — nothing logged on a predicted minute');
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

  // Fires for EVERY predicted moment, each with its own pair of alerts — see
  // createCountdownAlerter. The copy names which prediction is coming and how
  // strong it is, because "a roam in 1 minute" means something different for a
  // 19% moment than for a 6% one.
  const checkCountdownAlert = Tracker.createCountdownAlerter((threshold, secondsLeft, entry) => {
    const { moment, window: w } = entry;
    const when = threshold >= 60 ? '1 minute' : `${threshold} seconds`;
    const title = threshold >= 60 ? 'HR roam in ~1 minute' : 'HR roam in ~30 seconds';
    const strength = typeof moment.pct === 'number' ? ` (${moment.pct}%)` : '';
    Tracker.notify(title, `${moment.targetLabel} · ${moment.label}${strength} · ${w.timeLabel}`, 'countdown');
    showToast(`Heads up — ${moment.label.toLowerCase()} roam predicted at `
      + `${moment.targetLabel}, in ${when}.`, { fire: true });
  });

  // Ticks every second: shows a live countdown to the featured window's start,
  // or "HAPPENING NOW" while inside it. Independent of the 5s data poll so it
  // doesn't visibly stall between refreshes. Under 60s remaining, the 3D
  // digits pulse red for urgency.
  function tickCountdown() {
    syncSpotButton();
    // EVERY predicted moment, not just the sure one. The clock runs to whichever
    // comes next — sure, likely, maybe or the wildcard between phases — so a
    // prediction the card names is a prediction the page counts down to.
    const next = Tracker.nextMoment(phases, timeZone, workHours);
    if (!next) return;
    if (next.window !== featured) featured = next.window;
    renderNextLabels(next);

    // The override wins over "happening now": the point of it is to watch the
    // countdown itself, and a live moment would hide the thing under test.
    if (next.now && !countdownOverride) {
      countdownCanvas.style.display = 'none';
      countdownNow.style.display = 'block';
      countdownSr.textContent = 'Happening now';
      return;
    }
    countdownCanvas.style.display = 'block';
    countdownNow.style.display = 'none';
    const secondsLeft = countdownOverride
      ? countdownOverride.secondsLeft()
      : Tracker.secondsUntilTarget(next.moment.targetSec, timeZone, workHours);
    checkCountdownAlert(next, secondsLeft);
    const text = Tracker.formatCountdown(secondsLeft);
    countdownSr.textContent = text;
    if (timer3d) {
      timer3d.setText(text);
      timer3d.setUrgent(secondsLeft > 0 && secondsLeft < URGENT_THRESHOLD_S);
    }
  }

  // The two lines under the clock, describing the moment it is counting to.
  // Written on every tick rather than only on a poll, because the moment the
  // clock points at changes between polls.
  function renderNextLabels(next) {
    const { moment, window: w, dayLabel } = next;
    const pct = typeof moment.pct === 'number' ? ` · ${moment.pct}%` : '';
    const day = dayLabel ? ` ${dayLabel}` : '';
    featuredTierLabel.textContent = `Next predicted roam${dayLabel ? ` · ${dayLabel}` : ''}`;
    windowLabel.textContent = `${moment.targetLabel}${day}`
      + ` · ${moment.label}${pct} · ${moment.tier === 'wildcard'
        ? `between ${w.timeLabel} and the next phase`
        : `in ${w.timeLabel}`}`;
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
  // Past phases are dimmed, but only to 70%: their rows are the ones carrying a
  // hit/miss verdict, and a badge is no use if it is the faintest thing on the
  // card. Opacity cannot be opted out of by a child, so the dimming itself has
  // to stay light enough to read through.
  const PHASE_CARD = 'group overflow-hidden rounded-2xl border border-line bg-ink-900 transition-[border-color] duration-200 '
    + 'data-featured:border-amber-500 data-passed:opacity-70';
  // list-none plus the webkit marker rule removes the browser's own triangle;
  // the chevron below replaces it so it can be styled and rotated.
  const PHASE_HEAD = 'flex cursor-pointer list-none flex-wrap items-center gap-x-2.5 gap-y-1 px-4 py-2.5 '
    + 'transition-colors duration-150 hover:bg-ink-800 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-amber-400 '
    + 'group-data-featured:bg-[rgba(242,169,59,0.08)] [&::-webkit-details-marker]:hidden';
  const PHASE_NUM = 'inline-flex size-[22px] shrink-0 items-center justify-center rounded-full border border-line text-[10px] font-semibold tabular-nums text-fg-faint '
    + 'group-data-featured:border-amber-500 group-data-featured:text-amber-300';
  const PHASE_RANGE = 'text-[15px] font-semibold tracking-[-0.01em] text-fg group-data-featured:text-amber-300 '
    + 'group-data-passed:line-through group-data-passed:decoration-fg-faint';
  // What was actually LOGGED in this range, in the summary line, so a collapsed
  // card answers "did it happen" without being opened.
  //
  // This slot used to repeat the phase's own sure prediction, which is the first
  // row inside the card and told the reader nothing they could not already see.
  // The outcome is the thing worth surfacing on a shut card.
  const PHASE_LOGGED = 'text-[13px] tabular-nums text-good';
  const PHASE_NONE = 'text-[13px] text-fg-faint';
  const PHASE_META = 'ml-auto text-[11px] tabular-nums text-fg-faint';
  const PHASE_CARET = 'shrink-0 text-fg-faint transition-transform duration-200 group-open:rotate-180';

  // One moment inside the range. The separator is on the TOP of each row rather
  // than the bottom of the header: a collapsed card has no rows, and a header
  // with a bottom border and nothing under it is a line hanging in mid-air.
  const TIER_ROW = 'flex items-center gap-3 border-t border-line px-4 py-2.5';
  const TIER_TIME = 'w-[76px] shrink-0 text-[17px] font-semibold tabular-nums tracking-[-0.01em] text-fg data-next:text-amber-300';
  const TIER_SUB = 'min-w-0 flex-1 text-[11px] leading-snug text-fg-faint';
  // The confidence, as the number it always was. sure/likely/maybe was a name
  // for "which quarter-hour of this window holds the most sightings", and a
  // reader had to learn the ranking before the word meant anything; a percentage
  // is the same fact, legible on sight, and comparable between phases. The word
  // survives as the badge's tooltip for anyone who wants it.
  const TIER_BADGE = 'w-[46px] shrink-0 self-start rounded-full border border-line px-2 py-1 text-center text-[10px] font-semibold tabular-nums text-fg-muted '
    + 'data-next:border-amber-500 data-next:text-amber-300';
  const pctLabel = (t) => (typeof t.pct === 'number' ? `${t.pct}%` : '—');

  // Whether a predicted moment landed, once its window has closed. Green for a
  // hit, red for a miss — the two outcomes read at a glance down the card, which
  // is the point of putting them on every row rather than only in the modal.
  //
  // The tinted background is what makes them legible against the row's own
  // border colours; a bare outline pill in the same palette as the tier badge
  // beside it is easy to skim straight past. Built from the --status-*-rgb
  // tokens rather than an opacity modifier: these colours reach Tailwind through
  // var() bridges, and `bg-good/10` silently drops the opacity on those. The
  // tokens are redefined per theme, so the tint follows the palette instead of
  // being one fixed guess at both.
  const VERDICT = 'shrink-0 rounded-full border px-2 py-0.5 text-[9px] font-semibold uppercase tracking-[0.08em]';
  const VERDICT_HIT = `${VERDICT} border-good bg-[rgba(var(--status-good-rgb),0.12)] text-good`;
  const VERDICT_MISS = `${VERDICT} border-bad bg-[rgba(var(--status-bad-rgb),0.12)] text-bad`;

  function verdictBadge(row) {
    const outcome = Tracker.momentOutcome(row, todayMinutes, Tracker.nowMinutes(timeZone), featured || {});
    if (!outcome) return '';
    return outcome === 'hit'
      ? `<span class="${VERDICT_HIT}" title="A sighting was logged in the predicted minute">Hit</span>`
      : `<span class="${VERDICT_MISS}" title="Nothing was logged in the predicted minute">Missed</span>`;
  }

  // What was actually logged in this range, under the predictions it is being
  // measured against. Visually quieter and indented: these are facts, and the
  // rows above them are claims.
  const LOGGED_HEAD = 'flex items-center gap-2 border-t border-line bg-ink-950 px-4 py-1.5 '
    + 'text-[9px] uppercase tracking-[0.1em] text-fg-faint';
  const LOGGED_ROW = 'flex items-center gap-3 border-t border-line/60 bg-ink-950 px-4 py-2';
  const LOGGED_TIME = 'w-[76px] shrink-0 text-[13px] font-semibold tabular-nums text-fg-muted data-matched:text-good';
  const LOGGED_SUB = 'min-w-0 flex-1 text-[11px] leading-snug text-fg-faint';

  // The header's outcome line. Shown on a hit and on a miss alike, because "we
  // predicted 2:07 and nothing was logged" is exactly as much of a result as
  // "we predicted 2:07 and 2:07 happened" — and a blank there reads as missing
  // data rather than as an answer.
  function loggedSummary(w) {
    const rows = Tracker.loggedInPhase(w, todayMinutes);
    if (rows.length === 0) {
      // Only once the range has closed is "nothing" an outcome rather than a
      // window still waiting to be filled.
      const closed = Tracker.nowMinutes(timeZone) >= w.hourEnd * 60
        && w.todayIsWorkDay !== false && !(w.dayOffset > 0);
      return `<span class="${PHASE_NONE}">${closed ? 'no logs — missed' : 'nothing logged yet'}</span>`;
    }
    const shown = rows.slice(0, 3).map((r) => r.label).join(', ');
    const more = rows.length > 3 ? ` +${rows.length - 3}` : '';
    const anyHit = rows.some((r) => r.matched);
    return `<span class="${anyHit ? PHASE_LOGGED : PHASE_NONE}">${shown}${more}</span>`;
  }

  function loggedRows(w) {
    const rows = Tracker.loggedInPhase(w, todayMinutes);
    if (rows.length === 0) return '';
    return `
      <div class="${LOGGED_HEAD}" data-logged="head">Logged in this window · ${rows.length}</div>
      ${rows.map((r) => `
        <div class="${LOGGED_ROW}" data-logged="row">
          <span class="${LOGGED_TIME}" ${r.matched ? 'data-matched' : ''}>${r.label}</span>
          <span class="${LOGGED_SUB}">${r.matched
            ? `landed on the ${r.matched.label} prediction`
            : 'nothing was predicted for this minute'}</span>
          ${r.matched
            ? `<span class="${VERDICT_HIT}">Hit</span>`
            : `<span class="${VERDICT_MISS}">Missed</span>`}
        </div>
      `).join('')}`;
  }

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
  const WILD_BADGE = 'w-[46px] shrink-0 rounded-full border border-dashed border-line px-2 py-1 text-center text-[10px] font-semibold tabular-nums text-fg-faint max-[480px]:ml-auto';

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
    // The two lines under the clock are written by renderNextLabels on every
     // tick: which moment is next changes between polls, and a label refreshed
     // only every five seconds would lag the clock above it.

    featuredDetail.textContent = featuredDetailText(featured);
    tickCountdown();

    if (phasesNote) {
      const left = windows.filter((w) => !w.passed).length;
      phasesNote.textContent = featured.todayIsWorkDay
        ? `${left} of ${windows.length} still to come`
        : `next work day · ${windows.length} phase${windows.length === 1 ? '' : 's'}`;
    }
    // Only the phase in play is expanded BY DEFAULT — but a card the reader has
    // opened stays open, and one they have shut stays shut.
    //
    // The five-second poll rewrites this whole list, which threw away the
    // <details> elements and rebuilt them from `w.featured` every time: open a
    // past phase to read its verdicts and it slammed shut a few seconds later,
    // repeatedly, while you were looking at it. `openState` remembers what the
    // reader actually chose, keyed on the phase's hour so it survives the
    // rebuild, and only phases they have never touched follow the default.
    const caret = typeof Icons !== 'undefined' ? Icons.svg('caret-down', { size: '0.85em' }) : '';
    const isOpen = (w) => (openState.has(w.hourStart) ? openState.get(w.hourStart) : w.featured);
    tierChips.innerHTML = windows.map((w, i) => `
      <details class="${PHASE_CARD}" data-hour="${w.hourStart}" ${isOpen(w) ? 'open' : ''} ${w.featured ? 'data-featured' : ''} ${w.passed && !w.featured ? 'data-passed' : ''}>
        <summary class="${PHASE_HEAD}">
          <span class="${PHASE_NUM}">${i + 1}</span>
          <span class="${PHASE_RANGE}">${w.timeLabel}</span>
          ${loggedSummary(w)}
          <span class="${PHASE_META}">${w.count ? `${w.count} all-time` : w.badge}</span>
          <span class="${PHASE_CARET}">${caret}</span>
        </summary>
        ${momentsOf(w).map((t) => `
          <div class="${TIER_ROW}">
            <span class="${TIER_TIME}" ${w.featured && t.tier === 'sure' ? 'data-next' : ''}>${t.targetLabel}</span>
            <span class="${TIER_SUB}">${tierSubtitle(t)}</span>
            ${verdictBadge(t)}
            <span class="${TIER_BADGE}" title="${t.label}" ${w.featured && t.tier === 'sure' ? 'data-next' : ''}>${pctLabel(t)}</span>
          </div>
        `).join('')}
        ${loggedRows(w)}
      </details>
      ${wildcardOf(w) ? `
        <div class="${WILD_LINK}" data-wildcard>
          <span class="${WILD_TIME}">${wildcardOf(w).targetLabel}</span>
          <span class="${WILD_SUB}">${tierSubtitle(wildcardOf(w))}</span>
          ${verdictBadge(wildcardOf(w))}
          <span class="${WILD_BADGE}" title="${wildcardOf(w).label}">${pctLabel(wildcardOf(w))}</span>
        </div>` : ''}
    `).join('');

    // Re-attached after every rebuild, because the elements these are bound to
    // were just replaced.
    tierChips.querySelectorAll('details[data-hour]').forEach((card) => {
      card.addEventListener('toggle', () => {
        openState.set(Number(card.dataset.hour), card.open);
      });
    });
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
    todayMinutes = Array.isArray(stats.todayMinutes) ? stats.todayMinutes : [];
    const windows = Tracker.classifyWindows(Tracker.normalizeWindows(stats), timeZone, workHours);
    phases = windows;
    renderTiers(windows, stats.total);
    // Same inputs the badges use, so the two cannot drift apart.
    checkPrediction(windows, todayMinutes, Tracker.nowMinutes(timeZone),
      { todayIsWorkDay: windows.length > 0 ? windows[0].todayIsWorkDay !== false : false });
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

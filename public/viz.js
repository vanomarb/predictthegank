/* Shared rendering + polling helpers used by both the public tracker (public.js)
   and the admin console (admin.js). Plain globals — no build step, no bundler. */

const Tracker = (() => {
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      method: opts.method || 'GET',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Request failed.');
    return data;
  }

  // The server buckets the heatmap using TIMEZONE (see .env), not each
  // viewer's own browser timezone. Any raw timestamp rendered client-side
  // (e.g. the field log) needs to use this same timezone, or it can disagree
  // with the heatmap enough to show a different weekday. Fetched once, cached.
  let timezonePromise = null;
  function getTimezone() {
    if (!timezonePromise) {
      timezonePromise = fetch('/api/config')
        .then((res) => res.json())
        .then((cfg) => cfg.timezone || 'UTC')
        .catch(() => 'UTC');
    }
    return timezonePromise;
  }

  function hourLabel(h) {
    if (h === 0) return '12am';
    if (h < 12) return h + 'am';
    if (h === 12) return '12pm';
    return (h - 12) + 'pm';
  }

  function hourMinuteLabel(h, minute) {
    const period = h < 12 ? 'am' : 'pm';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(minute).padStart(2, '0')}${period}`;
  }

  // Heat-ramp step (single hue, monotone dim -> bright) matching the
  // --heat-0..5 tokens in shared.css.
  function heatColor(value, max) {
    if (value <= 0) return 'var(--heat-0)';
    const steps = ['var(--heat-1)', 'var(--heat-2)', 'var(--heat-3)', 'var(--heat-4)', 'var(--heat-5)'];
    const ratio = value / Math.max(1, max);
    const idx = Math.min(steps.length - 1, Math.floor(ratio * (steps.length - 1) + 0.5));
    return steps[idx];
  }

  function attachTooltip(tooltipEl) {
    let visible = false;
    function show(text, x, y) {
      tooltipEl.textContent = text;
      tooltipEl.style.left = x + 12 + 'px';
      tooltipEl.style.top = y + 12 + 'px';
      if (!visible) { tooltipEl.classList.add('visible'); visible = true; }
    }
    function hide() {
      tooltipEl.classList.remove('visible');
      visible = false;
    }
    return { show, hide };
  }

  // Renders the day x hour activity grid into `container` (a plain <div>) as a
  // CSS grid — always fills 100% of the container's width on any screen size,
  // no fixed pixel cells, no horizontal scrolling needed. `tooltip` is the
  // object returned by attachTooltip (optional — omit for a static render).
  function renderHeatmap(container, heatmap, tooltip) {
    const max = Math.max(1, ...heatmap.flat());
    let html = '<div class="hg-cell hg-corner" aria-hidden="true"></div>';
    for (let h = 0; h < 24; h++) {
      // Plain hour numbers, not "12am"/"3pm" — shorter labels leave more room
      // for the 24 flexible columns on narrow screens (the section hint above
      // the grid already explains these are hours of the day).
      html += `<div class="hg-hour">${h % 3 === 0 ? h : ''}</div>`;
    }
    for (let d = 0; d < 7; d++) {
      html += `<div class="hg-day">${DAYS[d]}</div>`;
      for (let h = 0; h < 24; h++) {
        const v = heatmap[d][h];
        html += `<div class="hg-cell" style="background:${heatColor(v, max)}" data-day="${d}" data-hour="${h}" data-count="${v}"></div>`;
      }
    }
    container.innerHTML = html;

    if (!tooltip) return;
    container.querySelectorAll('.hg-cell:not(.hg-corner)').forEach((cell) => {
      cell.addEventListener('mousemove', (e) => {
        const { day, hour, count } = cell.dataset;
        const label = `${DAYS_FULL[day]} ${hourLabel(+hour)} — ${count} sighting${count === '1' ? '' : 's'}`;
        tooltip.show(label, e.clientX, e.clientY);
      });
      cell.addEventListener('mouseleave', tooltip.hide);
    });
  }

  const TIER_ORDER = { sure: 0, likely: 1, maybe: 2, wildcard: 3 };
  const TIER_LABEL = { sure: 'Sure', likely: 'Likely', maybe: 'Maybe', wildcard: 'Wildcard' };
  // Only these tiers can ever become the big featured/countdown display —
  // "wildcard" is a low-confidence hunch (median-gap projection, not a real
  // pattern), so it stays a small chip rather than driving the main countdown.
  const FEATURABLE_TIERS = ['sure', 'likely', 'maybe'];

  // Normalizes /api/sightings/stats' windows into a common shape, preferring
  // the Gemini-refined smartWindows when present (and well-formed) and
  // falling back to the statistical windows otherwise. Always sorted
  // sure -> likely -> maybe -> wildcard regardless of what order the source
  // returned. The wildcard tier is always statistical (stats.wildcard), even
  // when the other 3 are Gemini-refined — it's a residual-frequency concept,
  // not something worth asking Gemini to guess at.
  function normalizeWindows(stats) {
    const useSmart = Array.isArray(stats.smartWindows) && stats.smartWindows.length > 0;
    const source = useSmart ? stats.smartWindows : (stats.windows || []);
    const normalized = source.map((w) => useSmart ? {
      tier: w.tier,
      hourStart: w.predictedHourStart,
      hourEnd: w.predictedHourEnd,
      detail: w.rationale,
      badge: `AI · ${Math.round((w.confidence || 0) * 100)}% confident`,
      isSmart: true,
    } : {
      tier: w.tier,
      hourStart: w.hourStart,
      hourEnd: w.hourEnd,
      detail: `${w.count} of ${stats.total} logged sightings landed here (${w.pct}%).`,
      badge: 'Statistical pattern',
      isSmart: false,
    });

    if (stats.wildcard) {
      const w = stats.wildcard;
      normalized.push({
        tier: 'wildcard',
        hourStart: w.hour,
        hourEnd: w.hour + 1, // only used for coarse passed-detection; display uses `minute` below
        minute: w.minute,
        detail: `Just a hunch — based on the typical gap between sightings, maybe around ${hourMinuteLabel(w.hour, w.minute)}. Low confidence.`,
        badge: 'Small possibility',
        isSmart: false,
      });
    }

    return normalized.sort((a, b) => (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9));
  }

  function windowLabel(w) {
    if (w.minute !== undefined) return hourMinuteLabel(w.hourStart, w.minute);
    return w.hourStart === w.hourEnd ? hourLabel(w.hourStart) : `${hourLabel(w.hourStart)}–${hourLabel(w.hourEnd)}`;
  }

  // Current local time-of-day in the given IANA timezone, down to the second —
  // used both for the coarse "has this window passed" check and to drive a
  // live per-second countdown without needing a timezone-math library.
  function localTimeParts(timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone, hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false }).formatToParts(new Date());
    const get = (type) => parseInt((parts.find((p) => p.type === type) || {}).value, 10) || 0;
    return { hour: get('hour') % 24, minute: get('minute'), second: get('second') };
  }
  function currentHourInTZ(timeZone) {
    return localTimeParts(timeZone).hour;
  }

  // Seconds remaining until the local clock next reads targetHour:00 (today or,
  // if that's already passed, tomorrow) — a pure duration, so this needs no
  // timezone-aware Date arithmetic at all, just today's hour/min/sec.
  function secondsUntilHour(targetHour, timeZone) {
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    const targetSec = (targetHour % 24) * 3600;
    let diff = targetSec - nowSec;
    if (diff < 0) diff += 86400;
    return diff;
  }
  function formatCountdown(totalSeconds) {
    const s = Math.max(0, Math.floor(totalSeconds));
    const pad = (n) => String(n).padStart(2, '0');
    return `${pad(Math.floor(s / 3600))}:${pad(Math.floor((s % 3600) / 60))}:${pad(s % 60)}`;
  }
  // Ticks every second — drives a live countdown display independent of the
  // much slower 5s data poll. Paused when the tab is hidden, like the poller.
  function createTicker(onTick) {
    let timer = null;
    function start() { if (timer) return; onTick(); timer = setInterval(onTick, 1000); }
    function stop() { clearInterval(timer); timer = null; }
    document.addEventListener('visibilitychange', () => { document.hidden ? stop() : start(); });
    return { start, stop };
  }

  // Marks each window "passed" (its hourEnd is behind the current hour) and
  // "active" (currently inside its window), and picks which one to feature
  // big/centered: the first not-yet-passed window in sure -> likely -> maybe
  // order. If every window already passed today, "sure" is re-featured with
  // wrapsToTomorrow so the caller can say so.
  function classifyWindows(windows, timeZone) {
    const now = currentHourInTZ(timeZone);
    const classified = windows.map((w) => ({
      ...w,
      label: TIER_LABEL[w.tier] || w.tier,
      timeLabel: windowLabel(w),
      passed: now >= w.hourEnd,
      active: now >= w.hourStart && now < w.hourEnd,
    }));
    let featuredIndex = classified.findIndex((w) => FEATURABLE_TIERS.includes(w.tier) && !w.passed);
    let wrapsToTomorrow = false;
    if (featuredIndex === -1) {
      featuredIndex = classified.findIndex((w) => FEATURABLE_TIERS.includes(w.tier));
      wrapsToTomorrow = true;
    }
    return classified.map((w, i) => ({ ...w, featured: i === featuredIndex, wrapsToTomorrow: i === featuredIndex && wrapsToTomorrow }));
  }

  function peakLabel(stats) {
    let best = null, bestCount = 0;
    (stats.heatmap || []).forEach((hours, day) => {
      hours.forEach((count, hour) => { if (count > bestCount) { bestCount = count; best = { day, hour }; } });
    });
    if (!best) return '—';
    return `${DAYS[best.day]} ${hourLabel(best.hour)}`;
  }

  // ---- theme toggle (light default, dark opt-in, persisted) ----
  // Accepts one button or several (e.g. admin.html has one per view) — all
  // stay in sync regardless of which one was clicked.
  function initThemeToggle(buttons) {
    const list = Array.isArray(buttons) || buttons instanceof NodeList ? Array.from(buttons) : [buttons];
    const stored = (() => { try { return localStorage.getItem('theme'); } catch (e) { return null; } })();
    if (stored === 'dark') document.documentElement.setAttribute('data-theme', 'dark');
    const syncAll = () => {
      const icon = document.documentElement.getAttribute('data-theme') === 'dark' ? '🌙' : '☀️';
      list.forEach((b) => { b.textContent = icon; });
    };
    syncAll();
    list.forEach((b) => b.addEventListener('click', () => {
      const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
      if (isDark) document.documentElement.removeAttribute('data-theme');
      else document.documentElement.setAttribute('data-theme', 'dark');
      try { localStorage.setItem('theme', isDark ? 'light' : 'dark'); } catch (e) { /* private mode etc — just won't persist */ }
      syncAll();
    }));
  }

  // ---- lightweight confetti burst, no external assets ----
  const CONFETTI_COLORS = ['var(--amber-500)', 'var(--amber-300)', 'var(--status-good)'];
  function confettiBurst(originEl) {
    const rect = originEl.getBoundingClientRect();
    const cx = rect.left + rect.width / 2, cy = rect.top;
    for (let i = 0; i < 18; i++) {
      const piece = document.createElement('div');
      const angle = (Math.random() * Math.PI) + Math.PI; // upward spread
      const dist = 60 + Math.random() * 90;
      piece.style.cssText = `position:fixed; left:${cx}px; top:${cy}px; width:${5 + Math.random() * 4}px; height:${5 + Math.random() * 4}px; background:${CONFETTI_COLORS[i % CONFETTI_COLORS.length]}; border-radius:${Math.random() > 0.5 ? '50%' : '2px'}; pointer-events:none; z-index:60; --dx:${Math.cos(angle) * dist}px; --dy:${Math.sin(angle) * dist}px;`;
      piece.className = 'confetti-piece';
      document.body.appendChild(piece);
      piece.addEventListener('animationend', () => piece.remove());
    }
  }

  const MISSED_PREDICTION_LINES = [
    "The algorithm predicted greatness. The algorithm got clowned.",
    "HR pulled a no-show. Bold strategy, truly.",
    "That window came and went. Not even a shadow.",
    "Statistically embarrassing. We'll allow it, just this once.",
    "The pattern lied to us. We trusted the pattern.",
    "Zero roams detected. Either great behavior or great hiding.",
    "Our confidence was high. Our accuracy was not.",
  ];

  // Watches the currently-featured tier across polls and reports back (via
  // onMiss) the one time a window fully elapses with no new sighting logged
  // during it — i.e. the prediction was wrong. Approximate by design (it
  // compares total sighting count before/after, not a hard per-window
  // check) — good enough for a lighthearted "gotcha," not a claim of rigor.
  function createMissedPredictionWatcher(onMiss) {
    let watched = null; // { tier, hourStart, totalAtStart, notified }
    return function check(windows, total) {
      const current = windows.find((w) => w.featured);
      if (current && current.active) {
        if (!watched || watched.tier !== current.tier || watched.hourStart !== current.hourStart) {
          watched = { tier: current.tier, hourStart: current.hourStart, totalAtStart: total, notified: false };
        }
        return;
      }
      if (!watched || watched.notified) return;
      const match = windows.find((w) => w.tier === watched.tier && w.hourStart === watched.hourStart);
      if (match && match.passed) {
        watched.notified = true;
        if (total <= watched.totalAtStart) {
          onMiss(MISSED_PREDICTION_LINES[Math.floor(Math.random() * MISSED_PREDICTION_LINES.length)]);
        }
      }
    };
  }

  // setInterval wrapper paused via the Page Visibility API. Idempotent start.
  function createPoller(fn, intervalMs) {
    let timer = null;
    function tick() { fn().catch(() => {}); }
    function start() {
      if (timer) return;
      tick();
      timer = setInterval(tick, intervalMs);
    }
    function stop() {
      clearInterval(timer);
      timer = null;
    }
    document.addEventListener('visibilitychange', () => {
      document.hidden ? stop() : start();
    });
    return { start, stop };
  }

  return {
    DAYS, DAYS_FULL, api, hourLabel, heatColor, attachTooltip, renderHeatmap,
    normalizeWindows, classifyWindows, peakLabel, createPoller, createTicker,
    secondsUntilHour, formatCountdown, getTimezone, initThemeToggle, confettiBurst,
    createMissedPredictionWatcher,
  };
})();

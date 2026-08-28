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
  // The same /api/config payload also carries the office's work hours, which
  // gate the "log a sighting" buttons — one fetch, cached, shared by both.
  const CONFIG_FALLBACK = {
    timezone: 'UTC',
    workHours: { start: 9, end: 18, days: [1, 2, 3, 4, 5] },
    countdownOverrideMs: null,
  };
  let configPromise = null;
  function getConfig() {
    if (!configPromise) {
      configPromise = fetch('/api/config')
        .then((res) => res.json())
        .then((cfg) => ({
          timezone: cfg.timezone || CONFIG_FALLBACK.timezone,
          workHours: cfg.workHours || CONFIG_FALLBACK.workHours,
          countdownOverrideMs: cfg.countdownOverrideMs || null,
        }))
        .catch(() => CONFIG_FALLBACK);
    }
    return configPromise;
  }
  function getTimezone() {
    return getConfig().then((cfg) => cfg.timezone);
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

  // Heat-ramp step (single hue, monotone dim -> bright). Returns the Tailwind
  // utility rather than a colour, so the cells carry a class like every other
  // styled thing in the app instead of an inline background. bg-heat-* is bridged
  // to the --heat-0..5 tokens in tailwind-config.js, so it still re-themes.
  function heatColor(value, max) {
    if (value <= 0) return 'bg-heat-0';
    const steps = ['bg-heat-1', 'bg-heat-2', 'bg-heat-3', 'bg-heat-4', 'bg-heat-5'];
    const ratio = value / Math.max(1, max);
    const idx = Math.min(steps.length - 1, Math.floor(ratio * (steps.length - 1) + 0.5));
    return steps[idx];
  }

  // Placed relative to the pointer, but flipped and clamped so it is always
  // fully on screen. The naive "always down-and-right of the cursor" version
  // pushed the tooltip off the right edge for the last heatmap columns as soon
  // as the window got narrow — the cells you most want to read are the ones
  // nearest the edge, so it failed exactly where it mattered.
  const TOOLTIP_GAP = 12;   // from the pointer, so the cursor never covers it
  const TOOLTIP_EDGE = 8;   // minimum breathing room against the viewport
  function attachTooltip(tooltipEl) {
    let visible = false;
    let hideTimer = null;

    function place(x, y, coarse) {
      // Measured after the text is set. The tooltip is hidden with opacity, not
      // display, so it always has a real box to measure.
      const w = tooltipEl.offsetWidth;
      const h = tooltipEl.offsetHeight;
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      let left = x + TOOLTIP_GAP;
      // Prefer to the right of the pointer; flip left when that overflows.
      if (left + w > vw - TOOLTIP_EDGE) left = x - TOOLTIP_GAP - w;
      // Narrower than the tooltip on both sides (very small screens): centre on
      // the pointer and clamp, which keeps it readable even if it overlaps.
      if (left < TOOLTIP_EDGE) left = Math.max(TOOLTIP_EDGE, Math.min(vw - w - TOOLTIP_EDGE, x - w / 2));

      // A finger covers what is directly below it, so on touch the tooltip goes
      // above the contact point by default and only drops below if it must.
      let top = coarse ? y - TOOLTIP_GAP - h : y + TOOLTIP_GAP;
      if (top + h > vh - TOOLTIP_EDGE) top = y - TOOLTIP_GAP - h;
      if (top < TOOLTIP_EDGE) top = Math.min(vh - h - TOOLTIP_EDGE, y + TOOLTIP_GAP);
      if (top < TOOLTIP_EDGE) top = TOOLTIP_EDGE;

      tooltipEl.style.left = Math.round(left) + 'px';
      tooltipEl.style.top = Math.round(top) + 'px';
    }

    // Visibility is an attribute, not a second opacity utility: the markup
    // carries `opacity-0 data-visible:opacity-100`, and the attribute selector
    // outranks the base class. Two competing opacity utilities on one element
    // would be resolved by compiled source order, which is arbitrary.
    function setVisible(on) {
      if (on) tooltipEl.dataset.visible = '';
      else delete tooltipEl.dataset.visible;
      visible = on;
    }

    function show(text, x, y, opts) {
      const coarse = !!(opts && opts.coarse);
      tooltipEl.textContent = text;
      place(x, y, coarse);
      if (!visible) setVisible(true);
      // Touch has no "mouse leave", so a tapped tooltip dismisses itself.
      clearTimeout(hideTimer);
      if (coarse) hideTimer = setTimeout(hide, 2200);
    }

    function hide() {
      clearTimeout(hideTimer);
      setVisible(false);
    }

    return { show, hide };
  }

  // Renders the day x hour activity grid into `container` (a plain <div>) as a
  // CSS grid — always fills 100% of the container's width on any screen size,
  // no fixed pixel cells, no horizontal scrolling needed. `tooltip` is the
  // object returned by attachTooltip (optional — omit for a static render).
  // Utility strings for the grid's parts. Named constants because this markup
  // is built as a string — there is no element in the document to put classes
  // on — and repeating them inline would make the loops unreadable.
  // min-w-0 on every cell and label matters: grid items default to
  // min-width:auto, so a label wider than its 1fr column would force the whole
  // grid to overflow instead of the column shrinking.
  const HG_CORNER = 'bg-transparent';
  const HG_HOUR = 'min-w-0 self-end overflow-hidden pb-[3px] text-center text-[9px] whitespace-nowrap text-fg-faint';
  const HG_DAY = 'flex min-w-0 items-center overflow-hidden text-[10px] whitespace-nowrap text-fg-faint';
  const HG_CELL = 'relative aspect-square min-w-0 cursor-default rounded-[3px] hover:outline-[1.5px] hover:outline-fg-muted';

  function renderHeatmap(container, heatmap, tooltip) {
    const max = Math.max(1, ...heatmap.flat());
    let html = `<div class="${HG_CORNER}" aria-hidden="true"></div>`;
    for (let h = 0; h < 24; h++) {
      // Plain hour numbers, not "12am"/"3pm" — shorter labels leave more room
      // for the 24 flexible columns on narrow screens (the section hint above
      // the grid already explains these are hours of the day).
      html += `<div class="${HG_HOUR}">${h % 3 === 0 ? h : ''}</div>`;
    }
    for (let d = 0; d < 7; d++) {
      html += `<div class="${HG_DAY}">${DAYS[d]}</div>`;
      for (let h = 0; h < 24; h++) {
        const v = heatmap[d][h];
        html += `<div class="${HG_CELL} ${heatColor(v, max)}" data-cell data-day="${d}" data-hour="${h}" data-count="${v}"></div>`;
      }
    }
    container.innerHTML = html;

    if (!tooltip) return;
    // Pointer events, not mouse events: a tap on a phone raises pointerdown but
    // may never raise the mouseleave that used to be the only way to dismiss
    // this, which left the tooltip stranded on screen.
    container.querySelectorAll('[data-cell]').forEach((cell) => {
      const reveal = (e) => {
        const { day, hour, count } = cell.dataset;
        const label = `${DAYS_FULL[day]} ${hourLabel(+hour)} — ${count} sighting${count === '1' ? '' : 's'}`;
        tooltip.show(label, e.clientX, e.clientY, { coarse: e.pointerType !== 'mouse' });
      };
      cell.addEventListener('pointermove', reveal);
      cell.addEventListener('pointerdown', reveal);
      cell.addEventListener('pointerleave', tooltip.hide);
      cell.addEventListener('pointercancel', tooltip.hide);
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

  // Day of week in the office timezone, 0 = Sunday (same indexing as the
  // heatmap and as WORK_DAYS in .env).
  function currentDayInTZ(timeZone) {
    const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date());
    const idx = DAYS.indexOf(short);
    return idx === -1 ? new Date().getDay() : idx;
  }

  // ---- a window's range, and where the clock sits in it ----
  // Grace for a sighting logged OUTSIDE a window's range. Applies on both sides:
  // spotting HR 20s before the window opens, or 20s after it closes, is still
  // the predicted roam.
  const WINDOW_GRACE_S = 30;

  // Every tier except wildcard predicts an HOUR RANGE (10:00-11:00). Wildcard is
  // the exception: it is a minute-level hunch ("maybe around 5:42pm"), so its
  // range is that exact instant and it is judged against it — an hour-wide range
  // would make the loosest prediction in the app the easiest one to satisfy.
  function windowRange(w) {
    if (w.tier === 'wildcard') {
      const at = (w.hourStart % 24) * 3600 + (w.minute || 0) * 60;
      return { startSec: at, endSec: at, exact: true };
    }
    return { startSec: (w.hourStart % 24) * 3600, endSec: (w.hourEnd % 24) * 3600, exact: false };
  }

  // Seconds until the window opens (positive), 0 while inside it, or negative
  // seconds since it closed. A window that is not today is reported as far away
  // rather than as "just closed", so nothing arms on a weekend.
  const NOT_TODAY = 86400;
  function windowPhase(w, timeZone) {
    if (!w) return NOT_TODAY;
    // Only the work-day check belongs here. Guarding on dayOffset as well looks
    // sensible and is wrong: the moment a window passes, dayOffset flips to 1 —
    // it points at TOMORROW's occurrence, because that is the next one to count
    // down to — and suppressing the phase then means the verdict for the window
    // that just closed never lands at all.
    if (w.todayIsWorkDay === false) return NOT_TODAY;
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    const { startSec, endSec } = windowRange(w);
    if (nowSec < startSec) return startSec - nowSec;
    if (nowSec > endSec) return -(nowSec - endSec);
    return 0;
  }

  // ---- work hours ----
  // Whether a sighting can be logged right now, plus the line to show when it
  // can't. Evaluated against the office clock (see services/work-hours.js), not
  // the viewer's, and re-evaluated every tick so a button that is open at 17:59
  // closes itself at 18:00 without a reload.
  function workHoursState(timeZone, workHours) {
    const wh = workHours || CONFIG_FALLBACK.workHours;
    const { hour, minute } = localTimeParts(timeZone);
    const day = currentDayInTZ(timeZone);
    const isWorkDay = wh.days.includes(day);
    const open = isWorkDay && hour >= wh.start && hour < wh.end;
    if (open) {
      return { open: true, label: '', closesAt: hourLabel(wh.end) };
    }
    const windowLabel = `${hourLabel(wh.start)}–${hourLabel(wh.end)}`;
    if (isWorkDay && hour < wh.start) {
      const mins = (wh.start - hour) * 60 - minute;
      const soon = mins <= 90;
      return {
        open: false,
        label: soon
          ? `Logging opens in ${mins} min (${windowLabel})`
          : `Logging opens at ${hourLabel(wh.start)} (${windowLabel})`,
      };
    }
    // After hours, or a non-work day: name the next day that is one.
    const nextDay = wh.days.includes(day) && hour < wh.start
      ? day
      : (() => {
        for (let step = 1; step <= 7; step += 1) {
          const cand = (day + step) % 7;
          if (wh.days.includes(cand)) return cand;
        }
        return day;
      })();
    const dayWord = nextDay === (day + 1) % 7 ? 'tomorrow' : DAYS_FULL[nextDay];
    return { open: false, label: `Logging reopens ${dayWord} at ${hourLabel(wh.start)}` };
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
  // ---- work-day aware scheduling ----
  // The predicted hours come from historical sightings, which only ever happen
  // on work days, so "the next 10am" has to mean the next 10am ON A WORK DAY.
  // Without this the countdown spends every weekend counting down to a roam
  // that cannot happen, and on a Friday evening it promises one "tomorrow".
  function isWorkDay(day, workHours) {
    return (workHours || CONFIG_FALLBACK.workHours).days.includes(day);
  }

  // Days from today until the window starting at hourStart next comes round on a
  // work day: 0 = still to come today, 1 = tomorrow, 2+ = later in the week.
  function daysUntilWindow(hourStart, timeZone, workHours) {
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    const targetSec = (hourStart % 24) * 3600;
    const today = currentDayInTZ(timeZone);
    for (let offset = 0; offset < 8; offset += 1) {
      if (!isWorkDay((today + offset) % 7, workHours)) continue;
      if (offset === 0 && targetSec <= nowSec) continue; // today's slot is gone
      return offset;
    }
    return 1; // every day excluded (a misconfigured WORK_DAYS) — don't hang
  }

  // Seconds until that window opens. Days are counted as 24h, the same
  // assumption the rest of this file makes; in a timezone with DST a countdown
  // spanning the changeover is out by an hour until it passes.
  function secondsUntilWindow(hourStart, timeZone, workHours) {
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    const targetSec = (hourStart % 24) * 3600;
    return daysUntilWindow(hourStart, timeZone, workHours) * 86400 + targetSec - nowSec;
  }

  // '' for today, 'tomorrow' for +1, otherwise the weekday name.
  function dayOffsetLabel(offset, timeZone) {
    if (offset <= 0) return '';
    if (offset === 1) return 'tomorrow';
    return DAYS_FULL[(currentDayInTZ(timeZone) + offset) % 7];
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
  // order.
  //
  // All of that is scoped to work days. On a Saturday nothing is passed and
  // nothing is active — the whole day is simply not a roaming day — so the
  // featured window is the first of the next work day, and dayOffset/dayLabel
  // say which day that is ('' today, 'tomorrow', or 'Monday'). The caller needs
  // that instead of a bare "tomorrow" flag, which was wrong every weekend.
  function classifyWindows(windows, timeZone, workHours) {
    const now = currentHourInTZ(timeZone);
    const todayIsWorkDay = isWorkDay(currentDayInTZ(timeZone), workHours);
    const classified = windows.map((w) => ({
      ...w,
      label: TIER_LABEL[w.tier] || w.tier,
      timeLabel: windowLabel(w),
      passed: todayIsWorkDay && now >= w.hourEnd,
      active: todayIsWorkDay && now >= w.hourStart && now < w.hourEnd,
    }));
    let featuredIndex = classified.findIndex((w) => FEATURABLE_TIERS.includes(w.tier) && !w.passed);
    if (featuredIndex === -1) featuredIndex = classified.findIndex((w) => FEATURABLE_TIERS.includes(w.tier));

    const featured = classified[featuredIndex];
    // A window that is happening RIGHT NOW is today's, however its start hour
    // compares to the clock: daysUntilWindow looks for the next time the window
    // OPENS, which is tomorrow once the current one is under way. Labelling it
    // "· tomorrow" while the page says HAPPENING NOW would be nonsense.
    const dayOffset = !featured || featured.active
      ? 0
      : daysUntilWindow(featured.hourStart, timeZone, workHours);
    const dayLabel = dayOffsetLabel(dayOffset, timeZone);

    return classified.map((w, i) => (i === featuredIndex
      ? { ...w, featured: true, dayOffset, dayLabel, todayIsWorkDay }
      : { ...w, featured: false, dayOffset: null, dayLabel: '', todayIsWorkDay }));
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
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      list.forEach((b) => {
        // The icon shows the CURRENT theme; the label says what clicking does.
        if (typeof Icons !== 'undefined') Icons.set(b, dark ? 'moon' : 'sun');
        b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
      });
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

  // ---- desktop notifications ----
  // The point of a countdown warning is to reach someone who is NOT looking at
  // the page, so these go out as real Notifications when permission allows, and
  // as an in-page toast either way (the caller supplies the toast).
  //
  // Permission is opt-in behind the bell button: browsers require a user gesture
  // for requestPermission(), and asking on page load is both rude and usually
  // auto-denied. The choice is remembered so the bell reflects reality after a
  // reload rather than resetting to off.
  const NOTIFY_KEY = 'notify';
  const notifySupported = () => typeof Notification !== 'undefined';

  function notifyPermission() {
    if (!notifySupported()) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
  }

  function notifyWanted() {
    if (notifyPermission() !== 'granted') return false;
    try { return localStorage.getItem(NOTIFY_KEY) !== 'off'; } catch (e) { return true; }
  }

  function setNotifyWanted(on) {
    try { localStorage.setItem(NOTIFY_KEY, on ? 'on' : 'off'); } catch (e) { /* private mode */ }
  }

  async function requestNotifyPermission() {
    if (!notifySupported()) return 'unsupported';
    if (Notification.permission !== 'default') return Notification.permission;
    try { return await Notification.requestPermission(); } catch (e) { return Notification.permission; }
  }

  // tag: replaces an earlier notification with the same tag instead of stacking,
  // so a 60s warning is superseded by the 30s one rather than piling up.
  function notify(title, body, tag) {
    if (!notifyWanted()) return false;
    try {
      new Notification(title, { body, tag, icon: NOTIFY_ICON, badge: NOTIFY_ICON });
      return true;
    } catch (e) {
      return false; // some browsers throw outside a service worker; the toast still fires
    }
  }

  // The favicon, inline, so a notification is recognisable without another request.
  const NOTIFY_ICON = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='15' fill='%230a1310' stroke='%23ffb648' stroke-width='2'/%3E%3Ccircle cx='16' cy='16' r='3.5' fill='%23ffb648'/%3E%3C/svg%3E";

  // Wires the bell button(s). Clicking asks for permission the first time, then
  // toggles. onChange is called with the new state so the page can say so.
  function initNotifyToggle(buttons, onChange) {
    const list = Array.isArray(buttons) || buttons instanceof NodeList ? Array.from(buttons) : [buttons];
    const present = list.filter(Boolean);

    const sync = () => {
      const on = notifyWanted();
      const perm = notifyPermission();
      present.forEach((b) => {
        if (typeof Icons !== 'undefined') Icons.set(b, on ? 'bell' : 'bell-slash');
        b.setAttribute('aria-pressed', String(on));
        b.setAttribute('aria-label', on ? 'Turn off roam alerts' : 'Turn on roam alerts');
        b.title = perm === 'denied'
          ? 'Notifications are blocked in your browser settings'
          : (on ? 'Roam alerts on' : 'Roam alerts off');
        b.disabled = perm === 'unsupported' || perm === 'denied';
      });
      return on;
    };

    present.forEach((b) => b.addEventListener('click', async () => {
      if (notifyPermission() === 'default') {
        await requestNotifyPermission();
        // Permission granted through this gesture means they want alerts on.
        if (notifyPermission() === 'granted') setNotifyWanted(true);
      } else {
        setNotifyWanted(!notifyWanted());
      }
      const on = sync();
      if (onChange) onChange(on, notifyPermission());
    }));

    sync();
    return { sync, isOn: notifyWanted };
  }

  // ---- countdown override (testing) ----
  // Anchored at creation rather than recomputed from a fixed value, so the
  // countdown genuinely ticks down through the alert thresholds and the urgent
  // state instead of sitting still. It stops at zero; reload to run it again.
  // See COUNTDOWN_OVERRIDE_MS in .env.example.
  function createCountdownOverride(ms) {
    if (!ms || ms <= 0) return null;
    const deadline = Date.now() + ms;
    return {
      ms,
      secondsLeft() {
        return Math.max(0, Math.ceil((deadline - Date.now()) / 1000));
      },
    };
  }

  // ---- countdown alerts ----
  // Fires once per threshold per window. Keyed on the window itself so the 5s
  // data poll re-rendering the same window does not re-alert, and so the next
  // window starts with a clean slate.
  const ALERT_THRESHOLDS_S = [60, 30];

  function createCountdownAlerter(onAlert) {
    let key = null;
    let fired = new Set();
    return function check(featured, secondsLeft) {
      if (!featured || featured.active) return;
      const next = featured.tier + '@' + featured.hourStart + '+' + (featured.dayOffset || 0);
      if (next !== key) { key = next; fired = new Set(); }
      if (secondsLeft <= 0) return;

      // The TIGHTEST threshold already crossed is the one that matters. Firing
      // the first match instead would mean a page opened with 12s left
      // announcing "one minute" — a moment that had already gone — and then
      // "30 seconds" a tick later. Every looser threshold is marked spent at the
      // same time, because their moment has demonstrably passed.
      let target = null;
      for (const threshold of ALERT_THRESHOLDS_S) if (secondsLeft <= threshold) target = threshold;
      if (target === null || fired.has(target)) return;

      for (const threshold of ALERT_THRESHOLDS_S) if (threshold >= target) fired.add(threshold);
      onAlert(target, secondsLeft, featured);
    };
  }

  // ---- lottie ----
  // Every lottie-web build ships as UMD exporting the global `bodymovin`, NOT
  // `lottie` — including the file named lottie.min.js, on both cdnjs and
  // jsdelivr. Code that checked `typeof lottie === 'undefined'` therefore always
  // took the fallback path, so no Lottie in this app had ever actually played:
  // the confetti quietly used the DOM burst and both outcome modals showed their
  // static icons. Resolved in one place so a future CDN or build swap cannot
  // reintroduce that silently.
  function lottieLib() {
    if (typeof window === 'undefined') return null;
    return window.lottie || window.bodymovin || null;
  }

  // ---- toasts ----
  // Shared by both pages, which had identical copies before. The bubble is
  // `relative` so the fire layer can sit around its edges, and the label is
  // `relative` so it paints above the flames and stays readable.
  const TOAST_MS = 3200;

  // The entrance animation lives on a WRAPPER, not on the bubble itself. An
  // element that animates opacity or transform becomes a stacking context, and
  // inside one a negative-z child paints above its parent's background instead
  // of behind it — so animating the bubble directly put the flames over the
  // bubble's face for the 250ms the animation lasted. Keeping the animation one
  // level out means the bubble is never a stacking context and the flames stay
  // behind it throughout.
  const TOAST_WRAP_CLASS = 'mt-2 animate-toast-in';
  const TOAST_CLASS = 'relative rounded-xl border border-line-strong bg-ink-800 px-[18px] py-[11px] text-[13px] text-fg-muted shadow-[0_8px_24px_rgba(0,0,0,0.35)]';
  // Fire on a toast, Messenger-style: flames rising from BEHIND the bubble.
  //
  // fire.lottie.json is a LottieFiles asset (Lottie Simple License, "Fire" by
  // LottieFiles Mobile) — ONE centred flame on a transparent 1080x1080 canvas.
  // A single instance cannot span a bubble: stretched it becomes a smear, and
  // letter-boxed it is a lone flame in the middle. So the toast mounts a row of
  // copies across its top edge, each square (aspect preserved), at staggered
  // sizes, and each started at a different frame so they do not flicker in
  // unison. Five 2-layer instances is lighter than the 19-layer composition this
  // replaces.
  //
  // -z-10 is what puts them BEHIND the bubble's own background: the bubble is
  // position:relative with no z-index, so it is not a stacking context and a
  // negative-z child paints beneath its background.
  const TOAST_FIRE_CLASS = 'pointer-events-none absolute -z-10';
  // left %, bottom px, size px — hand-placed rather than random so a toast looks
  // the same every time. The outer two hang past the bubble's ends.
  // Sizes are generous because the asset has a lot of empty canvas around the
  // flame — the visible tongue is roughly 60% of its box, so a 60px box renders
  // a 35px flame. Positions overlap and hang past both ends so the row reads as
  // one fire rather than five separate flames.
  const TOAST_FLAMES = [
    { left: -14, bottom: -6, size: 92, frame: 0 },
    { left: 6, bottom: -2, size: 112, frame: 24 },
    { left: 30, bottom: 0, size: 124, frame: 48 },
    { left: 55, bottom: -2, size: 112, frame: 12 },
    { left: 78, bottom: -6, size: 96, frame: 66 },
  ];

  function toast(host, msg) {
    if (!host) return null;
    const wrap = document.createElement('div');
    wrap.className = TOAST_WRAP_CLASS;
    const bubble = document.createElement('div');
    bubble.className = TOAST_CLASS;

    // One span per flame. Their geometry is per-instance arithmetic, so it goes
    // in inline styles: there is no Tailwind class for "the third flame".
    const fires = TOAST_FLAMES.map((f) => {
      const span = document.createElement('span');
      span.className = TOAST_FIRE_CLASS;
      span.style.cssText = `left:${f.left}%; bottom:${f.bottom}px; `
        + `width:${f.size}px; height:${f.size}px;`;
      bubble.appendChild(span);
      return span;
    });

    const label = document.createElement('span');
    label.className = 'relative';
    label.textContent = msg;
    bubble.appendChild(label);
    wrap.appendChild(bubble);
    host.appendChild(wrap);

    // Aspect preserved (the default 'meet'): each span is square and holds one
    // whole flame. goToAndPlay puts each copy at a different point in the loop.
    const lottie = lottieLib();
    const anims = [];
    if (lottie) {
      fires.forEach((span, i) => {
        const anim = lottie.loadAnimation({
          container: span,
          renderer: 'svg',
          loop: true,
          autoplay: true,
          path: '/fire.lottie.json',
        });
        anim.addEventListener('DOMLoaded', () => anim.goToAndPlay(TOAST_FLAMES[i].frame, true));
        anims.push(anim);
      });
    }

    // A lottie keeps its own requestAnimationFrame loop; removing the node is
    // not enough to stop it, so every instance has to be destroyed explicitly
    // or each toast leaks animations that run for the life of the page.
    setTimeout(() => {
      anims.forEach((a) => a.destroy());
      wrap.remove();
    }, TOAST_MS);

    return bubble;
  }

  // ---- pre-warming the toast's classes ----
  // Tailwind's browser build compiles a class only once it has seen it in the
  // DOM. Every class above appears for the first time when the FIRST toast is
  // built, so for the ~400ms until the observer catches up that toast rendered
  // with no background, no padding, and — worst of all — no `-z-10`, which left
  // the flames painting on top of it. What you saw was fire instead of a toast.
  //
  // Putting one throwaway element carrying those exact classes into the document
  // at startup gets them compiled during page load, so the first toast is styled
  // the moment it appears. It is parked off-screen at zero size and never
  // interactive; it stays in the DOM because removing it is not worth a second
  // reflow, and Tailwind keeps the compiled rules either way.
  function warmToastClasses() {
    if (typeof document === 'undefined' || !document.body) return;
    const warm = document.createElement('div');
    warm.setAttribute('aria-hidden', 'true');
    warm.style.cssText = 'position:fixed; left:-9999px; top:0; width:0; height:0; overflow:hidden;';
    warm.className = `${TOAST_WRAP_CLASS} ${TOAST_CLASS} ${TOAST_FIRE_CLASS}`;
    document.body.appendChild(warm);
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', warmToastClasses);
    else warmToastClasses();
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
      piece.className = 'animate-confetti-fly';
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

  const HIT_PREDICTION_LINES = [
    "Called it. HR arrived on schedule, like clockwork.",
    "Prediction: correct. Somebody give the algorithm a raise.",
    "Right window, right roam. We are basically meteorologists now.",
    "The pattern held. Deeply satisfying, faintly alarming.",
    "Nailed it — that is exactly when it said.",
    "Textbook. The model saw it coming.",
  ];

  const pick = (lines) => lines[Math.floor(Math.random() * lines.length)];

  // Watches the currently-featured tier across polls and reports the outcome
  // once, when the window elapses: a hit if any sighting was logged for it, a
  // miss if none was. Approximate by design (it compares the total sighting
  // count before and after, not a hard per-window check) — good enough for a
  // lighthearted verdict, not a claim of rigor.
  //
  // GRACE. A window is "in play" from WINDOW_GRACE_S before it opens until
  // WINDOW_GRACE_S after it closes, and any sighting logged in that span counts
  // for it. Someone who spots HR at 09:59:40 for a 10:00 window — or at 11:00:20
  // as it wanders off — has confirmed the prediction; the naive "did the total
  // move while the window was active" check calls both of those a miss, which is
  // plainly wrong.
  //
  // The baseline is taken on the first poll that finds the window in play, so
  // everything logged from that moment on counts, and the verdict is held back
  // until the trailing grace has elapsed.
  //
  // The phase (see windowPhase) is what makes this work for wildcard too: its
  // range is a single instant, so it is never "active" in the hour sense and a
  // flag-based watcher could never arm on it at all.
  //
  // Takes { onHit, onMiss, graceS }; any may be omitted. `check` wants the phase
  // of the featured window: seconds until it opens, 0 inside, negative since it
  // closed.
  function createPredictionWatcher(handlers) {
    const { onHit, onMiss } = handlers || {};
    const graceS = (handlers && handlers.graceS) != null ? handlers.graceS : WINDOW_GRACE_S;
    const keyOf = (w) => `${w.tier}@${w.hourStart}@${w.minute || 0}`;
    let watched = null; // { key, totalAtStart, totalAtEnd, notified }

    return function check(windows, total, phase) {
      const current = windows.find((w) => w.featured);
      const p = typeof phase === 'number' ? phase : NOT_TODAY;

      // In play: inside the range, or within grace of either end.
      if (current && Math.abs(p) <= graceS) {
        const key = keyOf(current);
        if (!watched || watched.key !== key) {
          watched = { key, totalAtStart: total, totalAtEnd: total, notified: false };
        } else {
          // Keep the running count for as long as the window is in play. The
          // verdict compares THIS, not the total at verdict time: a sighting
          // logged after the grace expired belongs to no window, and comparing
          // against the later total would hand it to this one — which made a
          // wildcard "hit" out of a sighting five minutes off its predicted
          // minute.
          watched.totalAtEnd = total;
        }
        return;
      }

      // Past the trailing grace: time to call it.
      if (!watched || watched.notified) return;
      if (p < 0 && -p > graceS) {
        watched.notified = true;
        const logged = watched.totalAtEnd - watched.totalAtStart;
        if (logged <= 0) {
          if (onMiss) onMiss(pick(MISSED_PREDICTION_LINES));
        } else if (onHit) {
          onHit(pick(HIT_PREDICTION_LINES), logged);
        }
      }
    };
  }

  // Kept so nothing that only wants the miss has to change shape.
  function createMissedPredictionWatcher(onMiss) {
    return createPredictionWatcher({ onMiss });
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
    secondsUntilHour, secondsUntilWindow, daysUntilWindow, isWorkDay,
    windowRange, windowPhase, WINDOW_GRACE_S,
    formatCountdown, getConfig, getTimezone, initThemeToggle,
    lottieLib, toast, confettiBurst, createMissedPredictionWatcher, createPredictionWatcher,
    workHoursState, currentDayInTZ,
    notify, notifyPermission, notifyWanted, requestNotifyPermission,
    initNotifyToggle, createCountdownAlerter, ALERT_THRESHOLDS_S,
    createCountdownOverride,
  };
})();

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
    // Minutes since midnight, end exclusive. The server decides them and does
    // all the prediction work around them (see BREAK_TIMES); the page gets them
    // only so it can say WHY nothing is predicted in the middle of the day.
    breaks: [],
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
          breaks: Array.isArray(cfg.breaks) ? cfg.breaks : CONFIG_FALLBACK.breaks,
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

  const TIER_LABEL = { sure: 'Sure', likely: 'Likely', maybe: 'Maybe', wildcard: 'Wildcard' };

  // Normalizes /api/sightings/stats' windows into a common shape, preferring
  // the Gemini-refined smartWindows when present (and well-formed) and falling
  // back to the statistical ones otherwise.
  //
  // A window is a PHASE: one hour range, plus the sure/likely/maybe/wildcard
  // moments inside it (see tiersForHour in routes/sightings.js). The tiers used
  // to be three separate windows at three different hours, which read as four
  // categories to choose between rather than as one schedule; they are rows
  // inside a range now, and the ranges are the phases of the day.
  //
  // Phases come back in clock order, because that is what a schedule is. The
  // sighting count rides along so the page can still say how much is behind
  // each one.
  function normalizeWindows(stats) {
    const useSmart = Array.isArray(stats.smartWindows) && stats.smartWindows.length > 0;
    const source = useSmart ? stats.smartWindows : (stats.windows || []);
    return source
      .map((w) => {
        // predictedHourStart/End is the shape Gemini itself returns. GET /stats
        // converts those to hourStart/hourEnd before sending, so this only
        // matters against a server that has not been redeployed yet — but the
        // failure mode is hourStart: undefined and a NaN:NaN:NaN countdown,
        // which is worth ruling out. It has to be resolved BEFORE tierRows,
        // which falls back to the window's own start hour.
        const hourStart = w.hourStart != null ? w.hourStart : w.predictedHourStart;
        const hourEnd = w.hourEnd != null ? w.hourEnd : w.predictedHourEnd;
        return {
          hourStart,
          hourEnd,
          count: w.count,
          pct: w.pct,
          tiers: tierRows(w, hourStart),
          detail: useSmart
            ? w.rationale
            : `${w.count} of ${stats.total} logged sightings landed in this window (${w.pct}%).`,
          badge: useSmart ? `AI \u00b7 ${Math.round((w.confidence || 0) * 100)}% confident` : 'Statistical pattern',
          isSmart: useSmart,
        };
      })
      .sort((a, b) => a.hourStart - b.hourStart);
  }

  // The rows inside a phase, each with its clock label worked out once.
  //
  // A payload without `tiers` is one from a server that predates phases (or a
  // hand-built fixture): rather than render nothing, the window's own tier and
  // predicted time become a single row, so an old server degrades to the old
  // one-moment-per-window display instead of a blank card.
  function tierRows(w, hourStart) {
    const rows = Array.isArray(w.tiers) && w.tiers.length
      ? w.tiers
      : [{
        tier: w.tier || 'sure',
        hour: w.predictedHour != null ? w.predictedHour : hourStart,
        minute: w.predictedMinute != null ? w.predictedMinute : (w.minute || 0),
        from: w.predictedFrom != null ? w.predictedFrom : null,
      }];
    return rows.map((t) => {
      const sec = (t.hour % 24) * 3600 + t.minute * 60;
      return {
        ...t,
        // Share of all logged sightings in this moment's stretch. Replaces the
        // sure/likely/maybe wording on screen: the tier was a name for a
        // number, and the number says the same thing without asking the reader
        // to remember which of three words outranks which.
        pct: typeof t.pct === 'number' ? t.pct : null,
        // windowFrom/windowTo is the span the moment is answerable for: the
        // predicted minute itself and nothing after it, so 2:07pm is met from
        // 2:07:00 to 2:07:59 and missed at 2:08. See HIT_TOLERANCE_MIN in
        // routes/sightings.js.
        windowFrom: t.windowFrom,
        windowTo: t.windowTo,
        label: TIER_LABEL[t.tier] || t.tier,
        targetSec: sec,
        targetLabel: hourMinuteLabel(t.hour, t.minute),
      };
    }).sort((a, b) => a.targetSec - b.targetSec);
  }

  // What the countdown runs to: the phase's SURE row — the median minute of its
  // busiest quarter-hour. That is the single best moment the data supports, and
  // it is the one a viewer is really asking about; the other rows are the spread
  // around it, not competing countdowns.
  //
  // Falls back to the earliest row, then to the top of the hour, so a window
  // from an older server still counts down to something sensible.
  function sureRow(w) {
    const rows = (w && w.tiers) || [];
    return rows.find((t) => t.tier === 'sure') || rows[0] || null;
  }

  function windowTargetSec(w) {
    if (!w) return 0;
    const row = sureRow(w);
    if (row) return row.targetSec;
    const h = w.predictedHour != null ? w.predictedHour : w.hourStart;
    const m = w.predictedMinute != null ? w.predictedMinute : (w.minute || 0);
    return (h % 24) * 3600 + m * 60;
  }

  function windowTargetLabel(w) {
    const sec = windowTargetSec(w);
    return hourMinuteLabel(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60));
  }

  // "12:00–1:00pm and 3:15–3:30pm" — the breaks, in the app's usual clock
  // style, joined the way a person would say them.
  function breaksLabel(breaks) {
    if (!breaks || breaks.length === 0) return '';
    const one = (b) => `${hourMinuteLabel(Math.floor(b.start / 60), b.start % 60)}–`
      + `${hourMinuteLabel(Math.floor(b.end / 60), b.end % 60)}`;
    const parts = breaks.map(one);
    if (parts.length === 1) return parts[0];
    return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
  }

  // Did this moment land? Answered against TODAY's sightings only — the pattern
  // is learned from every day, but "was this prediction right" is a question
  // about the day in front of you.
  //
  // The span is the predicted minute, not the stretch it was derived from, so
  // most of these come back 'missed'. That is an honest scoreboard for a
  // minute-precise claim, not a bug.
  //
  // Three answers, and the third matters as much as the other two: a moment
  // whose window has not closed yet is not a miss, it is unanswered, and
  // badging it early would call a prediction wrong before it had its chance.
  // Returns 'hit', 'missed', or null for "no verdict yet".
  function momentOutcome(row, todayMinutes, nowMin, opts) {
    const { todayIsWorkDay = true, dayOffset = 0 } = opts || {};
    // Nothing is being predicted for today on a day off, and a phase carried
    // over to tomorrow has not happened yet either.
    if (!todayIsWorkDay || dayOffset > 0) return null;
    if (row == null || row.windowFrom == null || row.windowTo == null) return null;
    if (nowMin < row.windowTo) return null; // still open
    const logged = todayMinutes || [];
    const hit = logged.some((m) => m >= row.windowFrom && m < row.windowTo);
    return hit ? 'hit' : 'missed';
  }

  // Minutes since midnight on the office clock.
  function nowMinutes(timeZone) {
    const { hour, minute } = localTimeParts(timeZone);
    return hour * 60 + minute;
  }

  // "2:24pm" from minutes since midnight.
  function clockLabel(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return hourMinuteLabel(Math.floor(m / 60), m % 60);
  }

  // What was ACTUALLY logged inside a phase's range, each sighting paired with
  // the predicted moment it landed on, or null if it landed on none.
  //
  // The predicted rows say what was expected and whether it happened; these say
  // what happened and whether it was expected. Without them a card full of
  // MISSED reads as "HR never came", when the truth is often "HR came at 2:24
  // and we said 2:07" — a different, more useful thing to know, and the only
  // way to see the prediction drifting rather than simply failing.
  function loggedInPhase(w, todayMinutes) {
    if (!w || w.hourStart == null || w.hourEnd == null) return [];
    const from = w.hourStart * 60;
    const to = w.hourEnd * 60;
    const moments = (w.tiers || []).filter((t) => t.tier !== 'wildcard');
    return (todayMinutes || [])
      .filter((m) => m >= from && m < to)
      .sort((a, b) => a - b)
      .map((m) => ({
        minute: m,
        label: clockLabel(m),
        // Same rule as the badges: the predicted minute, nothing after it.
        matched: moments.find((t) => t.windowFrom != null
          && m >= t.windowFrom && m < t.windowTo) || null,
      }));
  }

  // Every predicted moment of the day, in clock order, each still knowing which
  // phase it belongs to.
  //
  // The countdown used to run to the SURE moment of the next phase and nothing
  // else, which meant the page went quiet for the other three-quarters of what
  // it had predicted: a likely roam at 9:38 got no countdown and no alert, even
  // though the card was sitting there naming it. A prediction the app will not
  // count down to is one it does not really expect.
  function allMoments(windows) {
    return (windows || [])
      .flatMap((w) => {
        // A window with no tiers is one from a server that predates them (or a
        // fixture built straight for classifyWindows). It still has to yield a
        // moment, or the countdown and the day label have nothing to aim at —
        // normalizeWindows degrades the same way, and the two must agree.
        if (!Array.isArray(w.tiers) || w.tiers.length === 0) {
          const sec = windowTargetSec(w);
          return [{
            moment: {
              tier: w.tier || 'sure',
              label: TIER_LABEL[w.tier] || 'Sure',
              pct: null,
              targetSec: sec,
              targetLabel: hourMinuteLabel(Math.floor(sec / 3600), Math.floor((sec % 3600) / 60)),
            },
            window: w,
          }];
        }
        return w.tiers.map((moment) => ({ moment, window: w }));
      })
      .sort((a, b) => a.moment.targetSec - b.moment.targetSec);
  }

  // The moment the countdown should be pointing at: the one happening right now
  // if the clock is inside a predicted minute, otherwise the next one ahead of
  // it. Once the day's moments are all behind us — or it is not a work day at
  // all — it rolls to the earliest, which secondsUntilTarget will place on the
  // next work day.
  //
  // Returns { moment, window, now, dayOffset, dayLabel } or null when nothing is
  // predicted.
  //
  // The day label is computed HERE, from the same target the countdown uses,
  // rather than being read off the featured window. The window's copy is written
  // once per five-second poll while the moment being counted to can change
  // between polls, so at 16:40 the page showed "9:12am" over a countdown of
  // 16h32m — the clock had rolled on to tomorrow's first moment and the label
  // was still describing the last one. One target, one answer, every tick.
  function nextMoment(windows, timeZone, workHours) {
    const all = allMoments(windows);
    if (all.length === 0) return null;

    const label = (entry, now) => {
      const dayOffset = now
        ? 0
        : daysUntilTargetSec(entry.moment.targetSec, timeZone, workHours);
      return { ...entry, now, dayOffset, dayLabel: dayOffsetLabel(dayOffset, timeZone) };
    };

    if (!isWorkDay(currentDayInTZ(timeZone), workHours)) return label(all[0], false);

    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;

    // Inside a predicted minute: that IS the moment, and the page should say so
    // rather than counting down to the next one.
    const current = all.find((x) => nowSec >= x.moment.targetSec
      && nowSec < x.moment.targetSec + 60);
    if (current) return label(current, true);

    const ahead = all.find((x) => x.moment.targetSec > nowSec);
    return label(ahead || all[0], false);
  }

  function windowLabel(w) {
    if (w.tiers === undefined && w.minute !== undefined) return hourMinuteLabel(w.hourStart, w.minute);
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
  // Day of week in the office timezone, 0 = Sunday (same indexing as the
  // heatmap and as WORK_DAYS in .env).
  function currentDayInTZ(timeZone) {
    const short = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short' }).format(new Date());
    const idx = DAYS.indexOf(short);
    return idx === -1 ? new Date().getDay() : idx;
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
  function daysUntilTargetSec(targetSec, timeZone, workHours) {
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    const today = currentDayInTZ(timeZone);
    for (let offset = 0; offset < 8; offset += 1) {
      if (!isWorkDay((today + offset) % 7, workHours)) continue;
      if (offset === 0 && targetSec <= nowSec) continue; // today's slot is gone
      return offset;
    }
    return 1; // every day excluded (a misconfigured WORK_DAYS) — don't hang
  }

  function daysUntilWindow(hourStart, timeZone, workHours) {
    return daysUntilTargetSec((hourStart % 24) * 3600, timeZone, workHours);
  }

  // Seconds until that window opens. Days are counted as 24h, the same
  // assumption the rest of this file makes; in a timezone with DST a countdown
  // spanning the changeover is out by an hour until it passes.
  function secondsUntilTarget(targetSec, timeZone, workHours) {
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    return daysUntilTargetSec(targetSec, timeZone, workHours) * 86400 + targetSec - nowSec;
  }

  function secondsUntilWindow(hourStart, timeZone, workHours) {
    return secondsUntilTarget((hourStart % 24) * 3600, timeZone, workHours);
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
  //
  // A plain 1000ms interval, deliberately. An earlier version scheduled each
  // tick against the wall-clock second boundary, on the theory that a drifting
  // interval was behind a visibly uneven countdown. Measured on the real page it
  // made no difference: neither version ever skipped or repeated a second over
  // 45s, and the frame-to-frame spacing of the rendered digit swap was the same
  // to within the noise. The uneven pacing was the render loop clamping its
  // frame delta — see MAX_FRAME_S in timer3d.js.
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
    const { hour, minute, second } = localTimeParts(timeZone);
    const nowSec = hour * 3600 + minute * 60 + second;
    const todayIsWorkDay = isWorkDay(currentDayInTZ(timeZone), workHours);
    // "Active" is now: the exact predicted moment has arrived and the window has
    // not closed yet. It used to mean "anywhere inside the hour", which was fine
    // when the hour WAS the prediction — but now that the page counts down to
    // 9:34, treating 9:00 as active would swap a running countdown for
    // HAPPENING NOW half an hour early and the countdown would never be seen.
    // hourEnd is deliberately not wrapped with % 24: a window ending at hour 24
    // has to stay in the future all day, not wrap round to midnight.
    const classified = windows.map((w) => ({
      ...w,
      label: TIER_LABEL[w.tier] || w.tier,
      timeLabel: windowLabel(w),
      targetLabel: windowTargetLabel(w),
      targetSec: windowTargetSec(w),
      passed: todayIsWorkDay && nowSec >= w.hourEnd * 3600,
      active: todayIsWorkDay && nowSec >= windowTargetSec(w) && nowSec < w.hourEnd * 3600,
    }));
    // The phase that owns the next predicted moment — not simply the next phase
    // that has not closed. The two differ for a wildcard: it belongs to a phase
    // but lands after that phase's range, so once the 9-10 range closes its
    // 10:35 wildcard is still the next thing predicted while the 11am phase is
    // the next unclosed one. Featuring the phase the countdown is actually
    // pointing at keeps the card, the headline and the clock telling one story.
    const upcoming = nextMoment(classified, timeZone, workHours);
    let featuredIndex = upcoming ? classified.indexOf(upcoming.window) : -1;
    if (featuredIndex === -1) featuredIndex = classified.findIndex((w) => !w.passed);
    if (featuredIndex === -1) featuredIndex = 0;

    const featured = classified[featuredIndex];
    // Which DAY the label says, measured from the moment the countdown is
    // actually pointing at — not from the phase's sure moment.
    //
    // Taking it from the sure moment produced a label that contradicted the
    // clock beside it: at 9:55, with the 9:12 sure moment behind us, "the next
    // 9:12" is tomorrow, so the page read "10:35am tomorrow" over a countdown
    // of forty minutes. One target has to feed both, or they disagree the moment
    // a phase’s first prediction passes.
    const dayOffset = upcoming ? upcoming.dayOffset : 0;
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

  // Keyed on the MOMENT, so every predicted time gets its own pair of alerts.
  // Keyed on the window it used to mean one phase raised one warning however
  // many times it said HR might appear.
  function createCountdownAlerter(onAlert) {
    let key = null;
    let fired = new Set();
    return function check(entry, secondsLeft) {
      if (!entry || !entry.moment || entry.now) return;
      const { moment, window: w } = entry;
      const next = `${w.hourStart}@${moment.tier}@${moment.targetSec}+${w.dayOffset || 0}`;
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
      onAlert(target, secondsLeft, entry);
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
  const TOAST_WRAP_CLASS = 'mt-2 flex w-full justify-center animate-toast-in';
  // max-w-full and wrapping: on a phone a long message forced the bubble wider
  // than the screen, which dragged the whole fixed host off-centre and took the
  // flames with it.
  const TOAST_CLASS = 'relative max-w-full rounded-xl border border-line-strong bg-ink-800 px-[18px] py-[11px] text-[13px] text-fg-muted shadow-[0_8px_24px_rgba(0,0,0,0.35)] break-words max-[420px]:px-3.5 max-[420px]:text-xs';
  // Fire on a toast, Messenger-style: flames rising from BEHIND the bubble.
  //
  // ONLY the countdown alerts ask for it, via toast(host, msg, { fire: true }).
  // Setting a toast alight is a way of saying "this one is urgent", and it only
  // says that if the ordinary ones — logged, undone, invite code, an error —
  // are not also on fire.
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
  // left %, bottom px, and a size as a FRACTION OF THE BUBBLE'S WIDTH. The sizes
  // used to be fixed pixels, which is what broke this on a phone: a 124px flame
  // on a 210px-wide toast is taller than the toast is long, so the message
  // vanished inside a bonfire. Scaling with the bubble keeps the effect the same
  // shape at every width, and the clamp stops it collapsing to nothing on a very
  // narrow screen or ballooning on a very wide one.
  //
  // The fractions are generous because the asset has a lot of empty canvas
  // around the flame — the visible tongue is roughly 60% of its box. Positions
  // overlap and hang past both ends so the row reads as one fire rather than
  // five separate flames.
  const TOAST_FLAMES = [
    { left: -14, bottom: -6, scale: 0.30, frame: 0 },
    { left: 6, bottom: -2, scale: 0.37, frame: 24 },
    { left: 30, bottom: 0, scale: 0.41, frame: 48 },
    { left: 55, bottom: -2, scale: 0.37, frame: 12 },
    { left: 78, bottom: -6, scale: 0.32, frame: 66 },
  ];
  // The phone layout. Not the wide one with two flames deleted: dropping the
  // outer pair leaves the fire stopping short of both ends of the bubble, which
  // looks like it is burning in the middle rather than underneath. These three
  // are respread to span the bubble edge to edge instead, with nothing hanging
  // past it — the boxes overlap (0-34%, 33-73%, 66-100%) so it still reads as
  // one fire and not as three separate tongues.
  const TOAST_FLAMES_NARROW = [
    { left: 0, bottom: -4, scale: 0.34, frame: 12 },
    { left: 33, bottom: 0, scale: 0.40, frame: 48 },
    { left: 66, bottom: -4, scale: 0.34, frame: 66 },
  ];
  const FLAME_MIN_PX = 46;
  const FLAME_MAX_PX = 124;
  // Five overlapping tongues need a bubble wide enough to space them across;
  // narrower than this they merge into one blob, and they cost two extra rAF
  // loops on the sort of device least able to spare them.
  const FLAME_WIDE_MIN_PX = 260;
  // How far past the bubble's end the outermost flames of the wide layout
  // reach, as a fraction of the bubble's width — the |left| of its first entry.
  const FLAME_OVERHANG = 0.14;

  // Which layout the bubble gets. The wide one needs BOTH a bubble big enough
  // to space five flames across and somewhere for its overhang to go: on a
  // phone the bubble very nearly fills the screen, so those outer flames hung
  // off the side and rendered as slices chopped off by the viewport edge, which
  // is exactly what the fire looked like on mobile.
  function flameLayoutFor(bubbleWidth) {
    const viewport = (typeof window !== 'undefined' && window.innerWidth) || bubbleWidth;
    const wide = bubbleWidth >= FLAME_WIDE_MIN_PX
      && (viewport - bubbleWidth) / 2 >= bubbleWidth * FLAME_OVERHANG;
    return wide ? TOAST_FLAMES : TOAST_FLAMES_NARROW;
  }

  // toast(host, message) is a plain bubble; toast(host, message, { fire: true })
  // is the urgent one — see the note above TOAST_FIRE_CLASS.
  function toast(host, msg, options) {
    if (!host) return null;
    const opts = options || {};
    const wrap = document.createElement('div');
    wrap.className = TOAST_WRAP_CLASS;
    const bubble = document.createElement('div');
    bubble.className = TOAST_CLASS;

    const label = document.createElement('span');
    label.className = 'relative';
    label.textContent = msg;
    bubble.appendChild(label);
    wrap.appendChild(bubble);
    host.appendChild(wrap);

    // The flames are sized from the bubble's MEASURED width, so they can only be
    // added once it is in the document — before that offsetWidth is 0 and every
    // flame would clamp to the minimum.
    const width = bubble.offsetWidth || 0;
    const flames = opts.fire ? flameLayoutFor(width) : [];

    // One span per flame. Their geometry is per-instance arithmetic, so it goes
    // in inline styles: there is no Tailwind class for "the third flame".
    const fires = flames.map((f) => {
      const size = Math.round(Math.min(FLAME_MAX_PX, Math.max(FLAME_MIN_PX, width * f.scale)));
      const span = document.createElement('span');
      span.className = TOAST_FIRE_CLASS;
      span.style.cssText = `left:${f.left}%; bottom:${f.bottom}px; `
        + `width:${size}px; height:${size}px;`;
      bubble.appendChild(span);
      return span;
    });

    // Aspect preserved (the default 'meet'): each span is square and holds one
    // whole flame. goToAndPlay puts each copy at a different point in the loop.
    const lottie = fires.length ? lottieLib() : null;
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
        anim.addEventListener('DOMLoaded', () => anim.goToAndPlay(flames[i].frame, true));
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

  // ---- the logging advisory ----
  // Shown on EVERY page load, on purpose. It is not a consent banner whose job
  // is to be agreed to once and never seen again: every prediction on the page
  // is built out of what people log, so a reminder about how to log is worth
  // more than the small annoyance of seeing it twice. Nothing is remembered
  // between loads — no storage, no flag, no "don't show this again".
  //
  // It is skipped for the ?preview= flags, which exist to look at the outcome
  // modals; a dialog sitting on top of the thing under inspection would make
  // that tool useless.
  //
  // Returns a { show, hide } pair, or null when the markup is absent.
  function initAdvisory({ modalId, closeIds, onDismiss } = {}) {
    const modal = document.getElementById(modalId || 'advisoryModal');
    if (!modal) return null;
    let lastFocused = null;

    function hide() {
      modal.style.display = 'none';
      document.removeEventListener('keydown', onKey);
      // Put focus back where the reader left it, rather than dropping it on
      // <body> and making a keyboard user tab from the top of the page again.
      if (lastFocused && lastFocused.focus) lastFocused.focus();
      if (onDismiss) onDismiss();
    }
    function onKey(e) {
      if (e.key === 'Escape') hide();
    }
    function show() {
      lastFocused = document.activeElement;
      modal.style.display = 'flex';
      document.addEventListener('keydown', onKey);
      const ok = document.getElementById('advisoryOk');
      if (ok && ok.focus) ok.focus();
    }

    (closeIds || ['advisoryClose', 'advisoryOk']).forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('click', hide);
    });
    // Clicking the backdrop dismisses it too; clicking the panel must not.
    modal.addEventListener('click', (e) => { if (e.target === modal) hide(); });

    return { show, hide };
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
  // The verdict on a whole phase, judged by exactly the rule the per-moment
  // badges use: a sighting has to land IN a predicted minute (see
  // HIT_TOLERANCE_MIN in routes/sightings.js). The phase is a hit if any of the
  // moments inside its range was hit, and a miss if none was.
  //
  // This replaces a count-based check — "did the total number of sightings move
  // while the window was open, give or take thirty seconds" — which answered a
  // different question from the badges sitting right underneath it. The page
  // could show three MISSED badges and a "Called it!" modal over the top of
  // them, on the same data, and both were behaving as designed. One rule now.
  //
  // The wildcard is deliberately not part of it: it is the chance of a roam in
  // the gap AFTER this phase, it lands outside the range, and waiting for it
  // would hold the verdict back an hour past the thing it is judging. It keeps
  // its own badge.
  //
  // Reports each phase once, when it CLOSES. Phases that had already closed when
  // the page opened are recorded as seen without firing: a modal about a window
  // that ended before anyone loaded the page is not news, and three of them
  // stacking up on a mid-afternoon refresh is worse.
  //
  // Takes { onHit, onMiss }; either may be omitted. onHit is given the number of
  // predicted moments that landed, and how many there were.
  function createPredictionWatcher(handlers) {
    const { onHit, onMiss } = handlers || {};
    const reported = new Set();
    let primed = false;

    return function check(windows, todayMinutes, nowMin, opts) {
      const { todayIsWorkDay = true } = opts || {};
      const list = Array.isArray(windows) ? windows : [];
      const closed = list.filter((w) => todayIsWorkDay
        && w.hourEnd != null
        && nowMin >= w.hourEnd * 60);

      // First call of the session: note what has already been and gone.
      if (!primed) {
        primed = true;
        closed.forEach((w) => reported.add(w.hourStart));
        return;
      }

      for (const w of closed) {
        if (reported.has(w.hourStart)) continue;
        reported.add(w.hourStart);

        const moments = (w.tiers || []).filter((t) => t.tier !== 'wildcard');
        if (moments.length === 0) continue;
        const hits = moments.filter((t) => momentOutcome(t, todayMinutes, nowMin,
          { todayIsWorkDay, dayOffset: 0 }) === 'hit').length;

        if (hits > 0) {
          if (onHit) onHit(pick(HIT_PREDICTION_LINES), hits, moments.length);
        } else if (onMiss) {
          onMiss(pick(MISSED_PREDICTION_LINES));
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
    secondsUntilHour, secondsUntilWindow, daysUntilWindow, isWorkDay,
    windowTargetSec, windowTargetLabel, secondsUntilTarget, sureRow,
    allMoments, nextMoment,
    momentOutcome, nowMinutes, clockLabel, loggedInPhase,
    breaksLabel,
    formatCountdown, getConfig, getTimezone, initThemeToggle,
    lottieLib, toast, confettiBurst, initAdvisory,
    createPredictionWatcher,
    workHoursState, currentDayInTZ,
    notify, notifyPermission, notifyWanted, requestNotifyPermission,
    initNotifyToggle, createCountdownAlerter, ALERT_THRESHOLDS_S,
    createCountdownOverride,
  };
})();

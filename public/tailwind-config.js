/* Tailwind's source stylesheet for both pages.

   Why this is a .js file and not a .css file: @tailwindcss/browser only reads
   <style type="text/tailwindcss"> ELEMENTS — it ignores <link>, so there is no
   supported way to point it at an external stylesheet. The choice is therefore
   between duplicating this whole block in index.html and admin.html, or
   injecting it from one place. One place wins.

   Load order matters: this must run before the @tailwindcss/browser script, so
   the style element exists when Tailwind initialises. Both pages load them
   back to back in <head>.

   Everything visual in this app is a Tailwind utility. shared.css holds only
   the design tokens (custom properties, read at runtime by timer3d.js and
   viz.js) and the reduced-motion guard, so this file is where the tokens become
   utilities and where every keyframe lives. */

document.head.insertAdjacentHTML('beforeend', `<style type="text/tailwindcss">
  @import "tailwindcss";

  /* ---- tokens -> utilities ----
     Mapped by reference, not by value: bg-ink-900 compiles to
     background-color: var(--ink-900), so every colour utility follows the
     light/dark switch on :root[data-theme="dark"] by itself. One palette, in
     shared.css, no second copy to keep in sync and no dark: variant needed for
     colour.

     Names avoid Tailwind's own namespaces where they would collide with token
     names already in use: --text-*, --font-* and --radius-* are all Tailwind
     namespaces AND existing token names, so text colours are exposed as
     --color-fg* and radii use Tailwind's own scale (rounded-md = 6px,
     rounded-xl = 12px) instead of being remapped. */
  @theme {
    --color-ink-950: var(--ink-950);
    --color-ink-900: var(--ink-900);
    --color-ink-800: var(--ink-800);
    --color-ink-700: var(--ink-700);

    --color-line: var(--line);
    --color-line-strong: var(--line-strong);

    --color-fg: var(--text-primary);
    --color-fg-muted: var(--text-secondary);
    --color-fg-faint: var(--text-muted);

    --color-amber-300: var(--amber-300);
    --color-amber-400: var(--amber-400);
    --color-amber-500: var(--amber-500);
    --color-amber-700: var(--amber-700);
    --color-amber-ink: var(--amber-ink);

    --color-good: var(--status-good);
    --color-bad: var(--status-bad);

    --color-heat-0: var(--heat-0);
    --color-heat-1: var(--heat-1);
    --color-heat-2: var(--heat-2);
    --color-heat-3: var(--heat-3);
    --color-heat-4: var(--heat-4);
    --color-heat-5: var(--heat-5);

    --font-sans: var(--font-body);

    /* ---- animations ----
       Every keyframe in the app lives here, so animate-* utilities can drive
       them from the markup and from JS (the browser build watches [class] with
       a MutationObserver, so a class added at runtime compiles too). */
    --animate-pulse-text: pulse-text 1.5s ease-in-out infinite;
    @keyframes pulse-text {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.55; }
    }

    --animate-pulse-ring: pulse-ring 2.2s ease-out infinite;
    @keyframes pulse-ring {
      0% { box-shadow: 0 0 0 0 rgba(var(--status-good-rgb), 0.55); }
      70% { box-shadow: 0 0 0 8px rgba(var(--status-good-rgb), 0); }
      100% { box-shadow: 0 0 0 0 rgba(var(--status-good-rgb), 0); }
    }

    --animate-ripple: ripple 0.6s ease-out forwards;
    @keyframes ripple {
      from { transform: scale(0); opacity: 1; }
      to { transform: scale(3.2); opacity: 0; }
    }

    /* Slides DOWN into place, because the toast rail is anchored to the top of
       the viewport — a +8px offset would have it rising from below its resting
       spot, which reads backwards there. (CSS comments only in here: a // line
       comment is a parse error, and Tailwind's compiler rejects the whole
       stylesheet over it.) */
    --animate-toast-in: toast-in 0.25s ease;
    @keyframes toast-in {
      from { opacity: 0; transform: translateY(-8px); }
      to { opacity: 1; transform: translateY(0); }
    }

    --animate-modal-pop: modal-pop 0.28s cubic-bezier(0.22, 0.9, 0.4, 1.3);
    @keyframes modal-pop {
      from { transform: scale(0.86); opacity: 0; }
      to { transform: scale(1); opacity: 1; }
    }

    /* --dx/--dy are set per piece as an inline style by Tracker.confettiBurst */
    --animate-confetti-fly: confetti-fly 0.7s cubic-bezier(0.2, 0.7, 0.4, 1) forwards;
    @keyframes confetti-fly {
      0% { transform: translate(0, 0) rotate(0deg); opacity: 1; }
      100% { transform: translate(var(--dx), var(--dy)) rotate(220deg); opacity: 0; }
    }

    /* The countdown's red heartbeat under a minute. timer3d.js toggles
       animate-urgent-glow on the canvas; the glow bleeds past the canvas edge,
       which is far cheaper as a filter than as bloom in the render loop. */
    --animate-urgent-glow: urgent-glow 1.1s ease-in-out infinite;
    @keyframes urgent-glow {
      0%, 100% { filter: drop-shadow(0 0 5px rgba(var(--status-bad-rgb), 0.30)); }
      50% { filter: drop-shadow(0 0 26px rgba(var(--status-bad-rgb), 0.75)); }
    }
  }

  /* The theme switch is an attribute on <html> (see initThemeToggle in viz.js),
     not Tailwind's default .dark class. Colour utilities theme themselves via
     the var() bridge above, so this is only for the occasional non-colour tweak. */
  @custom-variant dark (&:where([data-theme="dark"], [data-theme="dark"] *));
</style>`);

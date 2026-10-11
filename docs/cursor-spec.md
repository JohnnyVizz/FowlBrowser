# Agent cursor (spec)

Shows the user where an agent acts and what it is doing, only in a tab they can see. It is Cua Driver's agent cursor
(its default theme and `signature_arc` motion, MIT, github.com/trycua/cua: `cursor-overlay/assets/build_default_theme.py`,
`cua-cursor-motion`), drawn smaller and inside the page.

## Where and when
- Only in a tab the user can see: the active tab of a normal, app or popup window that is not minimized (`tabs.isShown {tabId}` -> `{shown}`,
  owner only; a slow answer counts as not shown). Not shown: no injection, no waiting, zero cost.
- Every agent action in that tab shows it, not only pointer actions:
  | Tool | Cursor |
  |---|---|
  | click, select_option | travels to the element (or x,y), then squish, ripple and click burst |
  | hover | travels there |
  | type, fill_form (text fields) | travels to the field, I-beam cue while typing; without ref, the cue at the last point |
  | fill_form (checks, selects) | travels there, click feedback |
  | press_key | key cue (with ref: travels there first) |
  | scroll | travels to the scrolled point (viewport centre, or the element after it scrolled into view), scroll cue |
  | drag | travels to the source, drag cue on the way to the target |
  | upload_files | travels to the element, transfer cue |
  | download with ref | as click (it clicks the element) |
  | navigate | navigate cue on the new page once it loaded |
  | snapshot, wait_for, media, export | look cue at the last point while it runs |
  | evaluate | look cue while it runs; clicks the script makes (`el.click()`, untrusted events) are shown as travel to the clicked element and a click |
  | screenshot | hidden during the capture, look cue after it |
- Only the top frame. Agent-opened and claimed tabs alike, while the session controls the tab.
- Injected by the MCP server through the tab's debugger session into an isolated world
  (`Page.createIsolatedWorld` on the main frame, world `fowlbrowser-cursor`, then `Runtime.evaluate` of
  `mcp/src/cursor/overlay.js`). No extension permissions, invisible to page scripts except the host element.
  Re-injected per document (the tab's document generation). Prepared ahead: when a tab comes under control and when
  its main frame commits a new document, the world is made in the background (only where the cursor would show), so
  the first action on a page finds it ready; the host element itself appears with the first action.
- Host: `<fowlbrowser-cursor aria-hidden="true">` on `document.documentElement`, closed shadow root, fixed, inset 0,
  `pointer-events:none`, `z-index:2147483647`, `contain:strict`, hidden in print, and in the top layer as a manual popover
  (above modal dialogs, popovers, fullscreen elements and transformed pages; re-raised when one opens after it).
  Re-attached if the page removes it or replaces its document element. Built with DOM calls and constructed stylesheets
  only: pages with Trusted Types (YouTube, GitHub) refuse HTML strings and a CSP style-src can block `<style>`.
- Hidden for agent screenshots (`display:none` during the capture).
- Fades out 15 s after the last action (Cua's idle timeout; an action still running, like a long wait_for, keeps it,
  up to 2 minutes), when the tab is released or closed, and when the session ends. A page entering the back/forward
  cache drops it.
- Targets and the restored point are kept 2 px inside the viewport. In a hidden document (no frames) it goes straight
  to the target; a move whose frames stop (window covered, another Space) still ends on time. Click feedback goes to the
  clicked point (the cursor jumps there if a slow lookup left it more than 12 px away); a target found after the cursor
  budget is shown at once (no travel) while the action still runs, and not at all once it is done.

## Look
- Cua's arrowhead (rounded triangle pointing up-left with a concave back) in its 128-unit canvas, shown at 32 CSS px
  (Cua: 42 pt). Hotspot = the visual tip (46, 32 in canvas units), so the tip sits exactly on the point.
- Fill: Cua blue `#5EC0E8` for the default label "Claude"; other labels hash into Cua's session palette (same rule as
  Cua's `session_fill_rgba`), so parallel sessions are told apart. White rim (5 units), and Cua's glow: the outline
  stroked 8 times in the fill colour, widths 44..7 units at 2..9.5% opacity.
- Label badge under the arrow's body, centred 12 px right of the tip and 28 px below it, kept 2 px inside the viewport:
  20 px pill, white 11 px system font, Cua's tinted dark gradient (fill-tinted `#5E97B2` -> `#2B5C77` -> `#0D1B26`),
  rim tinted 55% toward the fill, soft shadow and fill-coloured halo. Max 150 px with ellipsis.
- Action cues (Cua's theme): small stroked glyphs beside the tip (look arcs, scroll chevrons, I-beam, key cap, navigate
  chevrons, drag lines, transfer arrows, click burst), each drawn as 4 faint glow strokes, a white rim and a fill
  stroke, 1.4x Cua's stroke width so they read at our size. They turn with the arrow.

## Motion
- Travel (Cua `signature_arc`): a cubic Bezier from the current tip to the target, handles 0.3 of the distance at each
  end, bent 0.16 of the distance to the natural side (upward for horizontal moves), bend peak shifted 0.15 toward the
  end; walked by arc length with a minimum-jerk profile plus a follow-through bump peaking at 82% of the move
  (0.018 of the distance, at most 6 px). Duration: Fitts, `(150 + 120 log2(D / W + 1))` ms clamped to 300..1000,
  times 0.9 (Cua: 1.1), at most 850 ms; W is the target's smaller side (24 px for a bare point). Never longer than
  the time left before the action (Agent timing): a quicker travel when less is left, and with under 120 ms left
  the cursor goes straight to the target (appearing there on a fresh page).
- Arrival (the action may start) when the tip is within 1 px of the target; the follow-through finishes during
  the action. A new target mid-flight plans a new arc from the current tip.
- Land, just before the action: unless the tip is within 2 px of the target and fully opaque, the travel and the
  appear (or exit) fade are cut short and the tip is put on the target at full opacity at once. A busy page (no
  frames for the travel or the fade) still shows the cursor on the target when the action fires.
- Heading: the tip leads along the direction of travel, weighted by speed ((v - 40) / 260, clamped 0..1) and smoothed
  with `1 - exp(-22 dt)`; it turns back to rest after the move.
- Speed glow behind the moving arrow: alpha `min(v * 0.00014, 0.42)`, radius `23 px * (1 + min(v * 0.00024, 0.44))`,
  trailing by `min(v * 0.009, 18) * 0.76` px, in the fill lifted 45% toward white.
- Float: Cua's shared 4 s drift around the tip, about +-1.25 px, up to 2.75 px up and +-2.5 degrees (WAAPI, infinite).
- Click: squish to 0.88 around the tip (50 ms in, held to 90 ms, back by 165 ms), a ring from the tip growing
  6 -> 40 px over 520 ms (ease-out cubic, stroke 3.8 -> 0.8 px, opacity 0.75 -> 0), and the click burst cue.
- Cues follow Cua's keyframes (30 fps, easing `cubic-bezier(0.2, 0.75, 0.25, 1)`): click 0.67 s once; key and
  navigate 1.6 s once; look, scroll, text, drag and transfer loop while the action runs, then stay at least 0.6 s and
  fade in 200 ms.
- Appear: at the last point, else where the server last had it, else 58% x / 55% y of the viewport; opacity 0 -> 1 and
  scale 0.85 -> 1 around the tip, 220 ms `cubic-bezier(0.23, 1, 0.32, 1)`. Exit: opacity -> 0, scale -> 0.9, 200 ms.
- rAF runs only while travelling or turning back to rest; everything else is WAAPI.
- Reduced motion: no travel (120 ms crossfade to the target), no float, no squish or ring; cues show still.

## Agent timing
- Pointer actions wait for arrival, capped at 900 ms for the whole cursor path (visibility, target box, travel), then
  act. The overlay's world is made while the target box is looked up, and the move tells the overlay the wall-clock
  time it must arrive by (60 ms before the cap, so its reply is back in time); the travel fits into that.
- Then one land call (overlay `land`, capped at 150 ms): the page's main thread runs it before it handles the
  action's input events, so the tip and the action paint together.
- Target box of a main-frame ref: one page-side evaluate on the locator (Chromium's `scrollIntoViewIfNeeded`, the
  alignment the action's own scroll uses, then `getBoundingClientRect`). Iframe refs use Playwright's scroll and
  `boundingBox` (frame offsets); closed-shadow (s) refs the debugger's box model.
- Late target: a lookup that ends after the budget while the action is still running lands the cursor there at once
  (appears at the target, no travel). Record mode: the point line keeps the state from before the action, plus
  `late: true`.
  Cues never wait. Any cursor failure is logged (debug) and never fails or delays an action beyond the caps.

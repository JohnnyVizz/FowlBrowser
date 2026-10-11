# Agent cursor (spec)

Shows the user where an agent acts and what it is doing, only in a tab they can see: a rounded pointer in the
session's colour with a name label, drawn inside the page. Its curved, Fitts-timed travel follows Cua's
`signature_arc` motion (MIT, github.com/trycua/cua); the look is FowlBrowser's own.

## Where and when
- Only in a tab the user can see: the active tab of a normal, app or popup window that is not minimized (`tabs.isShown {tabId}` -> `{shown}`,
  owner only; a slow answer counts as not shown). Not shown: no injection, no waiting, zero cost.
- Every agent action in that tab shows it, not only pointer actions:
  | Tool | Cursor |
  |---|---|
  | click, select_option | travels to the element (or x,y), then press and ring |
  | hover | travels there |
  | type, fill_form (text fields) | travels to the field, "typing" while it types; without ref, at the last point |
  | fill_form (checks, selects) | travels there, click feedback |
  | press_key | "pressing keys" (with ref: travels there first) |
  | scroll | travels to the scrolled point (viewport centre, or the element after it scrolled into view), "scrolling" |
  | drag | travels to the source, "dragging" on the way to the target |
  | upload_files | travels to the element, "uploading" |
  | download with ref | as click (it clicks the element) |
  | navigate | "loading" on the new page once it loaded |
  | snapshot, wait_for, media, export | "reading" at the last point while it runs |
  | evaluate | "reading" while it runs; clicks the script makes (`el.click()`, untrusted events) are shown as travel to the clicked element and a click |
  | screenshot | hidden during the capture, "reading" after it |
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
- Fades out 15 s after the last action (an action still running, like a long wait_for, keeps it,
  up to 2 minutes), when the tab is released or closed, and when the session ends. A page entering the back/forward
  cache drops it.
- Targets and the restored point are kept 2 px inside the viewport. In a hidden document (no frames) it goes straight
  to the target; a move whose frames stop (window covered, another Space) still ends on time. Click feedback goes to the
  clicked point (the cursor jumps there if a slow lookup left it more than 12 px away); a target found after the cursor
  budget is shown at once (no travel) while the action still runs, and not at all once it is done.

## Look
- Pointer: a rounded arrow pointing up and a little left, drawn in a 24-unit box and shown at 1.2 CSS px per unit
  (about 14 x 20 px): corners rounded 2.2 units at the tip and the notch, 3.4 at the other two. Hotspot = the apex of
  the rounded tip, so it sits exactly on the point.
- Fill: the session's colour: blue `#0a84ff` for the default label "Claude"; other labels hash (FNV-1a) into orange
  `#ff9f0a`, green `#30d158`, purple `#bf5af2`, pink `#ff375f`, teal `#40c8e0`, indigo `#5e5ce6`, red `#ff453a`,
  brown `#ac8e68`, so parallel sessions are told apart. White rim 1.7 px, an ink hairline (`#131110`, 30%) at the
  edge, and a soft drop shadow (0 1px 1.2px, 32% black).
- Label: a flat pill in the same colour, 17 px tall, 10.5 px semibold system font, white text (ink on light fills,
  relative luminance over 0.4), a 1.5 px white ring and a small shadow; 16 px right of and 24 px below the tip, kept
  inside the viewport. Max 200 px with ellipsis.
- Action words: what the agent is doing follows the name in the label ("Claude · typing"): reading, scrolling,
  typing, dragging and uploading stay while the action runs (at least 0.6 s); pressing keys and loading show for 1.2 s.

## Motion
- Travel (after Cua's `signature_arc`): a cubic Bezier from the current tip to the target, handles 0.3 of the distance at each
  end, bent 0.16 of the distance to the natural side (upward for horizontal moves), bend peak shifted 0.15 toward the
  end; walked by arc length with a minimum-jerk profile plus a follow-through bump peaking at 82% of the move
  (0.018 of the distance, at most 6 px). Duration: Fitts, `(150 + 120 log2(D / W + 1))` ms clamped to 300..1000,
  times 0.9, at most 850 ms; W is the target's smaller side (24 px for a bare point). Never longer than
  the time left before the action (Agent timing): a quicker travel when less is left, and with under 120 ms left
  the cursor goes straight to the target (appearing there on a fresh page).
- Arrival (the action may start) when the tip is within 1 px of the target; the follow-through finishes during
  the action. A new target mid-flight plans a new arc from the current tip.
- Land, just before the action: unless the tip is within 2 px of the target and fully opaque, the travel and the
  appear (or exit) fade are cut short and the tip is put on the target at full opacity at once. A busy page (no
  frames for the travel or the fade) still shows the cursor on the target when the action fires.
- Lean: the pointer leans into the direction of travel, at most 0.5 rad, weighted by speed ((v - 40) / 260, clamped
  0..1) and smoothed with `1 - exp(-22 dt)`; it settles back after the move. The label stays upright.
- Click: the pointer presses to 0.86 around its tip and springs back (220 ms), and a ring of the session's colour grows
  from the tip 5 -> 22 px over 420 ms (ease-out, stroke 2.4 -> 0.6 px, opacity 0.85 -> 0).
- Appear: at the last point, else where the server last had it, else 58% x / 55% y of the viewport; opacity 0 -> 1 and
  scale 0.85 -> 1 around the tip, 220 ms `cubic-bezier(0.23, 1, 0.32, 1)`. Exit: opacity -> 0, scale -> 0.9, 200 ms.
- rAF runs only while travelling or turning back to rest; everything else is WAAPI.
- Reduced motion: no travel (120 ms crossfade to the target), no press or ring; action words show as usual.

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

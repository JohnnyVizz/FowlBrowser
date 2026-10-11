// FowlBrowser agent cursor: evaluated by the MCP server in the isolated world "fowlbrowser-cursor" of a tab's top
// frame (see docs/cursor-spec.md). Defines globalThis.__fbCursor once per document:
//   move(x, y, opts) -> Promise<arrived>   opts { label, from, w, h, until }: from is the last point the server knows
//                                           (for a fresh document), w,h the target's box (bigger targets are quicker),
//                                           until the wall-clock ms by which it must arrive
//   land(x, y, opts) -> changed             the tip on (x, y) at full opacity at once (travel and appear fade cut short)
//   cue(kind, opts) / cueEnd()             action cue beside the tip: observe, scroll, text, key, navigate, drag, transfer
//   click()                                squish, ripple and click burst at the current point
//   follow(on, record)                     while on, travels to and clicks on clicks a script makes (an agent's evaluate);
//                                          record: also keep them for drainClicks
//   hide()                                 exit animation, then the host is removed; resolves when gone
//   capture(on)                            display:none while the agent takes a screenshot
//   state() / drainClicks()                record mode: what a viewer sees now; script clicks shown since the last drain
// No dependencies. rAF runs only while the pointer travels or turns back to rest; the rest is WAAPI.
(() => {
  if (globalThis.__fbCursor) return;

  // Cua Driver's default cursor (MIT, github.com/trycua/cua: cursor-overlay/assets/build_default_theme.py) in its
  // 128-unit canvas, shown at 32 px instead of Cua's 42, with its signature_arc motion (cua-cursor-motion).
  const S = 32 / 128;
  const K = 32 / 42; // Cua's point sizes (effects, badge) at our size
  const TIP = { x: 46, y: 32 }; // the hotspot: the arrow's visual tip, in canvas units
  const ARROW = 'M55 30C48 28 42 33 43 41L64 98C67 106 73 106 77 99L86 79C88 75 91 72 95 70L108 63C115 59 114 53 107 50Z';
  const GLOW = [[44, 0.02], [36, 0.024], [29, 0.03], [23, 0.038], [18, 0.048], [14, 0.06], [10, 0.075], [7, 0.095]];
  const CUE_GLOW = [[13, 0.024], [9, 0.031], [6, 0.04], [3, 0.052]];
  const BLUE = [94, 192, 232];
  const PALETTE = [[178, 132, 255], [247, 132, 170], [96, 218, 174], [244, 178, 66], [76, 204, 224], [221, 113, 236],
    [232, 82, 98], [184, 220, 54], [80, 126, 236]];
  const LOTTIE = 'cubic-bezier(0.2, 0.75, 0.25, 1)'; // the theme's keyframe easing
  const CURVE = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const IDLE_MS = 15_000; // Cua's agent cursor idle timeout
  const TIMING = 0.9; // Cua's signature_arc uses 1.1x Fitts; a little quicker here, agents wait for arrival
  const MAX_MOVE_MS = 850;
  const MIN_MOVE_MS = 120; // less time left than this before the action: the cursor appears at the target
  const TIP_ANGLE = -0.75 * Math.PI; // where the tip points at rest (up and to the left)
  const ANCHOR = 16 * K; // the arrow's body sits this far behind the tip, along the heading
  const MIN_CUE_MS = 600; // a cue for a quick action stays long enough to be seen
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Action cues of the same theme (paths in canvas units around the layer anchor 64,64; keyframes [frame, value] at
  // 30 fps). loop: repeats while the action runs (Cua's loop and held cues); otherwise plays once.
  const CUES = {
    click: { frames: 20, paths: ['M35 20L34 11', 'M27 25L19 19', 'M25 34L15 34'], at: [[0, [74, 67]]],
      scale: [[0, 1.1], [8, 1.3], [20, 1.5]], opacity: [[0, 0], [4, 1], [11, 1], [20, 0]] },
    observe: { frames: 48, loop: true, paths: ['M38 28C27 29 20 38 20 49', 'M42 19C23 19 11 33 11 51'], at: [[0, [72, 54]]],
      scale: [[0, 0.88], [24, 1], [48, 1.08]], opacity: [[0, 0], [7, 1], [34, 1], [44, 0], [48, 0]] },
    scroll: { frames: 48, loop: true, paths: ['M23 31L31 22L39 31', 'M23 49L31 58L39 49'],
      at: [[0, [59, 68]], [24, [59, 60]], [48, [59, 68]]], opacity: [[0, 0.42], [24, 1], [48, 0.42]] },
    text: { frames: 48, loop: true, linear: true, paths: ['M31 22L31 58', 'M24 22L38 22', 'M24 58L38 58'], at: [[0, [60, 64]]],
      opacity: [[0, 1], [16, 1], [17, 0.18], [30, 0.18], [31, 1], [48, 1]] },
    key: { frames: 48, width: 3.5,
      paths: ['M20 25H36A6 6 0 0 1 42 31V47A6 6 0 0 1 36 53H20A6 6 0 0 1 14 47V31A6 6 0 0 1 20 25Z', 'M23 32L23 46', 'M24 39L33 32', 'M25 39L34 46'],
      at: [[0, [55, 64]], [8, [55, 67]], [17, [55, 63]], [26, [55, 64]], [48, [55, 64]]],
      scale: [[0, 1], [8, 0.92], [17, 1.03], [26, 1], [48, 1]], opacity: [[0, 0], [4, 1], [30, 1], [42, 0], [48, 0]] },
    navigate: { frames: 48, paths: ['M15 29L25 40L15 51', 'M29 29L39 40L29 51'],
      at: [[0, [54, 64]], [18, [59, 64]], [30, [63, 64]], [48, [63, 64]]], opacity: [[0, 0], [8, 1], [28, 1], [42, 0], [48, 0]] },
    drag: { frames: 48, loop: true, paths: ['M28 38L16 35', 'M26 48L12 45'],
      at: [[0, [64, 64]], [8, [64, 64]], [30, [71, 67]], [40, [71, 67]], [48, [64, 64]]], opacity: [[0, 0.2], [15, 1], [36, 1], [48, 0.2]] },
    transfer: { frames: 48, loop: true, paths: ['M22 50L22 20L14 28L22 20L30 28', 'M37 28L37 58L29 50L37 58L45 50'],
      at: [[0, [55, 70]], [24, [55, 58]], [48, [55, 70]]], opacity: [[0, 0.38], [24, 1], [48, 0.38]] },
  };

  // Cua's session colours: the default cursor is Cua blue, other labels hash into its palette.
  function fillFor(label) {
    if (!label || label === 'Claude') return BLUE;
    const suffix = label.split(/[-_.]/).pop();
    if (/^\d+$/.test(suffix) && Number(suffix) > 0) return PALETTE[(Number(suffix) - 1) % PALETTE.length];
    if (/^[a-z]$/i.test(suffix)) return PALETTE[(suffix.toLowerCase().charCodeAt(0) - 97) % PALETTE.length];
    let hash = 2166136261;
    for (const ch of label) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  const mix = (base, fill, weight) => base.map((c, i) => Math.round(c * (1 - weight) + fill[i] * weight));
  const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

  const STYLE = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important;
      z-index: 2147483647 !important; contain: strict !important; display: block !important; }
    @media print { :host { display: none !important; } }
    .cursor, .fx { position: absolute; left: 0; top: 0; will-change: transform; }
    .body, .float, .art, .press { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    svg { position: absolute; overflow: visible; }
    .theme { left: ${-TIP.x * S}px; top: ${-TIP.y * S}px; width: ${128 * S}px; height: ${128 * S}px; }
    .glow path { fill: none; stroke: var(--fill); stroke-linejoin: round; }
    .arrow { fill: var(--fill); stroke: #fff; stroke-width: 5; stroke-linejoin: round; }
    .cue path { fill: none; stroke-linecap: round; stroke-linejoin: round; }
    .cue .tint { stroke: var(--fill); }
    .cue .rim { stroke: #fff; }
    .speed { position: absolute; left: 0; top: 0; border-radius: 50%; opacity: 0; }
    .badge { position: absolute; left: 0; top: 0; height: 20px; padding: 0 8px; box-sizing: border-box; border-radius: 10px;
      font: 500 11px/18px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: #fff; letter-spacing: 0.01em;
      max-width: 150px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--rim);
      background: linear-gradient(to bottom right, var(--pill0) 0%, var(--pill1) 46%, var(--pill2) 100%);
      box-shadow: 0 1px 6px rgba(0, 0, 0, 0.2), 0 0 8px var(--halo); }
    .badge:empty { display: none; }`;

  let host = null; // the <fowlbrowser-cursor> element while shown
  let parts = null;
  let observer = null;
  let idleTimer = 0;
  let exiting = null; // Promise while the exit animation runs
  let last = null; // last rendered tip { x, y }, kept after the cursor fades
  let label = '';
  let badgeWidth = 0;
  let pos = { x: 0, y: 0 }; // where the tip is drawn
  let rot = 0; // the arrow's turn away from its rest pose, radians
  let travel = null; // the planned move: Cua bezier, arc-length table, duration
  let frame = 0;
  let frameAt = 0;
  let waiting = []; // resolvers of move() promises for the current target
  let cueing = null; // { el, kind, started, ending }
  let following = 0; // follow(true) calls not yet ended (script clicks shown)
  let scriptClicks = []; // script clicks shown in follow mode, until the server drains them (record mode)
  let keepClicks = false; // record mode: the last follow(true) asked to keep them

  // DOM without HTML strings: pages with Trusted Types (YouTube, GitHub) refuse innerHTML even in this world.
  const SVG = 'http://www.w3.org/2000/svg';
  function node(tag, attrs = {}, children = [], ns = null) {
    const made = ns ? document.createElementNS(ns, tag) : document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) made.setAttribute(key, String(value));
    made.append(...children);
    return made;
  }
  const svgNode = (tag, attrs, children) => node(tag, attrs, children, SVG);

  // Styles as constructed sheets, which a page's CSP (style-src) can't block the way it blocks a <style>.
  function sheet(css) {
    try {
      const made = new CSSStyleSheet();
      made.replaceSync(css);
      return made;
    } catch {
      return null;
    }
  }

  function build() {
    // A host left by an earlier world in this document (another server session) gives way to this one.
    for (const old of document.querySelectorAll('fowlbrowser-cursor')) old.remove();
    host = document.createElement('fowlbrowser-cursor');
    host.setAttribute('aria-hidden', 'true');
    const root = host.attachShadow({ mode: 'closed' });
    const base = sheet(STYLE);
    let hiding = sheet('');
    let captureStyle = null;
    if (base && hiding) root.adoptedStyleSheets = [base, hiding];
    else {
      hiding = null; // capture() must toggle the style that is actually attached
      root.append(node('style', {}, [STYLE]), captureStyle = node('style'));
    }
    const div = (name, children = []) => node('div', { class: name }, children);
    const cues = svgNode('g', { class: 'cues' });
    const theme = svgNode('svg', { class: 'theme', viewBox: '0 0 128 128' }, [
      svgNode('g', { class: 'glow' }, GLOW.map(([w, o]) => svgNode('path', { d: ARROW, 'stroke-width': w, 'stroke-opacity': o }))),
      svgNode('path', { class: 'arrow', d: ARROW }),
      cues,
    ]);
    const press = div('press', [theme]);
    const art = div('art', [press]);
    const float = div('float', [art]);
    const speed = div('speed');
    const badge = div('badge');
    const body = div('body', [speed, float, badge]);
    const cursor = div('cursor', [body]);
    const fx = div('fx');
    root.append(fx, cursor);
    parts = { root, cursor, body, float, art, press, cues, speed, badge, fx, hiding, captureStyle };
    if (!reduced()) {
      // Cua's shared float: a slow 4 s drift of a few px and 2.5 degrees around the tip.
      const drift = Array.from({ length: 17 }, (_, i) => {
        const a = (i / 16) * 2 * Math.PI;
        return { transform: `translate(${(Math.sin(a) * 5 * S).toFixed(3)}px, ${((6 * Math.cos(a) - 5) * S).toFixed(3)}px) rotate(${(2.5 * Math.cos(a)).toFixed(3)}deg)` };
      });
      parts.float.animate(drift, { duration: 4000, iterations: Infinity });
    }
    attach();
    setLabel(label, true); // after attaching, so the badge can be measured
  }

  // In the top layer (a manual popover), so modal dialogs, popovers, fullscreen elements and transformed pages can't
  // cover or shift it; browsers without popovers still get the z-index.
  function attach() {
    document.documentElement.appendChild(host);
    try {
      host.popover = 'manual';
      host.showPopover();
    } catch {}
    // The page may rebuild <html>'s children (frameworks hydrating the document): put the host back.
    observer?.disconnect();
    observer = new MutationObserver(() => {
      if (!host || host.isConnected || !document.documentElement) return;
      if (document.documentElement.querySelector(':scope > fowlbrowser-cursor')) teardown(); // a newer world took over
      else attach();
    });
    observer.observe(document.documentElement, { childList: true });
  }

  // Back on top when something entered the top layer after the cursor (a dialog or popover opened later).
  function raise() {
    if (!host?.isConnected || !host.matches(':popover-open')) return;
    const others = document.querySelectorAll(':modal, :popover-open, :fullscreen');
    if (![...others].some((el) => el !== host)) return;
    try {
      host.hidePopover();
      host.showPopover();
    } catch {}
  }

  function teardown() {
    observer?.disconnect();
    host?.remove();
    host = parts = observer = cueing = null;
    // A document leaving (pagehide, bfcache) or a cursor going away stops showing script clicks: a restored page's
    // own clicks must never bring the cursor back.
    if (following) removeEventListener('click', onScriptClick, true);
    following = 0;
    stopFrames();
    travel = null;
    rot = 0;
    settle(false);
  }

  function setLabel(text, force) {
    if (text === undefined || (!force && text === label)) return;
    label = String(text);
    if (!parts) return;
    const fill = fillFor(label);
    const style = parts.cursor.style; // inside the closed root, never on the page-visible host
    style.setProperty('--fill', rgb(fill));
    style.setProperty('--pill0', rgb(mix([94, 151, 178], fill, 0.66), 0.925));
    style.setProperty('--pill1', rgb(mix([43, 92, 119], fill, 0.52), 0.937));
    style.setProperty('--pill2', rgb(mix([13, 27, 38], fill, 0.26), 0.96));
    style.setProperty('--rim', rgb(mix([255, 255, 255], fill, 0.55), 0.75));
    style.setProperty('--halo', rgb(fill, 0.25));
    parts.effect = fill.map((c) => Math.round(c + (255 - c) * 0.45)); // Cua's effect colour: the fill lifted to white
    parts.badge.textContent = label;
    badgeWidth = parts.badge.offsetWidth;
  }

  function viewport() {
    // In quirks mode <html>'s client size is the content's, not the viewport's.
    const el = document.compatMode === 'BackCompat' ? null : document.documentElement;
    return { w: el?.clientWidth || innerWidth, h: el?.clientHeight || innerHeight };
  }

  // A point inside the viewport: an element taller than it, or not scrolled into view, still gets a visible cursor.
  function inside(point) {
    const { w, h } = viewport();
    return { x: Math.min(Math.max(point.x, 2), Math.max(w - 2, 2)), y: Math.min(Math.max(point.y, 2), Math.max(h - 2, 2)) };
  }

  function render(speed = 0, vx = 0, vy = 0) {
    last = { x: pos.x, y: pos.y };
    if (!parts) return;
    parts.cursor.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    parts.art.style.transform = rot ? `rotate(${rot}rad)` : '';
    // The label sits under the arrow's body, kept inside the viewport.
    const { w, h } = viewport();
    const bx = Math.min(Math.max(ANCHOR * Math.SQRT1_2 - badgeWidth / 2, 2 - pos.x), w - 2 - badgeWidth - pos.x);
    const by = Math.min(ANCHOR * Math.SQRT1_2 + 19, h - 22 - pos.y);
    parts.badge.style.transform = `translate(${bx}px, ${by}px)`;
    // Cua's speed glow: a soft light behind the moving arrow, stronger and wider the faster it goes.
    const alpha = Math.min(speed * 0.00014, 0.42);
    if (alpha <= 0.02) {
      parts.speed.style.opacity = '0';
      return;
    }
    const heading = Math.PI / 4 + rot;
    const back = Math.min(speed * 0.009, 18) * K;
    const r = 30 * K * (1 + Math.min(speed * 0.00024, 0.44));
    const cx = Math.cos(heading) * ANCHOR - (vx / speed) * back;
    const cy = Math.sin(heading) * ANCHOR - (vy / speed) * back;
    Object.assign(parts.speed.style, { opacity: String(alpha), width: `${2 * r}px`, height: `${2 * r}px`,
      transform: `translate(${cx - r}px, ${cy - r}px)`,
      background: `radial-gradient(closest-side, ${rgb(parts.effect, 1)}, ${rgb(parts.effect, 0)})` });
  }

  // Current opacity and scale of an element, so a new animation starts where the running one is.
  function current(el) {
    const style = getComputedStyle(el);
    const m = style.transform.match(/^matrix\(([^,]+)/);
    return { opacity: Number(style.opacity), scale: m ? Number(m[1]) : 1 };
  }

  function animateBody(toOpacity, toScale, duration, from = current(parts.body)) {
    for (const a of parts.body.getAnimations()) a.cancel();
    return parts.body.animate([
      { opacity: from.opacity, transform: `scale(${from.scale})` },
      { opacity: toOpacity, transform: `scale(${toScale})` },
    ], { duration, easing: CURVE, fill: 'forwards' });
  }

  function resetIdle() {
    clearTimeout(idleTimer);
    // An action still running (its cue loops until the server ends it) is no idle time: a long wait_for or
    // evaluate keeps the cursor up.
    // (A cue whose end never arrived stops counting as running after 2 minutes.)
    idleTimer = setTimeout(() => (cueing && !cueing.ending && CUES[cueing.kind]?.loop && performance.now() - cueing.started < 120_000
      ? resetIdle() : hide()), IDLE_MS);
  }

  function settle(arrived) {
    const done = waiting;
    waiting = [];
    for (const resolve of done) resolve(arrived);
  }

  // Shows the cursor (first call, or after it faded): at the last known point, else where the server last had it,
  // else Cua's rest point (58% x, 55% y of the viewport).
  function ensure(opts = {}) {
    let fresh = false;
    if (!host) {
      build();
      fresh = true;
      const { w, h } = viewport();
      const from = opts.from && Number.isFinite(opts.from.x) && Number.isFinite(opts.from.y) ? opts.from : null;
      pos = inside(last ?? (from ? { x: Number(from.x), y: Number(from.y) } : { x: w * 0.58, y: h * 0.55 }));
      rot = 0;
      travel = null;
    } else if (!host.isConnected && document.documentElement) {
      attach(); // the page replaced its document element (document.open, a rebuilt <html>)
    } else {
      raise();
    }
    setLabel(opts.label);
    if (fresh || exiting) {
      exiting = null;
      animateBody(1, 1, 220, fresh ? { opacity: 0, scale: 0.85 } : undefined);
    }
    render();
    resetIdle();
  }

  // --- travel (Cua signature_arc) ---

  const minJerk = (t) => t * t * t * (10 - 15 * t + 6 * t * t);
  // A smooth bump that peaks at `at`: the follow-through past the target, then back.
  const A = 8.2;
  const B = 1.8;
  const PEAK = (A / (A + B)) ** A * (B / (A + B)) ** B;
  const bump = (t) => (t ** A * (1 - t) ** B) / PEAK;
  const wrap = (a) => {
    let r = a % (2 * Math.PI);
    if (r > Math.PI) r -= 2 * Math.PI;
    if (r < -Math.PI) r += 2 * Math.PI;
    return r;
  };

  // Cua's arc: a cubic Bezier bending upward for horizontal moves, timed by Fitts' law, walked by arc length.
  function plan(to, box, left) {
    const from = { ...pos };
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 2) return null;
    const side = dx >= 0 ? -1 : 1;
    const bend = d * 0.16 * side;
    const flow = (0.15 + 1) / 2;
    const n = { x: -dy / d, y: dx / d };
    const c1 = { x: from.x + dx * 0.3 + n.x * bend * (1 - 0.5 * flow), y: from.y + dy * 0.3 + n.y * bend * (1 - 0.5 * flow) };
    const c2 = { x: to.x - dx * 0.3 + n.x * bend * (1 - 0.5 * (1 - flow)), y: to.y - dy * 0.3 + n.y * bend * (1 - 0.5 * (1 - flow)) };
    const point = (u) => {
      const v = 1 - u;
      const a = v * v * v;
      const b = 3 * v * v * u;
      const c = 3 * v * u * u;
      const e = u * u * u;
      return { x: a * from.x + b * c1.x + c * c2.x + e * to.x, y: a * from.y + b * c1.y + c * c2.y + e * to.y };
    };
    const lengths = [0];
    let prev = from;
    for (let i = 1; i <= 64; i++) {
      const p = point(i / 64);
      lengths.push(lengths[i - 1] + Math.hypot(p.x - prev.x, p.y - prev.y));
      prev = p;
    }
    const total = lengths[64];
    const near = point(1 - 1e-3);
    const tail = Math.hypot(to.x - near.x, to.y - near.y) || 1;
    const width = Math.max(Math.min(box?.w ?? 24, box?.h ?? 24), 4);
    const ms = Math.min(Math.min(Math.max(150 + 120 * Math.log2(d / width + 1), 300), 1000) * TIMING, MAX_MOVE_MS, left);
    return {
      to, ms, over: Math.min(0.018, (8 * K) / d), start: performance.now(), arrived: false,
      // The point `frac` of the way along by distance; past 1 it carries on along the end tangent.
      at(frac) {
        if (frac > 1) return { x: to.x + ((to.x - near.x) / tail) * (frac - 1) * total, y: to.y + ((to.y - near.y) / tail) * (frac - 1) * total };
        const s = Math.max(frac, 0) * total;
        let lo = 0;
        let hi = 64;
        while (hi - lo > 1) {
          const mid = (lo + hi) >> 1;
          if (lengths[mid] < s) lo = mid;
          else hi = mid;
        }
        const f = (s - lengths[lo]) / Math.max(lengths[hi] - lengths[lo], 1e-9);
        return point((lo + f) / 64);
      },
    };
  }

  function startFrames() {
    if (frame) return;
    frameAt = performance.now();
    frame = requestAnimationFrame(tick);
  }

  function stopFrames() {
    if (frame) cancelAnimationFrame(frame);
    frame = 0;
  }

  function tick(now) {
    const dt = Math.min((now - frameAt) / 1000, 0.064);
    frameAt = now;
    let speed = 0;
    let vx = 0;
    let vy = 0;
    if (travel) {
      const m = travel;
      const profile = (t) => m.at(minJerk(t) + m.over * bump(t));
      const t = Math.min((now - m.start) / m.ms, 1);
      pos = profile(t);
      // Velocity from the neighbouring samples (about 17 ms either side), as Cua does for the heading.
      const h = 1000 / 60 / m.ms;
      const t0 = Math.max(t - h, 0);
      const t1 = Math.min(t + h, 1);
      const a = profile(t0);
      const b = profile(t1);
      const span = ((t1 - t0) * m.ms) / 1000;
      if (span > 0) {
        vx = (b.x - a.x) / span;
        vy = (b.y - a.y) / span;
        speed = Math.hypot(vx, vy);
      }
      if (!m.arrived && Math.hypot(m.to.x - pos.x, m.to.y - pos.y) <= 1) {
        m.arrived = true;
        settle(true);
      }
      if (t >= 1) {
        pos = { ...m.to };
        travel = null;
        settle(true);
      }
    }
    // The tip leads along the direction of travel once it moves fast enough, and turns back to rest after.
    const want = speed > 0 ? wrap(Math.atan2(vy, vx) - TIP_ANGLE) * Math.min(Math.max((speed - 40) / 260, 0), 1) : 0;
    rot += wrap(want - rot) * (1 - Math.exp(-dt * 22));
    if (!travel && Math.abs(rot) < 0.002) rot = 0;
    render(speed, vx, vy);
    frame = travel || rot ? requestAnimationFrame(tick) : 0;
  }

  // Reduced motion: no travel, the pointer crossfades from where it was to the target in 120 ms.
  function jump(to) {
    stopFrames();
    travel = null;
    rot = 0;
    const ghost = parts.cursor.cloneNode(true);
    parts.root.appendChild(ghost);
    ghost.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: CURVE, fill: 'forwards' }).finished
      .then(() => ghost.remove(), () => ghost.remove());
    pos = { ...to };
    render();
    return parts.cursor.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 120, easing: CURVE }).finished
      .then(() => true, () => true);
  }

  // --- cues ---

  function track(pairs, frames, linear, css) {
    const keys = pairs.map(([f, v]) => ({ offset: f / frames, easing: linear ? 'linear' : LOTTIE, ...css(v) }));
    if (keys[0].offset > 0) keys.unshift({ ...keys[0], offset: 0 });
    if (keys[keys.length - 1].offset < 1) keys.push({ ...keys[keys.length - 1], offset: 1 });
    return keys;
  }

  function endCue(fast) {
    const c = cueing;
    if (!c || c.ending) return;
    c.ending = true;
    const wait = fast ? 0 : Math.max(0, MIN_CUE_MS - (performance.now() - c.started));
    setTimeout(() => {
      const fade = c.el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: fast ? 120 : 200, easing: CURVE, fill: 'forwards' });
      fade.finished.catch(() => {}).then(() => {
        c.el.remove();
        if (cueing === c) cueing = null;
      });
    }, wait);
  }

  function playCue(kind) {
    const spec = CUES[kind];
    if (!spec || !parts) return;
    if (spec.loop && cueing?.kind === kind && !cueing.ending) return; // already playing
    endCue(true);
    const width = (spec.width ?? 4) * 1.4; // bolder than Cua's, so the glyphs still read at our smaller size
    const d = spec.paths.join('');
    const layers = [
      ...CUE_GLOW.map(([e, o]) => svgNode('path', { class: 'tint', d, 'stroke-width': width + e, 'stroke-opacity': o })),
      svgNode('path', { class: 'rim', d, 'stroke-width': width + 1.5 }),
      svgNode('path', { class: 'tint', d, 'stroke-width': Math.max(width - 1, 1.5) }),
    ];
    const grow = svgNode('g', { class: 'grow' }, [svgNode('g', { transform: 'translate(-64 -64)' }, layers)]);
    const at = svgNode('g', { class: 'at' }, [grow]);
    const el = svgNode('g', { class: 'cue' }, [at]);
    parts.cues.appendChild(el);
    const c = { el, kind, started: performance.now(), ending: false };
    cueing = c;
    const place = ([x, y]) => ({ transform: `translate(${x}px, ${y}px)` });
    if (reduced()) {
      at.style.transform = place(spec.at[0][1]).transform;
      if (!spec.loop) setTimeout(() => cueing === c && endCue(false), MIN_CUE_MS);
      return;
    }
    const timing = { duration: (spec.frames / 30) * 1000, iterations: spec.loop ? Infinity : 1, fill: 'forwards' };
    if (spec.at.length > 1) at.animate(track(spec.at, spec.frames, spec.linear, place), timing);
    else at.style.transform = place(spec.at[0][1]).transform;
    if (spec.scale) grow.animate(track(spec.scale, spec.frames, spec.linear, (s) => ({ transform: `scale(${s})` })), timing);
    const shown = at.animate(track(spec.opacity, spec.frames, spec.linear, (o) => ({ opacity: o })), timing);
    if (!spec.loop) {
      shown.finished.catch(() => {}).then(() => {
        el.remove();
        if (cueing === c) cueing = null;
      });
    }
  }

  // --- API ---

  function move(x, y, opts = {}) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return Promise.resolve(false);
    ensure(opts);
    const to = inside({ x: Number(x), y: Number(y) });
    settle(false); // an earlier target was not reached
    let resolveOwn;
    const arrived = new Promise((resolve) => { resolveOwn = resolve; waiting.push(resolve); });
    const own = (ok) => {
      if (!waiting.includes(resolveOwn)) return;
      waiting = waiting.filter((r) => r !== resolveOwn);
      resolveOwn(ok);
    };
    // opts.until (wall clock ms): when the action goes ahead. The travel fits into the time left.
    const left = Number.isFinite(opts.until) ? opts.until - Date.now() : Infinity;
    // A hidden document gets no frames (rAF and animations stop), and too little time left shows no travel:
    // the cursor just goes there.
    if (document.hidden || left < MIN_MOVE_MS) {
      snap(to);
      own(true);
      return arrived;
    }
    if (reduced()) {
      if (pos.x === to.x && pos.y === to.y) own(true);
      else jump(to).then((ok) => own(host ? ok : false));
      return arrived;
    }
    const box = Number.isFinite(opts.w) && Number.isFinite(opts.h) ? { w: opts.w, h: opts.h } : null;
    const planned = plan(to, box, left);
    travel = planned;
    if (!travel) {
      pos = { ...to };
      render();
      own(true);
    } else {
      // Frames can stop under us (the window covered or on another Space): the move still ends on time.
      setTimeout(() => { if (travel === planned) snap(planned.to); }, Math.min(planned.ms + 150, left));
    }
    startFrames();
    return arrived;
  }

  // Just before the action: the tip on the target at full opacity now, whatever travel or appear fade is left (a busy
  // page gave them no frames). The page runs this before the action's input events, so they paint together.
  function land(x, y, opts = {}) {
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return false;
    const to = inside({ x: Number(x), y: Number(y) });
    if (host && !exiting && Math.hypot(to.x - pos.x, to.y - pos.y) <= 2 && current(parts.body).opacity >= 0.99) return false;
    ensure(opts);
    exiting = null;
    for (const a of [...parts.body.getAnimations(), ...parts.cursor.getAnimations()]) a.cancel();
    snap(to);
    return true;
  }

  // Straight to a point, done: no travel left, everyone waiting has arrived.
  function snap(to) {
    stopFrames();
    travel = null;
    rot = 0;
    pos = { ...to };
    render();
    settle(true);
  }

  function cue(kind, opts = {}) {
    ensure(opts);
    playCue(kind);
  }

  function cueEnd() {
    if (cueing && CUES[cueing.kind]?.loop) endCue(false);
  }

  // x, y: where the click happened. A cursor that hasn't got there yet (a late or slow move) jumps there first, so
  // the feedback is on the clicked spot.
  function click(x, y) {
    if (!host) return;
    resetIdle();
    if (Number.isFinite(x) && Number.isFinite(y)) {
      const at = inside({ x, y });
      if (Math.hypot(at.x - pos.x, at.y - pos.y) > 12) snap(at); // (a few px off is the follow-through settling)
    }
    playCue('click');
    if (reduced()) return;
    // Cua's click: the arrow squishes 12% around its tip, and a ring spreads from the point.
    for (const a of parts.press.getAnimations()) a.cancel();
    parts.press.animate([
      { transform: 'scale(1)', easing: 'ease-out' },
      { transform: 'scale(0.88)', offset: 50 / 165 },
      { transform: 'scale(0.88)', offset: 90 / 165, easing: 'cubic-bezier(0.37, 0, 0.63, 1)' },
      { transform: 'scale(1)' },
    ], { duration: 165 });
    const circle = svgNode('circle', { cx: 0, cy: 0, r: 8 * K, fill: 'none', stroke: rgb(parts.effect), 'stroke-width': 5 * K });
    const ring = svgNode('svg', { width: 1, height: 1 }, [circle]);
    ring.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    parts.fx.appendChild(ring);
    circle.animate([{ r: `${8 * K}px` }, { r: `${52 * K}px` }], { duration: 520, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'forwards' });
    circle.animate([{ strokeWidth: `${5 * K}px`, opacity: 0.75 }, { strokeWidth: `${1 * K}px`, opacity: 0 }], { duration: 520, fill: 'forwards' })
      .finished.then(() => ring.remove(), () => ring.remove());
  }

  // An agent that clicks from a script (evaluate) sends no real input, so the tools can't animate it: the overlay
  // hears those clicks itself and shows them, so the user still sees each one. Real input (isTrusted) is either a tool's
  // own, already animated, or the user's.
  function onScriptClick(event) {
    if (event.isTrusted) return;
    const target = event.composedPath()[0];
    if (!(target instanceof Element) || target === host) return;
    const box = target.getBoundingClientRect();
    if (!box.width && !box.height) return;
    if (keepClicks) {
      scriptClicks.push({ t: Date.now(), x: box.left + box.width / 2, y: box.top + box.height / 2 });
      if (scriptClicks.length > 50) scriptClicks.shift();
    }
    move(box.left + box.width / 2, box.top + box.height / 2, { w: box.width, h: box.height }).then((arrived) => { if (arrived) click(); });
  }

  function follow(on, record = false) {
    if (on) keepClicks = record;
    if (on && following++ === 0) addEventListener('click', onScriptClick, true);
    if (!on && following > 0 && --following === 0) removeEventListener('click', onScriptClick, true);
  }

  function hide() {
    clearTimeout(idleTimer);
    if (!host) return Promise.resolve();
    if (exiting) return exiting;
    stopFrames();
    travel = null;
    settle(false);
    const anim = animateBody(0, 0.9, 200);
    const done = anim.finished.then(() => true, () => false).then((finished) => {
      if (exiting === done && finished) {
        exiting = null;
        teardown();
      }
    });
    exiting = done;
    return done;
  }

  function capture(on) {
    const css = on ? ':host { display: none !important; }' : '';
    if (parts?.hiding) parts.hiding.replaceSync(css);
    else if (parts?.captureStyle) parts.captureStyle.textContent = css;
    return !!parts;
  }

  // What a viewer sees (record mode): the host attached and displayed, the arrow's effective opacity (its own times
  // its ancestors' in the shadow tree) and the tip in viewport CSS px.
  function state() {
    const attached = !!host?.isConnected;
    const displayed = attached && host.checkVisibility();
    let opacity = 0;
    if (parts) {
      opacity = 1;
      for (let el = parts.root.querySelector('.arrow'); el && el !== parts.root; el = el.parentNode) opacity *= Number(getComputedStyle(el).opacity);
    }
    const { w, h } = viewport();
    const inView = pos.x >= 0 && pos.y >= 0 && pos.x <= w && pos.y <= h;
    return { attached, displayed, opacity, x: pos.x, y: pos.y, visible: displayed && opacity > 0.5 && inView, hidden: document.hidden };
  }

  function drainClicks() {
    const drained = scriptClicks;
    scriptClicks = [];
    return drained;
  }

  // A page going into the back/forward cache drops its cursor, so a restored page never brings back a stale one
  // (the server tracks the cursor per document and would not hide it for screenshots).
  addEventListener('pagehide', () => { exiting = null; teardown(); });

  Object.defineProperty(globalThis, '__fbCursor', { value: Object.freeze({ move, land, cue, cueEnd, click, follow, hide, capture, state, drainClicks }) });
})();

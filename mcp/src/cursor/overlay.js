// FowlBrowser agent cursor: evaluated by the MCP server in the isolated world "fowlbrowser-cursor" of a tab's top
// frame (see docs/cursor-spec.md). Defines globalThis.__fbCursor once per document:
//   move(x, y, opts) -> Promise<arrived>   opts { label, from, w, h, until }: from is the last point the server knows
//                                           (for a fresh document), w,h the target's box (bigger targets are quicker),
//                                           until the wall-clock ms by which it must arrive
//   land(x, y, opts) -> changed             the tip on (x, y) at full opacity at once (travel and appear fade cut short)
//   cue(kind, opts) / cueEnd()             the action as a word in the label: observe, scroll, text, key, navigate, drag,
//                                          transfer ("Claude · typing")
//   click()                                press and ring at the current point
//   follow(on, record)                     while on, travels to and clicks on clicks a script makes (an agent's evaluate);
//                                          record: also keep them for drainClicks
//   hide()                                 exit animation, then the host is removed; resolves when gone
//   capture(on)                            display:none while the agent takes a screenshot
//   state() / drainClicks()                record mode: what a viewer sees now; script clicks shown since the last drain
// No dependencies. rAF runs only while the pointer travels or turns back to rest; the rest is WAAPI.
(() => {
  if (globalThis.__fbCursor) return;

  // FowlBrowser's pointer: a rounded arrow filled with the session's colour, a white rim and a soft shadow. Drawn in
  // a 24-unit box with the tip's corner at 0,0 and shown at SCALE px per unit; TIP is the rounded tip's apex, which
  // sits on the target point.
  const POINTER = 'M1.52 1.59Q0 0 0 2.2L0 13.6Q0 17 2.76 15.01L3.21 14.69Q5 13.4 7.19 13.15L8.62 12.99Q12 12.6 9.66 10.14Z';
  const SCALE = 1.2;
  const TIP = { x: 0.38, y: 0.95 };
  const BLUE = [10, 132, 255];
  const PALETTE = [[255, 159, 10], [48, 209, 88], [191, 90, 242], [255, 55, 95], [64, 200, 224], [94, 92, 230],
    [255, 69, 58], [172, 142, 104]];
  const CURVE = 'cubic-bezier(0.23, 1, 0.32, 1)';
  const IDLE_MS = 15_000; // the cursor fades this long after the last action
  const TIMING = 0.9; // Fitts' law durations, a little quick: agents wait for arrival
  const MAX_MOVE_MS = 850;
  const MIN_MOVE_MS = 120; // less time left than this before the action: the cursor appears at the target
  const TIP_ANGLE = -0.63 * Math.PI; // where the tip points at rest (up and a little to the left)
  const LEAN = 0.5; // at most this far (radians) the tip leans into the direction of travel
  const BADGE = { x: 12 * SCALE + 2, y: 18 * SCALE + 2 }; // the label, from the tip
  const MIN_CUE_MS = 600; // an action word for a quick action stays long enough to be read
  const ONE_SHOT_MS = 1200; // a key press or a page load: its word shows this long
  const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Actions shown as a word after the label. Held words stay while the action runs; the others show for a moment.
  const VERBS = { observe: 'reading', scroll: 'scrolling', text: 'typing', key: 'pressing keys', navigate: 'loading',
    drag: 'dragging', transfer: 'uploading' };
  const HELD = new Set(['observe', 'scroll', 'text', 'drag', 'transfer']);

  // Session colours: "Claude" (the default label) is blue, other labels hash into the palette, so parallel agents
  // are told apart. Labels on light fills are written in ink.
  function fillFor(label) {
    if (!label || label === 'Claude') return BLUE;
    let hash = 2166136261;
    for (const ch of label) hash = Math.imul(hash ^ ch.codePointAt(0), 16777619) >>> 0;
    return PALETTE[hash % PALETTE.length];
  }
  const luminance = (c) => c.map((v) => { const s = v / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; })
    .reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const rgb = (c, a = 1) => `rgba(${c[0]}, ${c[1]}, ${c[2]}, ${a})`;

  const STYLE = `
    :host { all: initial !important; position: fixed !important; inset: 0 !important; pointer-events: none !important;
      z-index: 2147483647 !important; contain: strict !important; display: block !important; }
    @media print { :host { display: none !important; } }
    .cursor, .fx { position: absolute; left: 0; top: 0; will-change: transform; }
    .body, .art, .press { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
    svg { position: absolute; overflow: visible; }
    .pointer { left: ${(-4 - TIP.x) * SCALE}px; top: ${(-4 - TIP.y) * SCALE}px; width: ${24 * SCALE}px; height: ${28 * SCALE}px;
      filter: drop-shadow(0 1px 1.2px rgba(0, 0, 0, 0.32)); }
    .arrow { fill: var(--fill); stroke: #fff; stroke-width: ${1.7 / SCALE}; stroke-linejoin: round; paint-order: stroke; }
    .edge { fill: none; stroke: #131110; stroke-opacity: 0.3; stroke-width: ${0.45 / SCALE}; }
    .badge { position: absolute; left: 0; top: 0; height: 17px; padding: 0 7px; box-sizing: border-box; border-radius: 8.5px;
      font: 600 10.5px/17px -apple-system, BlinkMacSystemFont, system-ui, sans-serif; color: var(--text); letter-spacing: 0.01em;
      max-width: 200px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; background: var(--fill);
      box-shadow: 0 0 0 1.5px #fff, 0 1px 3px rgba(0, 0, 0, 0.3); }
    .verb { font-weight: 500; opacity: 0.8; }`;

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
  let travel = null; // the planned move: bezier, arc-length table, duration
  let frame = 0;
  let frameAt = 0;
  let waiting = []; // resolvers of move() promises for the current target
  let cueing = null; // { kind, started, ending }: the action word shown
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
    const pointer = svgNode('svg', { class: 'pointer', viewBox: '-4 -4 24 28' }, [
      svgNode('path', { class: 'arrow', d: POINTER }),
      svgNode('path', { class: 'edge', d: POINTER }),
    ]);
    const press = div('press', [pointer]);
    const art = div('art', [press]);
    const name = node('span');
    const verb = node('span', { class: 'verb' });
    const badge = div('badge', [name, verb]);
    const body = div('body', [art, badge]);
    const cursor = div('cursor', [body]);
    const fx = div('fx');
    root.append(fx, cursor);
    parts = { root, cursor, body, art, press, name, verb, badge, fx, hiding, captureStyle };
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
    style.setProperty('--text', luminance(fill) > 0.4 ? '#131110' : '#fff');
    parts.fill = fill;
    parts.name.textContent = label;
    parts.badge.style.display = label ? '' : 'none';
    badgeWidth = parts.badge.offsetWidth;
  }

  // The action word after the label ("Claude · typing"); '' takes it away.
  function setVerb(text) {
    if (!parts) return;
    parts.verb.textContent = text ? ` · ${text}` : '';
    badgeWidth = parts.badge.offsetWidth;
    render();
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

  function render() {
    last = { x: pos.x, y: pos.y };
    if (!parts) return;
    parts.cursor.style.transform = `translate3d(${pos.x}px, ${pos.y}px, 0)`;
    parts.art.style.transform = rot ? `rotate(${rot}rad)` : '';
    // The label sits below and to the right of the pointer, kept inside the viewport.
    const { w, h } = viewport();
    const bx = Math.min(BADGE.x, w - 2 - badgeWidth - pos.x);
    const by = Math.min(BADGE.y, h - 19 - pos.y);
    parts.badge.style.transform = `translate(${bx}px, ${by}px)`;
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
    idleTimer = setTimeout(() => (cueing && !cueing.ending && HELD.has(cueing.kind) && performance.now() - cueing.started < 120_000
      ? resetIdle() : hide()), IDLE_MS);
  }

  function settle(arrived) {
    const done = waiting;
    waiting = [];
    for (const resolve of done) resolve(arrived);
  }

  // Shows the cursor (first call, or after it faded): at the last known point, else where the server last had it,
  // else a little right of and below the viewport's centre.
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

  // --- travel (a curved, Fitts-timed path, after Cua's signature_arc; MIT, see THIRD_PARTY_NOTICES.md) ---

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

  // A cubic Bezier bending upward for horizontal moves, timed by Fitts' law, walked by arc length.
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
      to, ms, over: Math.min(0.018, 6 / d), start: performance.now(), arrived: false,
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
      // Velocity from the neighbouring samples (about 17 ms either side), for the lean.
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
    // The tip leans a little into the direction of travel once it moves fast enough, and settles back after.
    const toward = Math.min(Math.max(wrap(Math.atan2(vy, vx) - TIP_ANGLE), -LEAN), LEAN);
    const want = speed > 0 ? toward * Math.min(Math.max((speed - 40) / 260, 0), 1) : 0;
    rot += wrap(want - rot) * (1 - Math.exp(-dt * 22));
    if (!travel && Math.abs(rot) < 0.002) rot = 0;
    render();
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

  // --- action words ---

  // The word goes once the action has shown long enough to be read (at once when another action takes over).
  function endCue(fast) {
    const c = cueing;
    if (!c || c.ending) return;
    c.ending = true;
    const wait = fast ? 0 : Math.max(0, MIN_CUE_MS - (performance.now() - c.started));
    setTimeout(() => {
      if (cueing !== c) return;
      cueing = null;
      setVerb('');
    }, wait);
  }

  function playCue(kind) {
    const verb = VERBS[kind];
    if (!verb || !parts) return;
    if (cueing?.kind === kind && !cueing.ending) return; // already showing
    const c = { kind, started: performance.now(), ending: false };
    cueing = c;
    setVerb(verb);
    if (!HELD.has(kind)) setTimeout(() => cueing === c && endCue(false), ONE_SHOT_MS);
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
    if (cueing && HELD.has(cueing.kind)) endCue(false);
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
    if (reduced()) return;
    // The pointer presses in around its tip, and a ring of the session's colour spreads from the point.
    for (const a of parts.press.getAnimations()) a.cancel();
    parts.press.animate([
      { transform: 'scale(1)', easing: 'ease-out' },
      { transform: 'scale(0.86)', offset: 0.35 },
      { transform: 'scale(1)', easing: 'cubic-bezier(0.34, 1.56, 0.64, 1)' },
    ], { duration: 220 });
    const circle = svgNode('circle', { cx: 0, cy: 0, r: 5, fill: 'none', stroke: rgb(parts.fill), 'stroke-width': 2.4 });
    const ring = svgNode('svg', { width: 1, height: 1 }, [circle]);
    ring.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
    parts.fx.appendChild(ring);
    circle.animate([{ r: '5px' }, { r: '22px' }], { duration: 420, easing: 'cubic-bezier(0.33, 1, 0.68, 1)', fill: 'forwards' });
    circle.animate([{ strokeWidth: '2.4px', opacity: 0.85 }, { strokeWidth: '0.6px', opacity: 0 }], { duration: 420, fill: 'forwards' })
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

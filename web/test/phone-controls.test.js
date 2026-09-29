import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { PhoneControls } from '../lib/phone-controls.js';
import { HEXEN_TOUCH_KEYCODES } from '../lib/hexen-touch-keymap.js';

const KEYS = HEXEN_TOUCH_KEYCODES;

function makeElement(action, rect = { left: 0, top: 0, width: 120, height: 120 }, children = {}) {
  const listeners = new Map();
  const classes = new Set();
  const childNodes = [];
  const el = {
    dataset: action ? { phoneAction: action } : {},
    className: '',
    parentNode: null,
    style: {
      setProperty(name, value) { this[name] = value; },
      get(name) { return this[name]; },
      transform: '',
    },
    classList: {
      add: (...names) => names.forEach((n) => classes.add(n)),
      remove: (...names) => names.forEach((n) => classes.delete(n)),
      toggle: (name, force) => {
        if (force === undefined) {
          if (classes.has(name)) classes.delete(name); else classes.add(name);
        } else if (force) classes.add(name); else classes.delete(name);
      },
      contains: (name) => classes.has(name),
    },
    querySelector: (selector) => children[selector] ?? null,
    querySelectorAll: () => [],
    closest(selector) {
      return selector.includes(this.dataset.phoneAction) || selector === '[data-phone-action]' ? this : null;
    },
    getBoundingClientRect: () => rect,
    addEventListener(name, callback) { listeners.set(name, callback); },
    removeEventListener(name) { listeners.delete(name); },
    setPointerCapture() {},
    releasePointerCapture() {},
    setAttribute() {},
    animate() { return { onfinish: null, cancel() {} }; },
    appendChild(child) {
      childNodes.push(child);
      child.parentNode = el;
      return child;
    },
    remove() {
      const siblings = el.parentNode?.childNodes ?? [];
      const i = siblings.indexOf(el);
      if (i >= 0) siblings.splice(i, 1);
      el.parentNode = null;
    },
    get firstChild() { return childNodes[0] ?? null; },
    get childNodes() { return childNodes; },
    get nextSibling() {
      const siblings = el.parentNode?.childNodes ?? [];
      const i = siblings.indexOf(el);
      return i >= 0 ? siblings[i + 1] ?? null : null;
    },
    ownerDocument: { createElement: () => makeElement(null) },
    dispatch(name, event) { listeners.get(name)?.(event); },
  };
  return el;
}

function pointer(target, pointerId, x, y) {
  return {
    target,
    pointerId,
    clientX: x,
    clientY: y,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.stopped = true; },
  };
}

test('stick emits an analog vector with a walk-to-run sweep, zeroed on release', () => {
  const root = makeElement(null);
  const stick = makeElement('stick');
  const moves = [];
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move: (x, y) => moves.push([x, y]),
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  root.dispatch('pointermove', pointer(stick, 1, 60, 0));
  root.dispatch('pointermove', pointer(stick, 1, 120, 60));
  root.dispatch('pointerup', pointer(stick, 1, 120, 60));

  assert.deepEqual(moves, [
    [0, -1],
    [1, 0],
    [0, 0],
  ]);
});

test('stick deadzone swallows the rest position and rescales the sweep', () => {
  const root = makeElement(null);
  const stick = makeElement('stick');
  const moves = [];
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move: (x, y) => moves.push([x, y]),
  }, { keys: KEYS, stickDeadZone: 0.18 });
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  // 6px drift: magnitude 0.1, inside the deadzone — silence.
  root.dispatch('pointermove', pointer(stick, 1, 60, 54));
  // Half deflection: magnitude 0.5 rescales to ((0.5 - 0.18) / 0.82) ^ stickResponse.
  root.dispatch('pointermove', pointer(stick, 1, 60, 30));
  root.dispatch('pointerup', pointer(stick, 1, 60, 30));

  assert.equal(moves.length, 2);
  assert.deepEqual(moves[1], [0, 0]);
  const expected = Math.pow((0.5 - 0.18) / (1 - 0.18), 1.7);
  assert.ok(Math.abs(moves[0][0]) < 1e-9);
  assert.ok(Math.abs(moves[0][1] + expected) < 1e-9, `half deflection walks gently at ${expected}`);
});

test('stick response 1 restores the old linear sweep', () => {
  const root = makeElement(null);
  const stick = makeElement('stick');
  const moves = [];
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move: (x, y) => moves.push([x, y]),
  }, { keys: KEYS, stickDeadZone: 0.18, stickResponse: 1 });
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  root.dispatch('pointermove', pointer(stick, 1, 60, 30));

  const expected = (0.5 - 0.18) / (1 - 0.18);
  assert.ok(Math.abs(moves[0][1] + expected) < 1e-9, `linear sweep at ${expected}`);
});

test('stick response curve still reaches full run at the edge', () => {
  const root = makeElement(null);
  const stick = makeElement('stick');
  const moves = [];
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move: (x, y) => moves.push([x, y]),
  }, { keys: KEYS }); // default stickResponse 1.7
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  root.dispatch('pointermove', pointer(stick, 1, 120, 60));

  assert.deepEqual(moves, [[1, 0]], 'punching it to the edge is still full hyperspace');
});

test('stick thumb travel is proportional to the ring and reports deflection power', () => {
  const root = makeElement(null);
  const stick = makeElement('stick'); // 120px ring: radius 60, thumb travel 60 - 120 * 0.21
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS, stickDeadZone: 0.18 });
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  // Full deflection right: thumb must reach the ring edge, power at max.
  root.dispatch('pointermove', pointer(stick, 1, 120, 60));
  assert.equal(root.style.get('--stick-x'), '34.8px');
  assert.equal(root.style.get('--stick-y'), '0px');
  assert.equal(root.style.get('--stick-power'), '1');
  // Half deflection: power follows the response curve like the vector.
  root.dispatch('pointermove', pointer(stick, 1, 60, 30));
  assert.equal(root.style.get('--stick-y'), '-17.4px');
  const expected = Math.pow((0.5 - 0.18) / (1 - 0.18), 1.7);
  assert.ok(Math.abs(Number(root.style.get('--stick-power')) - expected) < 1e-9);
  // Release parks the thumb and kills the glow.
  root.dispatch('pointerup', pointer(stick, 1, 60, 30));
  assert.equal(root.style.get('--stick-x'), '0px');
  assert.equal(root.style.get('--stick-power'), '0');
});

test('multi-touch buttons and look region keep independent pointer ownership', () => {
  const root = makeElement(null);
  const attack = makeElement('attack');
  const look = makeElement('look');
  const keys = [];
  const looks = [];
  const controls = new PhoneControls(root, {
    key: (key, down) => keys.push([key, down]),
    look: (dx, dy) => looks.push([dx, dy]),
  }, { lookSensitivity: 2, maxLookDelta: 10, keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(attack, 7, 10, 10));
  root.dispatch('pointerdown', pointer(look, 8, 100, 100));
  root.dispatch('pointermove', pointer(look, 8, 140, 90));
  root.dispatch('pointerup', pointer(attack, 7, 10, 10));

  assert.deepEqual(keys, [[KEYS.attack, true], [KEYS.attack, false]]);
  assert.deepEqual(looks, [[20, -20]], 'look deltas are clamped before sensitivity scaling');
});

test('fast flicks survive the look clamp instead of being truncated', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const looks = [];
  const controls = new PhoneControls(root, {
    key() {},
    look: (dx, dy) => looks.push([dx, dy]),
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(look, 8, 100, 100));
  root.dispatch('pointermove', pointer(look, 8, 300, 100));

  assert.deepEqual(looks, [[200, 0]], 'a 200px flick must not be cut down to the old 48px ceiling');
});

function tpointer(target, pointerId, x, y, timeStamp) {
  return { ...pointer(target, pointerId, x, y), timeStamp };
}

test('look acceleration boosts fast flicks over slow drags', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const looks = [];
  const controls = new PhoneControls(root, {
    key() {},
    look: (dx, dy) => looks.push([dx, dy]),
  }, { lookSensitivity: 1, lookAccel: 1, lookAccelPower: 1 });
  controls.attach();

  root.dispatch('pointerdown', tpointer(look, 1, 0, 0, 1000));
  // Slow: 10px over 100ms. First move of a drag is always linear.
  root.dispatch('pointermove', tpointer(look, 1, 10, 0, 1100));
  // Fast: same 10px over 10ms. Gain rides the smoothed speed, so it lands boosted.
  root.dispatch('pointermove', tpointer(look, 1, 20, 0, 1110));
  root.dispatch('pointerup', tpointer(look, 1, 20, 0, 1120));

  assert.equal(looks.length, 2);
  assert.deepEqual(looks[0], [10, 0], 'touchdown never punches the camera');
  assert.ok(looks[1][0] > looks[0][0], `fast flick ${looks[1][0]} beats slow drag ${looks[0][0]}`);
  assert.equal(looks[1][1], 0);
});

test('look acceleration at zero is plain linear drag', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const looks = [];
  const controls = new PhoneControls(root, {
    key() {},
    look: (dx, dy) => looks.push([dx, dy]),
  }, { lookSensitivity: 1, lookAccel: 0 });
  controls.attach();

  root.dispatch('pointerdown', tpointer(look, 1, 0, 0, 1000));
  root.dispatch('pointermove', tpointer(look, 1, 10, 0, 1001));
  root.dispatch('pointermove', tpointer(look, 1, 20, 0, 1002));

  assert.deepEqual(looks, [[10, 0], [10, 0]]);
});

test('look without event timestamps stays linear', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const looks = [];
  const controls = new PhoneControls(root, {
    key() {},
    look: (dx, dy) => looks.push([dx, dy]),
  }, { lookSensitivity: 2 }); // default accel on, but no timeStamp on these events
  controls.attach();

  root.dispatch('pointerdown', pointer(look, 1, 0, 0));
  root.dispatch('pointermove', pointer(look, 1, 30, 0));

  assert.deepEqual(looks, [[60, 0]]);
});

test('button presses buzz when haptics are available', () => {
  const vibrated = [];
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', {
    value: { vibrate: (ms) => vibrated.push(ms) },
    configurable: true,
  });
  try {
    const root = makeElement(null);
    const attack = makeElement('attack');
    const controls = new PhoneControls(root, {
      key() {},
      look() {},
    }, { keys: KEYS });
    controls.attach();

    root.dispatch('pointerdown', pointer(attack, 7, 10, 10));
    root.dispatch('pointerup', pointer(attack, 7, 10, 10));

    assert.deepEqual(vibrated, [8], 'one buzz on press, none on release');
  } finally {
    if (descriptor) Object.defineProperty(globalThis, 'navigator', descriptor);
    else delete globalThis.navigator;
  }
});

test('menu back button presses the menu-back key', () => {
  const root = makeElement(null);
  const back = makeElement('menuBack');
  const events = [];
  const controls = new PhoneControls(root, { key: (key, down) => events.push([key, down]), look() {} }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(back, 11, 10, 10));
  root.dispatch('pointerup', pointer(back, 11, 10, 10));

  assert.deepEqual(events, [
    [KEYS.menuBack, true],
    [KEYS.menuBack, false],
  ]);
});

test('gameplay controls use movement and action bindings that match their labels', () => {
  assert.deepEqual({
    forward: HEXEN_TOUCH_KEYCODES.forward,
    back: HEXEN_TOUCH_KEYCODES.back,
    left: HEXEN_TOUCH_KEYCODES.left,
    right: HEXEN_TOUCH_KEYCODES.right,
    attack: HEXEN_TOUCH_KEYCODES.attack,
    jump: HEXEN_TOUCH_KEYCODES.jump,
    use: HEXEN_TOUCH_KEYCODES.use,
    worldUse: HEXEN_TOUCH_KEYCODES.worldUse,
    crouch: HEXEN_TOUCH_KEYCODES.crouch,
    artifactPrev: HEXEN_TOUCH_KEYCODES.artifactPrev,
    artifactNext: HEXEN_TOUCH_KEYCODES.artifactNext,
  }, {
    forward: 272, // K_TOUCH_FORWARD
    back: 273, // K_TOUCH_BACK
    left: 274, // K_TOUCH_LEFT
    right: 275, // K_TOUCH_RIGHT
    attack: 276, // K_TOUCH_ATTACK
    jump: 277, // K_TOUCH_JUMP
    use: 278, // K_TOUCH_USE
    worldUse: 284, // K_TOUCH_WORLD_USE
    crouch: 285, // K_TOUCH_CROUCH
    artifactPrev: 286, // K_TOUCH_ARTIFACT_PREV
    artifactNext: 287, // K_TOUCH_ARTIFACT_NEXT
  });
});

test('each touch action rejects a second pointer', () => {
  const root = makeElement(null);
  const attack = makeElement('attack');
  const stick = makeElement('stick');
  const events = [];
  const controls = new PhoneControls(root, { key: (key, down) => events.push([key, down]), look() {} }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(attack, 1, 10, 10));
  root.dispatch('pointerdown', pointer(attack, 2, 10, 10));
  root.dispatch('pointerup', pointer(attack, 1, 10, 10));
  root.dispatch('pointerdown', pointer(stick, 3, 60, 60));
  root.dispatch('pointerdown', pointer(stick, 4, 60, 60));
  root.dispatch('pointermove', pointer(stick, 4, 60, 0));

  assert.deepEqual(events, [
    [KEYS.attack, true],
    [KEYS.attack, false],
  ]);
});

test('releaseAll clears button keys and zeroes the stick vector', () => {
  const root = makeElement(null);
  const stick = makeElement('stick');
  const jump = makeElement('jump');
  const events = [];
  const moves = [];
  const controls = new PhoneControls(root, {
    key: (key, down) => events.push([key, down]),
    look() {},
    move: (x, y) => moves.push([x, y]),
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  root.dispatch('pointermove', pointer(stick, 1, 60, 0));
  root.dispatch('pointerdown', pointer(jump, 2, 0, 0));
  controls.releaseAll();

  assert.deepEqual(moves, [[0, -1], [0, 0]]);
  assert.deepEqual(events, [
    [KEYS.jump, true],
    [KEYS.jump, false],
  ]);
});

test('phone mode DOM includes playing layout, touch visibility rules, and quit hook', () => {
  const repoRoot = process.cwd();
  const html = readFileSync(join(repoRoot, 'web/index.html'), 'utf8');
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  assert.match(html, /body\[data-engine-state="running"\]/);
  assert.match(html, /id="phone-controls"/);
  assert.match(html, /id="exit-button"/);
  assert.match(html, /id="phone-exit-button"/);
  assert.match(html, /data-touch-only="true"/);
  assert.match(html, /data-phone-mode="true"/);
  assert.match(html, /data-phone-action="jump"[^>]*>ᚢ<\/button>/);
  assert.match(html, /data-phone-action="attack"[^>]*>ᛏ<\/button>/);
  assert.match(html, /data-phone-action="use"[^>]*>ᛈ<\/button>/);
  assert.match(html, /data-phone-action="worldUse"[^>]*>ᚷ<\/button>/);
  assert.match(html, /data-phone-action="crouch"[^>]*data-phone-latch[^>]*><span>ᚾ<\/span><\/button>/);
  assert.match(html, /data-phone-action="prevWeapon"[^>]*>ᛁ<\/button>/);
  assert.match(html, /data-phone-action="nextWeapon"[^>]*>ᛊ<\/button>/);
  assert.match(html, /data-phone-action="swipe"[^>]*data-detent-left="artifactNext"[^>]*data-detent-right="artifactPrev"/);
  assert.match(html, /class="stick-arm n"/);
  assert.match(html, /class="stick-heart"/);
  assert.doesNotMatch(html, /phone-game-control[^>]*data-phone-action="menu"/,
    'the hamburger already sends the engine menu key; no second menu button');
  assert.match(html, /data-phone-action="forward"[^>]*>▲&#xFE0E;<\/button>/);
  assert.match(html, /data-phone-action="left"[^>]*>◀&#xFE0E;<\/button>/);
  assert.match(html, /data-phone-action="right"[^>]*>▶&#xFE0E;<\/button>/);
  assert.match(html, /data-phone-action="back"[^>]*>▼&#xFE0E;<\/button>/);
  assert.match(html, /data-phone-action="menuBack"[^>]*>Back<\/button>/);
  assert.match(html, /data-phone-action="menuSelect"[^>]*>Select<\/button>/);
  assert.match(html, /data-phone-action="menu"[^>]*>Resume<\/button>/);
  assert.match(html, /id="touch-invert-y-setting"/);
  assert.match(html, /id="look-accel-setting"/);
  assert.match(html, /id="stick-response-setting"/);
  assert.match(html, /body\[data-touch-menu="true"\] \.phone-game-control \{ display: none; \}/);
  assert.match(app, /addEventListener\('hexenwailtouchmode'/);
  assert.match(html, /@media \(pointer: coarse\) and \(hover: none\) \{/);
  assert.match(app, /isLikelyTouchOnlyEnvironment/);
  assert.match(app, /isTouchControlsVisible/);
  assert.match(app, /Web_TouchControlsVisible/);
  assert.match(app, /isPhoneModeEnvironment/);
  assert.match(app, /PHONE_VIEWPORT_QUERY/);
  assert.match(app, /gamepadconnected/);
  assert.match(app, /hexenwailquit/);
  assert.match(app, /Web_ResizeCanvas/);
  assert.match(html, /\.phone-gem\.shoulder-prev,[\s\S]*?\.phone-gem\.shoulder-next \{[\s\S]*?width: 4\.6rem;/);
  assert.match(app, /const hadController = Boolean\(navigator\.serviceWorker\.controller\)/);
  assert.match(app, /addEventListener\('pageshow', checkForServiceWorkerUpdate\)/);
  assert.equal([...app.matchAll(/startEngineFromUserAction\(/g)].length, 2,
    'engine startup should only be defined and invoked by the launch-button handler');
});

test('the hamburger sends the engine menu command directly', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const body = app.match(/function togglePhoneMenuButton\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'togglePhoneMenuButton is defined');
  assert.match(body, /releasePhoneInputs\(\);/);
  assert.match(body, /engineKey\(HEXEN_TOUCH_KEYCODES\.menu, true\);/);
  assert.match(body, /engineKey\(HEXEN_TOUCH_KEYCODES\.menu, false\);/);
});

test('touch taps on the hamburger and overlay buttons bypass viewport zoom suppression', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const start = app.indexOf('function suppressBrowserZoom');
  assert.notEqual(start, -1, 'suppressBrowserZoom exists');
  const braceStart = app.indexOf('{', start);
  let depth = 0;
  let end = -1;
  for (let index = braceStart; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  assert.notEqual(end, -1, 'suppressBrowserZoom closes cleanly');
  const functionText = app.slice(start, end + 1);

  class ElementMock {
    closest(selector) {
      return this._closest?.(selector) ?? null;
    }
  }

  const suppressBrowserZoom = vm.runInNewContext(`(${functionText})`, {
    state: { engineStarted: true, runtimeExited: false, immersive: true, phoneMode: false },
    Element: ElementMock,
  });

  const menuButton = new ElementMock();
  menuButton._closest = (selector) => (selector.includes('#phone-menu-button') ? menuButton : null);
  const menuEvent = {
    target: menuButton,
    type: 'touchstart',
    cancelable: true,
    preventDefault() { this.defaultPrevented = true; },
  };
  suppressBrowserZoom(menuEvent);
  assert.equal(menuEvent.defaultPrevented, undefined);

  const gameTarget = new ElementMock();
  gameTarget._closest = (selector) => (selector.includes('.viewport') ? gameTarget : null);
  const gameEvent = {
    target: gameTarget,
    type: 'touchstart',
    cancelable: true,
    preventDefault() { this.defaultPrevented = true; },
  };
  suppressBrowserZoom(gameEvent);
  assert.equal(gameEvent.defaultPrevented, true);
});

test('phone mode keys off the panel short side so iPads are never trapped in it', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const query = app.match(/const PHONE_VIEWPORT_QUERY = '([^']+)'/)?.[1];
  assert.ok(query, 'PHONE_VIEWPORT_QUERY is declared as a string literal');

  const limits = [...query.matchAll(/max-(?:width|height): (\d+)px/g)].map((match) => Number(match[1]));
  assert.equal(limits.length, 2, 'both orientations are covered');
  for (const limit of limits) {
    // Phone short side <= ~450 CSS px; smallest iPad short side ~740 CSS px.
    assert.ok(limit >= 450 && limit < 700, `phone short-side limit ${limit} must exclude iPads`);
  }
  assert.doesNotMatch(query, /pointer|hover/,
    'phone mode is a panel-size question; an attached mouse does not make a phone panel bigger');
});

test('phone mode drives the immersive layout consistently in all three places', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const html = readFileSync(join(repoRoot, 'web/index.html'), 'utf8');
  // Forcing immersive, hiding Show launcher, and keeping immersive on
  // fullscreen exit must share one condition, or the button becomes a no-op.
  assert.match(app, /document\.body\.dataset\.immersive = \(state\.immersive \|\| state\.phoneMode\)/);
  assert.match(app, /\} else if \(!state\.phoneMode\) \{/);
  assert.match(html, /body\[data-phone-mode="true"\] #windowed-button \{ display: none; \}/);
});

test('coarse pointer changes are subscribed to now that phone mode ignores them', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const queries = app.match(/for \(const query of \[([\s\S]*?)\]\) \{/)?.[1];
  assert.ok(queries, 'the watched media query list is defined');
  assert.match(queries, /'\(any-pointer: coarse\)'/);
  assert.match(queries, /'\(any-pointer: fine\)'/);
  assert.match(queries, /'\(any-hover: hover\)'/);
});

test('canvas resizes coalesce so a burst of transitions schedules one pass', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const body = app.match(/function scheduleCanvasResize\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'scheduleCanvasResize is defined');
  assert.match(body, /if \(state\.canvasResizePending\) return;/,
    'each caller must not queue its own rAF chain into the engine');
  assert.match(body, /state\.canvasResizePending = true;/);
  assert.match(body, /state\.canvasResizePending = false;/);
});

test('touch-control auto detection depends on pointer capability, not viewport size', () => {
  const repoRoot = process.cwd();
  const app = readFileSync(join(repoRoot, 'web/app.js'), 'utf8');
  const body = app.match(/function isLikelyTouchOnlyEnvironment\(\) \{([\s\S]*?)\n\}/)?.[1];
  assert.ok(body, 'isLikelyTouchOnlyEnvironment is defined');
  assert.doesNotMatch(body, /isPhoneModeEnvironment|PHONE_VIEWPORT_QUERY/,
    'a bare iPad is as touch-only as a phone, so screen size must not gate touch controls');
  assert.match(body, /any-pointer: coarse/);
  assert.match(body, /hasConnectedGamepad\(\)/);
});

/* ——— THE PANE: tap-to-fire, rim slew, detents, and latchable holds ——— */

function stubRaf() {
  const queue = [];
  const prevRaf = globalThis.requestAnimationFrame;
  const prevCancel = globalThis.cancelAnimationFrame;
  globalThis.requestAnimationFrame = (cb) => { queue.push(cb); return queue.length; };
  globalThis.cancelAnimationFrame = (id) => { queue.splice(id - 1, 1); };
  return {
    run(now) { for (const cb of queue.splice(0)) cb(now); },
    restore() {
      if (prevRaf === undefined) delete globalThis.requestAnimationFrame;
      else globalThis.requestAnimationFrame = prevRaf;
      if (prevCancel === undefined) delete globalThis.cancelAnimationFrame;
      else globalThis.cancelAnimationFrame = prevCancel;
    },
  };
}

function latchElement(action = 'crouch') {
  const el = makeElement(action);
  el.dataset.phoneLatch = '';
  const classes = new Set();
  el.classList = {
    add: (c) => classes.add(c),
    remove: (c) => classes.delete(c),
    toggle: (c, force) => {
      if (force === undefined) { if (classes.has(c)) classes.delete(c); else classes.add(c); }
      else if (force) classes.add(c);
      else classes.delete(c);
    },
  };
  el.hasClass = (c) => classes.has(c);
  return el;
}

function swipeElement() {
  const el = makeElement('swipe');
  el.dataset.detentLeft = 'artifactNext';
  el.dataset.detentRight = 'artifactPrev';
  return el;
}

test('a quick unmoved look tap fires the attack key without turning the camera', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const keys = [];
  const looks = [];
  const controls = new PhoneControls(root, {
    key: (k, d) => keys.push([k, d]),
    look: (dx, dy) => looks.push([dx, dy]),
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', tpointer(look, 1, 50, 50, 1000));
  root.dispatch('pointerup', tpointer(look, 1, 50, 50, 1100));

  assert.deepEqual(looks, [], 'no drag deltas on an unmoved tap');
  assert.deepEqual(keys, [[KEYS.attack, true], [KEYS.attack, false]]);
});

test('a look tap is ignored when the thumb moves or lingers', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} }, { keys: KEYS });
  controls.attach();

  // moved past the tap slop: a drag, not a tap
  root.dispatch('pointerdown', tpointer(look, 1, 50, 50, 1000));
  root.dispatch('pointermove', tpointer(look, 1, 80, 50, 1016));
  root.dispatch('pointerup', tpointer(look, 1, 80, 50, 1100));
  // unmoved but held past the tap window: a press, not a tap
  root.dispatch('pointerdown', tpointer(look, 2, 50, 50, 2000));
  root.dispatch('pointerup', tpointer(look, 2, 50, 50, 2600));

  assert.deepEqual(keys, []);
});

test('the look surface slews continuously past the rim and stops on release', () => {
  const raf = stubRaf();
  try {
    const root = makeElement(null);
    const look = makeElement('look');
    const looks = [];
    const controls = new PhoneControls(root, {
      key() {},
      look: (dx, dy) => looks.push([dx, dy]),
    }, { keys: KEYS, lookAccel: 0, lookSensitivity: 1, lookRim: 0.65, lookRimRate: 1000, lookRadius: 120 });
    controls.attach();

    root.dispatch('pointerdown', tpointer(look, 1, 0, 0, 1000));
    // park the thumb 100px right of touch-down: 0.83 deflection, past the 0.65 rim
    root.dispatch('pointermove', tpointer(look, 1, 100, 0, 1016));
    assert.ok(looks.length >= 1, 'the drag itself still turns the camera');
    const before = looks.length;
    raf.run(1032);
    assert.ok(looks.length > before, 'the parked thumb slews on its own');
    const [slewX] = looks[looks.length - 1];
    assert.ok(slewX > 0, 'the slew follows the parked deflection');

    root.dispatch('pointerup', tpointer(look, 1, 100, 0, 1100));
    const afterUp = looks.length;
    raf.run(1116);
    assert.equal(looks.length, afterUp, 'lifting the thumb stops the slew');
  } finally {
    raf.restore();
  }
});

test('the artifact strip fires one key tap per crossed detent', () => {
  const root = makeElement(null);
  const strip = swipeElement();
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} },
    { keys: KEYS, detentStepPx: 48 });
  controls.attach();

  // 100px left crosses two 48px detents
  root.dispatch('pointerdown', pointer(strip, 1, 200, 10));
  root.dispatch('pointermove', pointer(strip, 1, 100, 10));
  assert.deepEqual(keys, [
    [KEYS.artifactNext, true], [KEYS.artifactNext, false],
    [KEYS.artifactNext, true], [KEYS.artifactNext, false],
  ]);

  // right crosses back toward previous
  root.dispatch('pointermove', pointer(strip, 1, 148, 10));
  assert.deepEqual(keys.at(-2), [KEYS.artifactPrev, true]);
  assert.deepEqual(keys.at(-1), [KEYS.artifactPrev, false]);

  root.dispatch('pointerup', pointer(strip, 1, 148, 10));
});

test('the artifact strip ignores taps and vertical-dominant drags', () => {
  const root = makeElement(null);
  const strip = swipeElement();
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} },
    { keys: KEYS, detentStepPx: 48 });
  controls.attach();

  root.dispatch('pointerdown', pointer(strip, 1, 200, 10));
  root.dispatch('pointerup', pointer(strip, 1, 200, 10));

  root.dispatch('pointerdown', pointer(strip, 2, 200, 10));
  root.dispatch('pointermove', pointer(strip, 2, 200, 150));
  root.dispatch('pointerup', pointer(strip, 2, 200, 150));

  assert.deepEqual(keys, []);
});

test('a crouch tap toggles a virtual hold; a second tap stands it up', async () => {
  const root = makeElement(null);
  const crouch = latchElement();
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} },
    { keys: KEYS, latchHoldMs: 40, latchGraceMs: 20 });
  controls.attach();

  root.dispatch('pointerdown', pointer(crouch, 1, 0, 0));
  await new Promise((r) => setTimeout(r, 10));
  root.dispatch('pointerup', pointer(crouch, 1, 0, 0));
  assert.deepEqual(keys, [[KEYS.crouch, true]]);
  assert.ok(crouch.hasClass('latched'), 'the gem shows its latched state');

  root.dispatch('pointerdown', pointer(crouch, 2, 0, 0));
  await new Promise((r) => setTimeout(r, 10));
  root.dispatch('pointerup', pointer(crouch, 2, 0, 0));
  assert.deepEqual(keys, [[KEYS.crouch, true], [KEYS.crouch, false]]);
  assert.ok(!crouch.hasClass('latched'));
  controls.detach();
});

test('a crouch hold past the threshold ducks physically, with release grace', async () => {
  const root = makeElement(null);
  const crouch = latchElement();
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} },
    { keys: KEYS, latchHoldMs: 40, latchGraceMs: 30 });
  controls.attach();

  root.dispatch('pointerdown', pointer(crouch, 1, 0, 0));
  await new Promise((r) => setTimeout(r, 60)); // past the 40ms threshold
  assert.deepEqual(keys, [[KEYS.crouch, true]]);
  assert.ok(crouch.hasClass('held'));
  assert.ok(!crouch.hasClass('latched'), 'a hold is physical, not a toggle');

  root.dispatch('pointerup', pointer(crouch, 1, 0, 0));
  await new Promise((r) => setTimeout(r, 10)); // still inside the 30ms grace
  assert.deepEqual(keys, [[KEYS.crouch, true]], 'the key rides out the grace');
  await new Promise((r) => setTimeout(r, 30)); // grace elapses
  assert.deepEqual(keys, [[KEYS.crouch, true], [KEYS.crouch, false]]);
  assert.ok(!crouch.hasClass('held'));
  controls.detach();
});

test('a hold on a latched crouch keeps the latch standing after the grace', async () => {
  const root = makeElement(null);
  const crouch = latchElement();
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} },
    { keys: KEYS, latchHoldMs: 40, latchGraceMs: 30 });
  controls.attach();

  root.dispatch('pointerdown', pointer(crouch, 1, 0, 0));
  await new Promise((r) => setTimeout(r, 10));
  root.dispatch('pointerup', pointer(crouch, 1, 0, 0));
  assert.deepEqual(keys, [[KEYS.crouch, true]], 'tap latches');

  root.dispatch('pointerdown', pointer(crouch, 2, 0, 0));
  await new Promise((r) => setTimeout(r, 60)); // the hold timer claims it physically
  assert.deepEqual(keys, [[KEYS.crouch, true]], 'the key press is idempotent');
  root.dispatch('pointerup', pointer(crouch, 2, 0, 0));
  await new Promise((r) => setTimeout(r, 40)); // grace elapses
  assert.deepEqual(keys, [[KEYS.crouch, true]], 'the latch keeps the key down');
  assert.ok(crouch.hasClass('latched'));
  controls.detach();
});

test('releaseAll stands every latch back up and clears pending grace', () => {
  const root = makeElement(null);
  const crouch = latchElement();
  const keys = [];
  const controls = new PhoneControls(root, { key: (k, d) => keys.push([k, d]), look() {} },
    { keys: KEYS, latchHoldMs: 40, latchGraceMs: 20 });
  controls.attach();

  root.dispatch('pointerdown', pointer(crouch, 1, 0, 0));
  root.dispatch('pointerup', pointer(crouch, 1, 0, 0));
  assert.deepEqual(keys, [[KEYS.crouch, true]]);

  controls.releaseAll();
  assert.deepEqual(keys, [[KEYS.crouch, true], [KEYS.crouch, false]]);
  assert.ok(!crouch.hasClass('latched'));
});

test('button press wakes the glass and dips; release puts it back to sleep', () => {
  const root = makeElement(null);
  const attack = makeElement('attack');
  const keyEvents = [];
  const controls = new PhoneControls(root, {
    key: (key, down) => keyEvents.push([key, down]),
    look() {},
    move() {},
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(attack, 1, 60, 60));
  assert.ok(attack.classList.contains('lit'), 'gem wakes while touched');
  assert.ok(attack.classList.contains('dip'), 'gem dips under the finger');
  assert.deepEqual(keyEvents, [[KEYS.attack, true]]);

  root.dispatch('pointerup', pointer(attack, 1, 60, 60));
  assert.ok(!attack.classList.contains('lit'), 'gem sleeps on release');
  assert.ok(!attack.classList.contains('dip'), 'dip lifts on release');
  assert.deepEqual(keyEvents, [[KEYS.attack, true], [KEYS.attack, false]]);
});

test('stick wakes the cross and lights the arm in the push direction', () => {
  const armN = makeElement(null);
  const armS = makeElement(null);
  const armE = makeElement(null);
  const armW = makeElement(null);
  const root = makeElement(null);
  const stick = makeElement('stick', { left: 0, top: 0, width: 120, height: 120 }, {
    '.stick-arm.n': armN,
    '.stick-arm.s': armS,
    '.stick-arm.e': armE,
    '.stick-arm.w': armW,
  });
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  assert.ok(stick.classList.contains('lit'), 'cross wakes on touch');
  assert.ok(!armN.classList.contains('lit'), 'no arm lit at rest');

  // Push north: the north arm lights, the others stay dark.
  root.dispatch('pointermove', pointer(stick, 1, 60, 0));
  assert.ok(armN.classList.contains('lit'), 'north arm lights on a north push');
  assert.ok(!armS.classList.contains('lit') && !armE.classList.contains('lit') && !armW.classList.contains('lit'));

  // Swing east: the light follows.
  root.dispatch('pointermove', pointer(stick, 1, 120, 60));
  assert.ok(armE.classList.contains('lit'), 'east arm lights on an east push');
  assert.ok(!armN.classList.contains('lit'), 'north arm goes dark');

  root.dispatch('pointerup', pointer(stick, 1, 120, 60));
  assert.ok(!stick.classList.contains('lit'), 'cross sleeps on release');
  assert.ok(!armE.classList.contains('lit'), 'arms go dark on release');
});

test('look grows a breathing glow that drifts with the thumb and dies on release', () => {
  const thumbPos = makeElement(null);
  const breath = makeElement(null, { left: 0, top: 0, width: 800, height: 400 }, {
    '.breath-thumb-pos': thumbPos,
  });
  const root = makeElement(null, { left: 0, top: 0, width: 800, height: 400 }, {
    '[data-phone-breath]': breath,
  });
  const look = makeElement('look', { left: 0, top: 0, width: 800, height: 400 });
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(look, 1, 400, 200));
  assert.ok(look.classList.contains('lit'), 'look layer wakes');
  assert.ok(breath.classList.contains('on'), 'breath appears where the thumb lands');
  assert.equal(breath.style.transform, 'translate(400.0px, 200.0px)');

  // A fast drag: the thumb-glow drifts with the finger and the ambient
  // light answers the speed.
  const down = pointer(look, 1, 400, 200);
  down.timeStamp = 1000;
  const drag = pointer(look, 1, 500, 260);
  drag.timeStamp = 1016;
  root.dispatch('pointermove', drag);
  assert.equal(thumbPos.style.transform, 'translate(80.0px, 60.0px)');
  const b = Number(breath.style.get('--b'));
  assert.ok(b > 0 && b <= 1, 'ambient light answers the speed');

  root.dispatch('pointerup', pointer(look, 1, 500, 260));
  assert.ok(!look.classList.contains('lit'), 'look layer sleeps');
  assert.ok(!breath.classList.contains('on'), 'breath fades on release');
});

test('releaseAll puts every woken control back to sleep', () => {
  const root = makeElement(null);
  const attack = makeElement('attack');
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS });
  controls.attach();

  root.dispatch('pointerdown', pointer(attack, 1, 60, 60));
  assert.ok(attack.classList.contains('lit'));
  controls.releaseAll();
  assert.ok(!attack.classList.contains('lit'), 'lit cleared');
  assert.ok(!attack.classList.contains('dip'), 'dip cleared');
});

/* ——— transient flourishes: the particle effects ——— */

function fxControls(extra = {}) {
  const root = makeElement(null);
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS, ...extra });
  controls.attach();
  return { root, controls };
}

function fxKinds(controls) {
  return (controls.fxLayer?.childNodes ?? []).map((c) => c.className);
}

test('attach raises a flourish stage for transient particles', () => {
  const { controls } = fxControls();
  assert.ok(controls.fxLayer, 'fx layer exists');
  assert.equal(controls.fxLayer.className, 'phone-fx-layer');
  assert.equal(controls.fxReduced, false);
});

test('attack throws bright shards toward the game and sheds diamonds', () => {
  const { root, controls } = fxControls();
  const attack = makeElement('attack');
  root.dispatch('pointerdown', pointer(attack, 1, 60, 60));
  const kinds = fxKinds(controls);
  assert.equal(kinds.filter((k) => k === 'fx fx-surge').length, 3, 'three shards');
  assert.equal(kinds.filter((k) => k === 'fx drip').length, 2, 'two diamond drips');
});

test('jump rises on soft motes; world-use answers with a ripple', () => {
  const { root, controls } = fxControls();
  const jump = makeElement('jump');
  const worldUse = makeElement('worldUse');
  root.dispatch('pointerdown', pointer(jump, 1, 60, 60));
  root.dispatch('pointerup', pointer(jump, 1, 60, 60));
  let kinds = fxKinds(controls);
  assert.equal(kinds.filter((k) => k === 'fx fx-mote').length, 4, 'four rising motes');
  controls.clearFx();
  root.dispatch('pointerdown', pointer(worldUse, 2, 60, 60));
  kinds = fxKinds(controls);
  assert.equal(kinds.filter((k) => k === 'fx fx-ring').length, 2, 'two ripple rings');
  assert.equal(kinds.filter((k) => k === 'fx drip').length, 2, 'two diamond drips');
});

test('weapon change throws a blade of light between the shoulders', () => {
  const prev = makeElement('prevWeapon', { left: 0, top: 0, width: 40, height: 40 });
  const next = makeElement('nextWeapon', { left: 100, top: 0, width: 40, height: 40 });
  const root = makeElement(null, undefined, {
    '[data-phone-action="prevWeapon"]': prev,
    '[data-phone-action="nextWeapon"]': next,
  });
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS });
  controls.attach();
  root.dispatch('pointerdown', pointer(next, 1, 120, 20));
  const kinds = fxKinds(controls);
  assert.equal(kinds.filter((k) => k === 'fx fx-swoop').length, 1, 'one blade of light');
});

test('pushing the cross kindles sparks off the trace', () => {
  const { root, controls } = fxControls();
  const stick = makeElement('stick');
  root.dispatch('pointerdown', pointer(stick, 1, 60, 60));
  root.dispatch('pointermove', pointer(stick, 1, 60, 0));
  const kinds = fxKinds(controls);
  assert.ok(kinds.some((k) => k === 'fx fx-spark'), 'a spark kindles while pushing');
});

test('the look surface pours espresso at the rim extremes', () => {
  const { root, controls } = fxControls();
  const look = makeElement('look');
  root.dispatch('pointerdown', pointer(look, 1, 400, 200));
  root.dispatch('pointermove', pointer(look, 1, 520, 200));
  const kinds = fxKinds(controls);
  assert.ok(kinds.some((k) => k === 'fx fx-streak'), 'a streak tears outward past the rim');
});

test('the breath burns brighter at the rim', () => {
  const root = makeElement(null);
  const look = makeElement('look');
  const breath = makeElement(null);
  breath.classList.add('on');
  const controls = new PhoneControls(root, {
    key() {},
    look() {},
    move() {},
  }, { keys: KEYS });
  controls.attach();
  controls.breath = breath;
  root.dispatch('pointerdown', pointer(look, 1, 400, 200));
  root.dispatch('pointermove', pointer(look, 1, 520, 200));
  const b = Number(breath.style.get('--b'));
  assert.ok(b >= 0.5, `rim excess doubles the pour: --b=${b}`);
});

test('releaseAll sweeps the flourish stage clean', () => {
  const { root, controls } = fxControls();
  const attack = makeElement('attack');
  root.dispatch('pointerdown', pointer(attack, 1, 60, 60));
  assert.ok(fxKinds(controls).length > 0, 'flourishes were spawned');
  controls.releaseAll();
  assert.equal(fxKinds(controls).length, 0, 'stage swept');
});

test('reduced motion keeps the flourish stage dark', () => {
  const prevMatchMedia = globalThis.matchMedia;
  globalThis.matchMedia = () => ({ matches: true });
  try {
    const { root, controls } = fxControls();
    assert.equal(controls.fxReduced, true);
    const attack = makeElement('attack');
    root.dispatch('pointerdown', pointer(attack, 1, 60, 60));
    assert.equal(fxKinds(controls).length, 0, 'no particles under reduced motion');
  } finally {
    if (prevMatchMedia === undefined) delete globalThis.matchMedia;
    else globalThis.matchMedia = prevMatchMedia;
  }
});

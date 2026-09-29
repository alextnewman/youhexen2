/*
 * Virtual-console touch surface.
 *
 * Engine-agnostic input toolbox for the "virtual web console": a touch
 * overlay that speaks an abstract bridge protocol, so the same surface
 * drives any engine behind a thin per-engine adapter. It knows actions,
 * never keycodes — the host supplies the action→keycode map.
 *
 * Bridge protocol (all calls are best-effort; the bridge guards engine
 * readiness itself):
 *   bridge.key(keycode, down)  digital button press/release
 *   bridge.look(dx, dy)        drag-look deltas, already sensitivity-scaled
 *   bridge.move(x, y)          analog stick vector, -1..1 per axis,
 *                              y positive = pull toward the player (back)
 *
 * Actions: 'stick' and 'look' are the two analog zones; 'swipe' is a
 * horizontal detent zone (its prev/next actions come from data-detent-*
 * attributes); everything in BUTTON_ACTIONS is a digital button resolved
 * through options.keys. A button carrying data-phone-latch becomes a
 * latchable hold: tap toggles a virtual hold, press-and-hold past
 * latchHoldMs holds physically, release gets latchGraceMs.
 */

export const DEFAULT_PHONE_CONTROL_OPTIONS = Object.freeze({
  stickDeadZone: 0.18,
  /* Stick response curve: the deadzone-rescaled magnitude is raised to
   * this power. 1 = linear; higher values stretch the walk zone so a
   * casual thumb placement walks and only a deliberate shove to the
   * edge punches it to full run. 1 = the old hyperspace toggle. */
  stickResponse: 1.7,
  lookSensitivity: 1,
  /* Drag-look acceleration: slow drags stay ~1:1 for fine aim, fast
   * flicks get boosted for gross turns in one gesture. 0 = linear. */
  lookAccel: 0.8,
  lookAccelPower: 1.3,
  maxLookDelta: 512,
  haptics: true,
  hapticDurationMs: 8,
  /* Tap the look surface — quick and unmoved — to fire without the thumb
   * ever leaving the glass. lookTapAction names a BUTTON_ACTION resolved
   * through keys; falsy disables. */
  lookTapAction: 'attack',
  lookTapMaxMs: 350,
  lookTapMaxPx: 12,
  /* Past the rim the look surface is a joystick, not a cursor: deflection
   * from the touch-down anchor becomes continuous angular velocity, so the
   * view keeps slewing while the thumb rests at the edge. lookRim is the
   * deflection fraction of lookRadius where the slew starts; lookRimRate
   * is bridge-look units per second at full past-rim deflection, scaled by
   * lookSensitivity. Drag deltas keep flowing underneath for fine work. */
  lookRadius: 120,
  lookRim: 0.65,
  lookRimRate: 1100,
  /* A detent swipe zone (the artifact strip): every detentStepPx of
   * horizontal travel fires the named action's key once. Swipe left fires
   * data-detent-left, swipe right fires data-detent-right; a
   * vertical-dominant drag is not a scroll. */
  detentStepPx: 48,
  /* A latchable button (crouch): a quick tap toggles a virtual hold, a
   * press held past latchHoldMs crouches physically, and release gets
   * latchGraceMs so touch jitter never stands you up. */
  latchHoldMs: 500,
  latchGraceMs: 80,
  keys: Object.freeze({}),
});

const BUTTON_ACTIONS = new Set([
  'forward', 'back', 'left', 'right',
  'attack', 'jump', 'use', 'worldUse', 'crouch',
  'menu', 'menuBack', 'menuSelect',
  'nextWeapon', 'prevWeapon',
  'artifactPrev', 'artifactNext',
]);

const MOVE_EPSILON = 1e-3;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function eventPoint(event) {
  return { x: event.clientX ?? 0, y: event.clientY ?? 0 };
}

function actionForTarget(target) {
  return target?.closest?.('[data-phone-action]')?.dataset?.phoneAction ?? target?.dataset?.phoneAction ?? null;
}

function elementForTarget(target) {
  return target?.closest?.('[data-phone-action]') ?? null;
}

/* rAF indirection: the rim-slew loop degrades gracefully where there is no
 * frame scheduler (and stays drivable in tests). */
function nextFrame(callback) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return 0;
}

function cancelFrame(id) {
  if (id && typeof globalThis.cancelAnimationFrame === 'function') {
    globalThis.cancelAnimationFrame(id);
  }
}

function rectCenter(element, fallback) {
  const rect = element?.getBoundingClientRect?.();
  if (!rect || (!rect.width && !rect.height)) {
    return fallback;
  }
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function buzz(enabled, durationMs) {
  if (!enabled) return;
  try {
    globalThis.navigator?.vibrate?.(durationMs);
  } catch {
    /* Best-effort: iOS Safari exposes no vibration API at all. */
  }
}

export class PhoneControls {
  constructor(root, bridge, options = {}) {
    this.root = root;
    this.bridge = bridge;
    this.options = { ...DEFAULT_PHONE_CONTROL_OPTIONS, ...options };
    this.keys = { ...(options.keys ?? {}) };
    this.enabled = false;
    this.pointerOwners = new Map();
    this.heldKeys = new Set();
    this.stickCenter = null;
    this.lastLookPoint = null;
    this.lastLookTime = null;
    this.lookSpeed = null;
    this.moveVector = { x: 0, y: 0 };
    /* Latchable holds: action -> { latched, key, element }. The toggle
     * outlives any one pointer; releaseAll stands everything back up. */
    this.latches = new Map();
    /* Pending physical-hold release grace: action -> { timer, key, element }. */
    this.latchGrace = new Map();
    /* Rim-slew loop handle while a look pointer rests past the rim. */
    this.rimRaf = 0;
    /* The look surface's breathing glow, when the host provides one:
     * purely visual, never touches the engine. */
    this.breath = null;
    this.breathThumb = null;

    this.bound = {
      pointerdown: (event) => this.onPointerDown(event),
      pointermove: (event) => this.onPointerMove(event),
      pointerup: (event) => this.onPointerEnd(event),
      pointercancel: (event) => this.onPointerEnd(event),
      lostpointercapture: (event) => this.onPointerEnd(event),
    };
  }

  attach() {
    if (!this.root) return;
    this.enabled = true;
    this.breath = this.root.querySelector?.('[data-phone-breath]') ?? null;
    this.breathThumb = this.breath?.querySelector?.('.breath-thumb-pos') ?? null;
    this.root.addEventListener('pointerdown', this.bound.pointerdown);
    this.root.addEventListener('pointermove', this.bound.pointermove);
    this.root.addEventListener('pointerup', this.bound.pointerup);
    this.root.addEventListener('pointercancel', this.bound.pointercancel);
    this.root.addEventListener('lostpointercapture', this.bound.lostpointercapture);
  }

  detach() {
    if (!this.root) return;
    this.releaseAll();
    this.enabled = false;
    this.root.removeEventListener('pointerdown', this.bound.pointerdown);
    this.root.removeEventListener('pointermove', this.bound.pointermove);
    this.root.removeEventListener('pointerup', this.bound.pointerup);
    this.root.removeEventListener('pointercancel', this.bound.pointercancel);
    this.root.removeEventListener('lostpointercapture', this.bound.lostpointercapture);
  }

  setLookSensitivity(value) {
    const parsed = Number(value);
    this.options.lookSensitivity = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_PHONE_CONTROL_OPTIONS.lookSensitivity;
  }

  setLookAccel(value) {
    const parsed = Number(value);
    this.options.lookAccel = Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_PHONE_CONTROL_OPTIONS.lookAccel;
  }

  setStickResponse(value) {
    const parsed = Number(value);
    this.options.stickResponse = Number.isFinite(parsed) && parsed >= 1 ? parsed : DEFAULT_PHONE_CONTROL_OPTIONS.stickResponse;
  }

  onPointerDown(event) {
    if (!this.enabled || !this.root) return;
    const element = elementForTarget(event.target);
    const action = element?.dataset?.phoneAction ?? event.target?.dataset?.phoneAction ?? null;
    if (!action) return;
    if ([...this.pointerOwners.values()].some((owner) => owner.action === action)) return;

    event.preventDefault?.();
    event.stopPropagation?.();
    event.target?.setPointerCapture?.(event.pointerId);

    if (action === 'stick') {
      const armEls = {};
      for (const dir of ['n', 's', 'e', 'w']) {
        armEls[dir] = element?.querySelector?.(`.stick-arm.${dir}`) ?? null;
      }
      const stickOwner = { type: 'stick', action, element, armEls };
      this.pointerOwners.set(event.pointerId, stickOwner);
      /* The cross wakes where touched. */
      element?.classList?.add('lit');
      this.stickCenter = rectCenter(event.target, eventPoint(event));
      this.updateStick(event);
      this.lightStickArms(stickOwner);
      return;
    }

    if (action === 'look') {
      const point = eventPoint(event);
      this.pointerOwners.set(event.pointerId, {
        type: 'look',
        action,
        element,
        anchor: point,
        downX: point.x,
        downY: point.y,
        downT: typeof event.timeStamp === 'number' ? event.timeStamp : null,
        moved: false,
        rimActive: false,
        rimDX: 0,
        rimDY: 0,
      });
      this.lastLookPoint = point;
      this.lastLookTime = typeof event.timeStamp === 'number' ? event.timeStamp : null;
      this.lookSpeed = 0;
      /* The look surface wakes where the thumb lands, breathing. */
      element?.classList?.add('lit');
      this.showBreath(element, point);
      return;
    }

    if (action === 'swipe') {
      const point = eventPoint(event);
      this.pointerOwners.set(event.pointerId, {
        type: 'swipe',
        action,
        startX: point.x,
        startY: point.y,
        lastStep: 0,
        leftAction: element?.dataset?.detentLeft ?? null,
        rightAction: element?.dataset?.detentRight ?? null,
      });
      return;
    }

    if (BUTTON_ACTIONS.has(action)) {
      const key = this.keys[action];
      /* A latchable button (crouch): the key stays down while latched or
       * physically held. A tap toggles the virtual hold; a press held past
       * latchHoldMs holds physically; release gets latchGraceMs. */
      if (element?.dataset?.phoneLatch !== undefined) {
        this.cancelLatchGrace(action);
        let entry = this.latches.get(action);
        if (!entry) {
          entry = { latched: false, key, element };
          this.latches.set(action, entry);
        } else {
          entry.key = key;
          entry.element = element;
        }
        const owner = { type: 'latch', action, key, element, held: false, holdTimer: 0 };
        this.pointerOwners.set(event.pointerId, owner);
        /* Glass wakes where touched; the dip is the push-back. */
        element?.classList?.add('lit', 'dip');
        owner.holdTimer = setTimeout(() => {
          if (this.pointerOwners.get(event.pointerId) !== owner) return;
          owner.held = true;
          owner.holdTimer = 0;
          if (owner.key) this.pressKey(owner.key);
          owner.element?.classList?.add('held');
          buzz(this.options.haptics, 8);
        }, this.options.latchHoldMs);
        return;
      }
      this.pointerOwners.set(event.pointerId, { type: 'button', action, key, element });
      element?.classList?.add('lit', 'dip');
      if (key) {
        this.pressKey(key);
        buzz(this.options.haptics, this.options.hapticDurationMs);
      }
    }
  }

  onPointerMove(event) {
    const owner = this.pointerOwners.get(event.pointerId);
    if (!owner) return;
    event.preventDefault?.();
    event.stopPropagation?.();

    if (owner.type === 'stick') {
      this.updateStick(event);
      this.lightStickArms(owner);
      return;
    }
    if (owner.type === 'swipe') {
      const point = eventPoint(event);
      const dx = point.x - owner.startX;
      const dy = point.y - owner.startY;
      /* A vertical-dominant drag is not a scroll. */
      if (Math.abs(dy) > Math.abs(dx) * 1.2) return;
      const step = Math.trunc(dx / this.options.detentStepPx);
      if (step !== owner.lastStep) {
        const dir = Math.sign(step - owner.lastStep);
        const actionName = dir < 0 ? owner.leftAction : owner.rightAction;
        const key = actionName ? this.keys[actionName] : undefined;
        /* Fire once per crossed detent so a fling never swallows ticks. */
        const ticks = Math.abs(step - owner.lastStep);
        for (let i = 0; i < ticks; i += 1) {
          if (key) {
            this.pressKey(key);
            this.releaseKey(key);
          }
        }
        if (key) buzz(this.options.haptics, 5);
        owner.lastStep = step;
      }
      return;
    }
    if (owner.type === 'look') {
      const point = eventPoint(event);
      if (this.lastLookPoint) {
        /* The clamp is a garbage-event guard, not a speed limit: fast
         * flicks must survive, or turning feels like dragging through
         * mud. On top of it sits a velocity-adaptive gain: slow drags
         * stay ~1:1 so they aim precisely (the gyro's partner for fine
         * work), while fast flicks get boosted for gross turns in a
         * single gesture. lookAccel 0 restores linear drag. */
        const scale = this.options.lookSensitivity;
        let dx = clamp(point.x - this.lastLookPoint.x, -this.options.maxLookDelta, this.options.maxLookDelta);
        let dy = clamp(point.y - this.lastLookPoint.y, -this.options.maxLookDelta, this.options.maxLookDelta);
        const accel = this.options.lookAccel;
        if (accel > 0 && typeof event.timeStamp === 'number') {
          const last = typeof this.lastLookTime === 'number' ? this.lastLookTime : event.timeStamp;
          const dt = Math.max(1, event.timeStamp - last);
          /* Gain rides the *previous* smoothed speed, then the EMA
           * absorbs this event's raw (pre-gain) speed: the first move
           * of a drag is always linear, so touchdown never punches the
           * camera, and the boost never feeds back into itself. */
          const speed = this.lookSpeed ?? 0;
          const gain = 1 + accel * Math.pow(speed, this.options.lookAccelPower);
          const instant = Math.hypot(dx, dy) / dt;
          this.lookSpeed = speed + (instant - speed) * 0.35;
          dx *= gain;
          dy *= gain;
          this.lastLookTime = event.timeStamp;
        }
        dx *= scale;
        dy *= scale;
        if (dx || dy) this.bridge.look(dx, dy);
      }
      this.lastLookPoint = point;
      /* Tap-to-fire watches for an unmoved touch; the rim watches for a
       * thumb parked past it. Both read the touch-down anchor. */
      if (Math.hypot(point.x - owner.downX, point.y - owner.downY) > this.options.lookTapMaxPx) {
        owner.moved = true;
      }
      const rim = this.options.lookRim;
      const rx = (point.x - owner.anchor.x) / this.options.lookRadius;
      const ry = (point.y - owner.anchor.y) / this.options.lookRadius;
      const mag = Math.hypot(rx, ry);
      if (mag > rim && rim < 1) {
        const excess = Math.min(1, (mag - rim) / (1 - rim));
        owner.rimDX = (rx / mag) * excess;
        owner.rimDY = (ry / mag) * excess;
        owner.rimActive = true;
        this.ensureRimLoop();
      } else if (owner.rimActive) {
        owner.rimActive = false;
        owner.rimDX = 0;
        owner.rimDY = 0;
        this.stopRimLoop();
      }
      this.moveBreath(owner, point);
    }
  }

  /* The cross lights the arm in the push direction. Purely visual. */
  lightStickArms(owner) {
    const armEls = owner?.armEls;
    if (!armEls) return;
    const { x, y } = this.moveVector;
    let dir = '';
    if (Math.hypot(x, y) > 0.25) {
      dir = Math.abs(x) > Math.abs(y) ? (x > 0 ? 'e' : 'w') : (y > 0 ? 's' : 'n');
    }
    for (const [d, el] of Object.entries(armEls)) {
      el?.classList?.toggle('lit', d === dir);
    }
  }

  /* The look surface breathes where the thumb lands: the glow appears at
   * the touch-down anchor and drifts with the finger, while the ambient
   * light answers the speed. Purely visual, never touches the engine. */
  showBreath(element, point) {
    if (!this.breath) return;
    const rect = element?.getBoundingClientRect?.();
    const x = rect ? point.x - rect.left : point.x;
    const y = rect ? point.y - rect.top : point.y;
    this.breath.style.transform = `translate(${x.toFixed(1)}px, ${y.toFixed(1)}px)`;
    this.breath.style.setProperty('--b', '0');
    if (this.breathThumb) this.breathThumb.style.transform = 'translate(0px, 0px)';
    this.breath.classList.add('on');
  }

  moveBreath(owner, point) {
    if (!this.breath || !this.breath.classList.contains('on')) return;
    const dx = clamp(point.x - owner.anchor.x, -80, 80);
    const dy = clamp(point.y - owner.anchor.y, -80, 80);
    if (this.breathThumb) {
      this.breathThumb.style.transform = `translate(${dx.toFixed(1)}px, ${dy.toFixed(1)}px)`;
    }
    this.breath.style.setProperty('--b', Math.min(1, (this.lookSpeed || 0) * 0.12).toFixed(2));
  }

  hideBreath() {
    this.breath?.classList?.remove('on');
  }

  onPointerEnd(event) {
    const owner = this.pointerOwners.get(event.pointerId);
    if (!owner) return;
    event.preventDefault?.();
    event.stopPropagation?.();
    event.target?.releasePointerCapture?.(event.pointerId);
    this.pointerOwners.delete(event.pointerId);

    if (owner.type === 'stick') {
      this.emitMove(0, 0);
      this.stickCenter = null;
      this.root?.style?.setProperty('--stick-x', '0px');
      this.root?.style?.setProperty('--stick-y', '0px');
      this.root?.style?.setProperty('--stick-power', '0');
      owner.element?.classList?.remove('lit');
      for (const el of Object.values(owner.armEls ?? {})) el?.classList?.remove('lit');
    } else if (owner.type === 'look') {
      this.lastLookPoint = null;
      this.lastLookTime = null;
      this.lookSpeed = null;
      owner.element?.classList?.remove('lit');
      this.hideBreath();
      if (owner.rimActive) {
        owner.rimActive = false;
        owner.rimDX = 0;
        owner.rimDY = 0;
        this.stopRimLoop();
      }
      this.maybeTapFire(owner, event);
    } else if (owner.type === 'swipe') {
      /* Detents fire on the move; release is just the door closing. */
    } else if (owner.type === 'latch') {
      owner.element?.classList?.remove('lit', 'dip');
      if (owner.holdTimer) {
        clearTimeout(owner.holdTimer);
        owner.holdTimer = 0;
      }
      if (owner.held) {
        /* A physical hold gets its release grace so touch jitter never
         * stands you up mid-duck; a latch underneath stays standing. */
        const timer = setTimeout(() => {
          this.latchGrace.delete(owner.action);
          const entry = this.latches.get(owner.action);
          if ((!entry || !entry.latched) && owner.key) this.releaseKey(owner.key);
          owner.element?.classList?.remove('held');
        }, this.options.latchGraceMs);
        this.latchGrace.set(owner.action, { timer, key: owner.key, element: owner.element });
      } else {
        /* A quick tap toggles the virtual hold. */
        const entry = this.latches.get(owner.action);
        this.setLatched(owner.action, !(entry?.latched ?? false));
        buzz(this.options.haptics, 14);
      }
    } else if (owner.type === 'button' && owner.key) {
      owner.element?.classList?.remove('lit', 'dip');
      this.releaseKey(owner.key);
    }
  }

  /* A quick, unmoved touch on the look surface fires without the thumb
   * ever leaving the glass. */
  maybeTapFire(owner, event) {
    if (owner.moved) return;
    if (typeof owner.downT !== 'number' || typeof event.timeStamp !== 'number') return;
    if (event.timeStamp - owner.downT > this.options.lookTapMaxMs) return;
    const action = this.options.lookTapAction;
    const key = action ? this.keys[action] : undefined;
    if (!key) return;
    this.pressKey(key);
    this.releaseKey(key);
    buzz(this.options.haptics, this.options.hapticDurationMs);
  }

  /* Past the rim the look surface slews continuously: a rAF loop emits
   * angular velocity from the parked deflection until the thumb lifts or
   * drifts back inside. */
  ensureRimLoop() {
    if (this.rimRaf || !this.enabled) return;
    let last = null;
    const step = (now) => {
      this.rimRaf = 0;
      if (!this.enabled) return;
      const owner = [...this.pointerOwners.values()].find((o) => o.type === 'look' && o.rimActive);
      if (!owner) return;
      const nowMs = typeof now === 'number' ? now : 16;
      const lastMs = typeof last === 'number' ? last : nowMs - 16;
      const dt = Math.min(0.05, Math.max(0, (nowMs - lastMs) / 1000));
      last = nowMs;
      const rate = this.options.lookRimRate * this.options.lookSensitivity;
      const dx = owner.rimDX * rate * dt;
      const dy = owner.rimDY * rate * dt;
      if (dx || dy) this.bridge.look(dx, dy);
      this.rimRaf = nextFrame(step);
    };
    this.rimRaf = nextFrame(step);
  }

  stopRimLoop() {
    cancelFrame(this.rimRaf);
    this.rimRaf = 0;
  }

  setLatched(action, latched) {
    const entry = this.latches.get(action);
    if (!entry) return;
    entry.latched = latched;
    if (entry.key) {
      if (latched) this.pressKey(entry.key);
      else this.releaseKey(entry.key);
    }
    entry.element?.classList?.toggle('latched', latched);
  }

  cancelLatchGrace(action) {
    const pending = this.latchGrace.get(action);
    if (pending) {
      clearTimeout(pending.timer);
      this.latchGrace.delete(action);
    }
  }

  updateStick(event) {
    const center = this.stickCenter ?? eventPoint(event);
    const point = eventPoint(event);
    const target = event.target?.closest?.('[data-phone-action="stick"]') ?? event.target;
    const rect = target?.getBoundingClientRect?.();
    const radius = Math.max(32, Math.min(rect?.width || 96, rect?.height || 96) / 2);
    const rawX = clamp((point.x - center.x) / radius, -1, 1);
    const rawY = clamp((point.y - center.y) / radius, -1, 1);

    /* Radial deadzone with rescale and a response curve: inside the
     * deadzone the thumb rests; outside it the magnitude sweeps
     * walk→run continuously, but the curve keeps the low end gentle so
     * the walk zone is featherable. The thumb itself is the speed
     * control — full edge is still full run when you punch it. */
    const magnitude = Math.hypot(rawX, rawY);
    const dead = this.options.stickDeadZone;
    let x = 0;
    let y = 0;
    let power = 0;
    if (magnitude > dead) {
      const scaled = Math.pow(Math.min(1, (magnitude - dead) / (1 - dead)), this.options.stickResponse);
      x = (rawX / magnitude) * scaled;
      y = (rawY / magnitude) * scaled;
      power = scaled;
    }
    this.emitMove(x, y);

    /* The visual thumb follows the finger exactly; the emitted vector is
     * the curved one. No lying. Travel is proportional to the measured
     * ring so the thumb always reaches the edge at full deflection, and
     * --stick-power (0..1) lets the host glow the thumb with deflection. */
    const thumbTravel = Math.max(0, radius - (rect?.width || 96) * 0.21);
    const round1 = (v) => Math.round(v * 10) / 10;
    this.root?.style?.setProperty('--stick-x', `${round1(rawX * thumbTravel)}px`);
    this.root?.style?.setProperty('--stick-y', `${round1(rawY * thumbTravel)}px`);
    this.root?.style?.setProperty('--stick-power', `${power}`);
  }

  emitMove(x, y) {
    const last = this.moveVector;
    if (Math.abs(x - last.x) < MOVE_EPSILON && Math.abs(y - last.y) < MOVE_EPSILON) return;
    this.moveVector = { x, y };
    this.bridge.move?.(x, y);
  }

  pressKey(key) {
    if (this.heldKeys.has(key)) return;
    this.heldKeys.add(key);
    this.bridge.key(key, true);
  }

  releaseKey(key) {
    if (!this.heldKeys.has(key)) return;
    this.heldKeys.delete(key);
    this.bridge.key(key, false);
  }

  releaseAll() {
    this.stopRimLoop();
    this.hideBreath();
    /* Every woken control is put back to sleep deterministically through
     * the owners and latch entries that woke it — no DOM sweep needed. */
    const sleep = (el) => el?.classList?.remove('lit', 'dip');
    for (const owner of this.pointerOwners.values()) {
      sleep(owner.element);
      for (const el of Object.values(owner.armEls ?? {})) el?.classList?.remove('lit');
    }
    for (const entry of this.latches.values()) sleep(entry.element);
    for (const owner of this.pointerOwners.values()) {
      if (owner.type === 'latch') {
        if (owner.holdTimer) clearTimeout(owner.holdTimer);
        owner.element?.classList?.remove('held');
      }
    }
    for (const pending of this.latchGrace.values()) {
      clearTimeout(pending.timer);
      pending.element?.classList?.remove('held');
    }
    this.latchGrace.clear();
    /* A clean slate stands every virtual hold back up. */
    for (const action of [...this.latches.keys()]) this.setLatched(action, false);
    this.latches.clear();
    this.pointerOwners.clear();
    this.emitMove(0, 0);
    for (const key of [...this.heldKeys]) {
      this.releaseKey(key);
    }
    this.stickCenter = null;
    this.lastLookPoint = null;
    this.lastLookTime = null;
    this.lookSpeed = null;
    this.root?.style?.setProperty('--stick-x', '0px');
    this.root?.style?.setProperty('--stick-y', '0px');
    this.root?.style?.setProperty('--stick-power', '0');
  }
}

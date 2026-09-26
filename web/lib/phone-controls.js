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
 * Actions: 'stick' and 'look' are the two analog zones; everything in
 * BUTTON_ACTIONS is a digital button resolved through options.keys.
 */

export const DEFAULT_PHONE_CONTROL_OPTIONS = Object.freeze({
  stickDeadZone: 0.18,
  lookSensitivity: 1,
  maxLookDelta: 512,
  haptics: true,
  hapticDurationMs: 8,
  keys: Object.freeze({}),
});

const BUTTON_ACTIONS = new Set([
  'forward', 'back', 'left', 'right',
  'attack', 'jump', 'use', 'menu', 'menuBack', 'menuSelect',
  'nextWeapon', 'prevWeapon',
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
    this.moveVector = { x: 0, y: 0 };

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

  onPointerDown(event) {
    if (!this.enabled || !this.root) return;
    const action = actionForTarget(event.target);
    if (!action) return;
    if ([...this.pointerOwners.values()].some((owner) => owner.action === action)) return;

    event.preventDefault?.();
    event.stopPropagation?.();
    event.target?.setPointerCapture?.(event.pointerId);

    if (action === 'stick') {
      this.pointerOwners.set(event.pointerId, { type: 'stick', action });
      this.stickCenter = rectCenter(event.target, eventPoint(event));
      this.updateStick(event);
      return;
    }

    if (action === 'look') {
      this.pointerOwners.set(event.pointerId, { type: 'look', action });
      this.lastLookPoint = eventPoint(event);
      return;
    }

    if (BUTTON_ACTIONS.has(action)) {
      const key = this.keys[action];
      this.pointerOwners.set(event.pointerId, { type: 'button', action, key });
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
      return;
    }
    if (owner.type === 'look') {
      const point = eventPoint(event);
      if (this.lastLookPoint) {
        /* Linear 1:1 drag. The clamp is a garbage-event guard, not a
         * speed limit: fast flicks must survive, or turning feels like
         * dragging through mud. */
        const scale = this.options.lookSensitivity;
        const dx = clamp(point.x - this.lastLookPoint.x, -this.options.maxLookDelta, this.options.maxLookDelta) * scale;
        const dy = clamp(point.y - this.lastLookPoint.y, -this.options.maxLookDelta, this.options.maxLookDelta) * scale;
        if (dx || dy) this.bridge.look(dx, dy);
      }
      this.lastLookPoint = point;
    }
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
    } else if (owner.type === 'look') {
      this.lastLookPoint = null;
    } else if (owner.type === 'button' && owner.key) {
      this.releaseKey(owner.key);
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

    /* Radial deadzone with rescale: inside the deadzone the thumb rests,
     * outside it the magnitude sweeps walk→run continuously. The thumb
     * itself is the speed control. */
    const magnitude = Math.hypot(rawX, rawY);
    const dead = this.options.stickDeadZone;
    let x = 0;
    let y = 0;
    if (magnitude > dead) {
      const scaled = Math.min(1, (magnitude - dead) / (1 - dead));
      x = (rawX / magnitude) * scaled;
      y = (rawY / magnitude) * scaled;
    }
    this.emitMove(x, y);

    /* The visual thumb follows the finger exactly; the emitted vector is
     * the curved one. No lying. */
    this.root?.style?.setProperty('--stick-x', `${rawX * 2}rem`);
    this.root?.style?.setProperty('--stick-y', `${rawY * 2}rem`);
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
    this.pointerOwners.clear();
    this.emitMove(0, 0);
    for (const key of [...this.heldKeys]) {
      this.releaseKey(key);
    }
    this.stickCenter = null;
    this.lastLookPoint = null;
    this.root?.style?.setProperty('--stick-x', '0px');
    this.root?.style?.setProperty('--stick-y', '0px');
  }
}

// Keyboard and mouse. Owns pointer lock and turns raw events into the button
// bitmask the shared controller consumes.

import { BTN } from '/shared/constants.js';

export const DEFAULT_BINDS = {
  forward: 'KeyW', back: 'KeyS', left: 'KeyA', right: 'KeyD',
  jump: 'Space', crouch: 'ControlLeft', sprint: 'ShiftLeft',
  reload: 'KeyR', melee: 'KeyV', use: 'KeyF', inspect: 'KeyT',
  leanLeft: 'KeyQ', leanRight: 'KeyE',
  primary: 'Digit1', secondary: 'Digit2', fireMode: 'KeyB',
  scoreboard: 'Tab', chat: 'Enter', menu: 'Escape',
};

export class Input {
  constructor(canvas, settings) {
    this.canvas = canvas;
    this.settings = settings;
    this.binds = { ...DEFAULT_BINDS, ...(settings.binds || {}) };
    this.down = new Set();
    this.pressed = new Set();
    this.mouse = { left: false, right: false };
    this.mousePressed = { left: false, right: false };
    this.delta = { x: 0, y: 0 };
    this.wheel = 0;
    this.locked = false;
    this.enabled = false;
    this.listeners = [];
    this.onLockChange = null;

    this.bind();
  }

  bind() {
    const add = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      this.listeners.push(() => target.removeEventListener(type, fn, opts));
    };

    add(window, 'keydown', (e) => {
      if (e.repeat) return;
      // Never swallow the browser's own shortcuts.
      if (e.ctrlKey && e.code !== 'ControlLeft') return;
      if (this.enabled && this.shouldCapture(e.code)) e.preventDefault();
      this.down.add(e.code);
      this.pressed.add(e.code);
    });

    add(window, 'keyup', (e) => {
      this.down.delete(e.code);
    });

    add(window, 'blur', () => {
      this.down.clear();
      this.mouse.left = this.mouse.right = false;
    });

    add(this.canvas, 'mousedown', (e) => {
      if (!this.locked) return;
      if (e.button === 0) { this.mouse.left = true; this.mousePressed.left = true; }
      if (e.button === 2) { this.mouse.right = true; }
    });
    add(window, 'mouseup', (e) => {
      if (e.button === 0) this.mouse.left = false;
      if (e.button === 2) this.mouse.right = false;
    });
    add(window, 'contextmenu', (e) => { if (this.locked) e.preventDefault(); });

    add(window, 'mousemove', (e) => {
      if (!this.locked) return;
      this.delta.x += e.movementX || 0;
      this.delta.y += e.movementY || 0;
    });

    add(window, 'wheel', (e) => {
      if (!this.locked) return;
      e.preventDefault();
      this.wheel += Math.sign(e.deltaY);
    }, { passive: false });

    add(document, 'pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      document.body.classList.toggle('playing', this.locked);
      if (!this.locked) {
        this.down.clear();
        this.mouse.left = this.mouse.right = false;
      }
      this.onLockChange?.(this.locked);
    });
  }

  shouldCapture(code) {
    return code === 'Tab' || code === 'Space' || code.startsWith('Arrow') ||
      code === 'Slash' || code === 'Quote';
  }

  async requestLock() {
    if (this.locked) return true;
    try {
      await this.canvas.requestPointerLock({ unadjustedMovement: true });
      return true;
    } catch {
      try { this.canvas.requestPointerLock(); return true; } catch { return false; }
    }
  }

  releaseLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  isDown(action) { return this.down.has(this.binds[action]); }

  /** True once per physical press. */
  wasPressed(action) {
    const code = this.binds[action];
    if (this.pressed.has(code)) { this.pressed.delete(code); return true; }
    return false;
  }

  takeMouseClick() {
    if (this.mousePressed.left) { this.mousePressed.left = false; return true; }
    return false;
  }

  /** Consume accumulated mouse movement, converted to radians. */
  takeLook() {
    const sens = (this.settings.sensitivity ?? 0.42) * 0.0022;
    const out = { x: this.delta.x * sens, y: this.delta.y * sens * (this.settings.invertY ? -1 : 1) };
    this.delta.x = 0;
    this.delta.y = 0;
    return out;
  }

  takeWheel() {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }

  /** Current movement/stance buttons as the shared bitmask. */
  buttons(opts = {}) {
    let b = 0;
    if (this.isDown('forward')) b |= BTN.FORWARD;
    if (this.isDown('back')) b |= BTN.BACK;
    if (this.isDown('left')) b |= BTN.LEFT;
    if (this.isDown('right')) b |= BTN.RIGHT;
    if (this.isDown('jump')) b |= BTN.JUMP;
    if (this.isDown('crouch')) b |= BTN.CROUCH;
    if (this.isDown('sprint')) b |= BTN.SPRINT;
    if (this.isDown('leanLeft')) b |= BTN.LEAN_L;
    if (this.isDown('leanRight')) b |= BTN.LEAN_R;
    if (this.mouse.right && !opts.noAds) b |= BTN.ADS;
    if (this.mouse.left && !opts.noFire) b |= BTN.FIRE;
    return b;
  }

  endFrame() {
    this.pressed.clear();
    this.mousePressed.left = false;
  }

  dispose() {
    for (const off of this.listeners) off();
    this.listeners.length = 0;
  }
}

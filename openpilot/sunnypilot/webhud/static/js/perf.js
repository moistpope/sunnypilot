// The frame rate: a counter under the status card (Settings > Display > Debug), and the 3D view's
// render resolution. On 'auto', while frames come slower than the display refreshes, the blur behind the
// HUD's cards goes first, then the resolution steps down; once frames have kept up for a while they come
// back a step at a time, and a step that brings the slowdown straight back is held off for a minute. Tap
// the counter for what a frame costs.
import { $, el, setClass, setText } from './util.js';

const WINDOW_MS = 1000;
// auto's steps: the resolution, as a share of the full one (scene.js: the device's pixel ratio, at most 1.75),
// and whether the cards keep their blur
const AUTO_LEVELS = [{ scale: 1, blur: true }, { scale: 1, blur: false }, { scale: 0.85 }, { scale: 0.7 }, { scale: 0.6 }];
const SLOW = 0.88, FAST = 0.97;            // of the display's rate: below, a window is slow; at or above, fast
const DOWN_AFTER = 2, UP_AFTER = 8;        // slow / fast windows in a row before a step
const HOLD_MS = 60000;                     // after a step up that turned slow again, no step up for this long

export class FrameMeter {
  constructor(app) {
    this.app = app;
    this.el = el('button.fps', { type: 'button', 'aria-label': 'Frame rate', onclick: () => { this.detail = !this.detail; this._show(); } });
    $('#app').append(this.el);
    this.detail = false;
    this.hz = 60;          // the display's refresh rate: the best rate seen, at least 60
    this.level = 0;        // AUTO_LEVELS index while on auto
    this.slow = 0;         // slow windows in a row
    this.fast = 0;         // fast windows in a row
    this.raisedAt = -1e9;  // when auto last stepped up
    this.holdUntil = 0;
    this.stats = null;
    this._reset(performance.now());
    this.apply();
  }

  // the settings changed: show or hide the counter, set the resolution
  apply() {
    const s = this.app.settings;
    setClass(this.el, 'hidden', !s.showFps);
    this._setLevel();
    this._show();
  }

  // one animation frame: the time since the last one and what the HUD's own work took (ms)
  tick(now, interval, work) {
    const w = this.win;
    if (interval > 0 && interval < 250) {   // longer: the page was hidden or the tab throttled
      w.frames++;
      w.worst = Math.max(w.worst, interval);
      w.work += work;
    }
    if (now - w.start < WINDOW_MS) return;
    const r = this.app.scene.renderer.info.render;
    const fps = w.frames * 1000 / (now - w.start);
    if (w.frames >= 10) {   // fewer: the page is hidden, or a tab in the background
      this.stats = { fps, worst: w.worst, work: w.work / w.frames, calls: r.calls, tris: r.triangles };
      this.hz = Math.max(this.hz, Math.min(144, Math.round(fps / 30) * 30));
      // a page the browser calls hidden may be throttled (a covered window): not slow, so auto waits
      if (this.app.settings.renderScale === 'auto' && !document.hidden) this._auto(fps, now);
    }
    this._reset(now);
    this._show();
  }

  _auto(fps, now) {
    const slow = fps < this.hz * SLOW, fast = fps >= this.hz * FAST;
    this.slow = slow ? this.slow + 1 : 0;
    this.fast = fast ? this.fast + 1 : 0;
    if (this.slow >= DOWN_AFTER && this.level < AUTO_LEVELS.length - 1) {
      if (now - this.raisedAt < 4 * WINDOW_MS) this.holdUntil = now + HOLD_MS;   // the step up didn't hold
      this.level++;
      this.slow = 0;
      this._setLevel();
    } else if (this.fast >= UP_AFTER && this.level > 0 && now > this.holdUntil) {
      this.level--;
      this.fast = 0;
      this.raisedAt = now;
      this._setLevel();
    }
  }

  // the resolution and blur: auto's current step, or the resolution set
  _setLevel() {
    const auto = this.app.settings.renderScale === 'auto', step = AUTO_LEVELS[this.level];
    const k = auto ? step.scale : Number(this.app.settings.renderScale) || 1;
    if (this.app.scene.renderScale !== k) this.app.scene.setRenderScale(k);
    document.documentElement.classList.toggle('lowfx', auto && !step.blur);
  }

  _reset(now) { this.win = { start: now, frames: 0, worst: 0, work: 0 }; }

  _show() {
    const s = this.stats;
    if (!s || !this.app.settings.showFps) return;
    const scale = this.app.scene.renderScale;
    const lowfx = document.documentElement.classList.contains('lowfx');
    let text = `${Math.round(s.fps)} fps`;
    if (scale < 1) text += ` · ${Math.round(scale * 100)}%`;
    if (this.detail) {
      text += ` · worst ${Math.round(s.worst)} ms · JS ${s.work.toFixed(1)} ms · ${s.calls} draws · ${Math.round(s.tris / 1000)}k tris`;
      if (scale === 1) text += ' · 100%';
      if (lowfx) text += ' · no blur';
    }
    setText(this.el, text);
    setClass(this.el, 'low', s.fps < this.hz * SLOW);
  }
}

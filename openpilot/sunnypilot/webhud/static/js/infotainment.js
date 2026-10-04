// Music and navigation from the head unit. What's playing shows in a card at the bottom, with its
// controls. The next turn shows in a card at the top, and as an arrow on the road ahead (navarrow.js)
// once it's near. The Android app (android/, HudListener.kt) reads them from the head unit's media
// session and its turn-by-turn notification, and sends them as they are (webhud:media, webhud:nav
// events). They're parsed here, so the parsing can change without reinstalling the app. In a plain
// browser there's no app and both cards stay hidden. Settings > Display > Debug has a demo of both.
import { $, el, iconSvg, setClass, setText } from './util.js';

const UNIT_M = { mi: 1609.344, mile: 1609.344, miles: 1609.344, ft: 0.3048, feet: 0.3048, foot: 0.3048, yd: 0.9144, yds: 0.9144, yard: 0.9144,
  yards: 0.9144, km: 1000, m: 1, meter: 1, meters: 1 };
const DIST_RE = /(\d+(?:[.,]\d+)?)\s*(miles?|mi|feet|foot|ft|yards?|yds?|km|met(?:er|re)s?|m)(?![a-z])/i;   // British spelling too
const TRIP_RE = /\b\d+\s*(?:min|hr|h)\b|\bETA\b|arriv/i;

// The maneuver an instruction describes: { kind, side } with kind one of straight, slight, turn, sharp,
// uturn, keep, ramp, merge, roundabout, arrive; side 'left' | 'right' | null. Null when it says none.
export function maneuverOf(text) {
  const t = (text || '').toLowerCase();
  if (!t) return null;
  const side = /\bleft\b/.test(t) ? 'left' : /\bright\b/.test(t) ? 'right' : null;
  if (/destination|arriv|you have reached/.test(t)) return { kind: 'arrive', side };
  if (/u-?turn/.test(t)) return { kind: 'uturn', side: side || 'left' };
  if (/roundabout|rotary|traffic circle/.test(t)) return { kind: 'roundabout', side };
  if (/sharp (left|right)/.test(t)) return { kind: 'sharp', side };
  if (/(slight|bear) (left|right)/.test(t)) return { kind: 'slight', side };
  if (/\b(keep|stay)\b|\bfork\b/.test(t)) return { kind: 'keep', side };
  if (/\bexit\b|\bramp\b/.test(t)) return { kind: 'ramp', side: side || 'right' };
  if (/\bmerge\b/.test(t)) return { kind: 'merge', side };
  if (/\bturn\b/.test(t) && side) return { kind: 'turn', side };
  if (side && /\b(left|right) (onto|on|at|to)\b|^(left|right)\b/.test(t)) return { kind: 'turn', side };
  if (/continue|straight|\bhead\b|\bgo\b|\bstay on\b/.test(t)) return { kind: 'straight', side: null };
  return null;
}

// A turn-by-turn notification as it came (title, text, subText, bigText, info): the next turn's distance
// (as written, and m), what to do there, the street, and the trip line (time, distance, ETA).
export function parseNav(raw) {
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const fields = [raw.title, raw.text, raw.bigText].map(clean).filter(Boolean);
  let dist = null, instruction = '';
  for (const f of fields) {
    const m = DIST_RE.exec(f);
    if (m && !dist && !TRIP_RE.test(f)) {
      const value = parseFloat(m[1].replace(',', '.')), unit = m[2].toLowerCase().replace(/re(s?)$/, 'er$1'), k = UNIT_M[unit] || 1;
      // what it was rounded to: "0.3 mi" is 0.25..0.35 mi, "550 ft" 525..575 ft
      const decimals = (m[1].split(/[.,]/)[1] || '').length;
      const half = decimals ? 0.5 * 10 ** -decimals : value % 100 === 0 ? 50 : value % 50 === 0 ? 25 : value % 10 === 0 ? 5 : 0.5;
      dist = { text: `${m[1]} ${m[2]}`, value: m[1], unit: m[2], m: value * k, half: half * k };
      const rest = clean(f.replace(m[0], '').replace(/^(in|within)\b\s*/i, '').replace(/^[,·•\-–—:\s]+|[,·•\-–—:\s]+$/g, ''));
      if (rest.length > 2) instruction = rest;
    } else if (!instruction && !TRIP_RE.test(f)) instruction = f;
  }
  if (!instruction) instruction = fields.find(f => !TRIP_RE.test(f) && !DIST_RE.test(f)) || '';
  const trip = [raw.subText, raw.info, raw.text, raw.title].map(clean).find(f => f && f !== instruction && TRIP_RE.test(f)) || '';
  return { dist, instruction, street: streetOf(instruction), trip, maneuver: maneuverOf(instruction) };
}

// the street an instruction names: after its most telling word ("...take the 2nd exit onto High St"),
// not a phrase like "the fork" or "the right"
function streetOf(instruction) {
  for (const word of ['onto', 'towards?', 'on', 'to', 'at']) {
    const m = new RegExp(`.*\\b${word}\\s+(.+)$`, 'i').exec(instruction);
    if (m && !/^the\b/i.test(m[1])) return m[1].replace(/[.!]+$/, '');
  }
  return '';
}

// arrow icons for the card, drawn for the right-hand maneuver; the left ones are mirrored
const MANEUVER_SVG = {
  straight: '<path d="M12 21V4M6 10l6-6 6 6"/>',
  slight: '<path d="M9 21v-7l8-8"/><path d="M10 6h7v7"/>',
  turn: '<path d="M7 21v-8a4 4 0 0 1 4-4h9"/><path d="M15 4l5 5-5 5"/>',
  sharp: '<path d="M8 3v8l9 9"/><path d="M10 20h7v-7"/>',
  uturn: '<path d="M8 21V10a5 5 0 0 1 10 0v6"/><path d="M14.5 13l3.5 3.5 3.5-3.5"/>',
  keep: '<path d="M12 21v-6l5-6V3"/><path d="M14 6l3-3 3 3"/><path d="M12 15L7 9V5" opacity=".35"/>',
  ramp: '<path d="M8 21V11l9-7"/><path d="M11.5 4H17v5.5"/><path d="M8 11V3" opacity=".35"/>',
  merge: '<path d="M12 21V12L6 6V3"/><path d="M12 12l6-6"/><path d="M15 6h3v3"/>',
  roundabout: '<circle cx="12" cy="10" r="4"/><path d="M12 21v-7M15 7l4-4M15.5 3H19v3.5"/>',
  arrive: '<path d="M6 21V4h11l-2.5 4 2.5 4H6"/>',
};
function maneuverSvg(mv) {
  const body = MANEUVER_SVG[mv.kind] || MANEUVER_SVG.straight;
  const flip = mv.side === 'left' && !['straight', 'arrive', 'merge'].includes(mv.kind) ? ' transform="matrix(-1 0 0 1 24 0)"' : '';
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><g${flip}>${body}</g></svg>`;
}

const fmtTime = (ms) => { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

export class Infotainment {
  constructor(app) {
    this.app = app;
    this.media = null;   // as the app sent it, with `art` kept from the last message that had it
    this.nav = null;     // { raw, parsed }
    this.demo = null;
    this._buildMusic();
    this._buildNav();
    window.addEventListener('webhud:media', (e) => { if (!this.demo) this.setMedia(e.detail); });
    window.addEventListener('webhud:nav', (e) => { if (!this.demo) this.setNav(e.detail); });
    window.addEventListener('webhud:infotainment', () => this._pull());   // the app was away, or the page just finished loading
    this._pull();   // what the app already had before this page loaded
    if (window.ResizeObserver) new ResizeObserver(() => this.layout()).observe($('#replaybar'));
    this.apply();
  }

  // everything the app has, pictures included
  _pull() {
    if (this.demo) return;
    try {
      const now = window.WebHudApp?.infotainment?.();
      if (now) { const j = JSON.parse(now); this.setMedia(j.media); this.setNav(j.nav); }
    } catch { /* not in the app, or an older one */ }
  }

  // the settings changed
  apply() {
    const s = this.app.settings;
    if (s.demoInfotainment && !this.demo) this.demo = new Demo(this);
    if (!s.demoInfotainment && this.demo) { this.demo = null; this.setMedia(null); this.setNav(null); this._pull(); }
    this._showMusic();
    this._showNav();
  }

  // ---- music ----

  _buildMusic() {
    this.art = el('div.mc-art');
    this.title = el('b');
    this.artist = el('span');
    this.source = el('small');
    this.bar = el('i');
    this.elapsed = el('span');
    this.total = el('span');
    const btn = (icon, action, label) => {
      const b = el('button.mc-btn', { type: 'button', 'aria-label': label, onclick: () => this.command(action) });
      b.innerHTML = iconSvg(icon);
      return b;
    };
    this.prev = btn('prev', 'prev', 'Previous');
    this.play = btn('play', 'toggle', 'Play or pause');
    this.next = btn('next', 'next', 'Next');
    this.music = el('section.card.musiccard.hidden', { id: 'musiccard', 'aria-label': 'Now playing' },
      this.art,
      el('div.mc-meta', this.title, this.artist, this.source),
      el('div.mc-ctl', this.prev, this.play, this.next),
      el('div.mc-time', this.elapsed, el('div.mc-bar', this.bar), this.total));
    $('#app').append(this.music);
  }

  setMedia(m) {
    if (m && !m.art && this.media && m.artKey && m.artKey === this.media.artKey) m.art = this.media.art;
    this.media = m && (m.title || m.artist) ? m : null;
    this._showMusic();
  }

  // a control on the card: to the app (the head unit's media session), or the demo
  command(action) {
    if (this.demo) { this.demo.command(action); return; }
    try { window.WebHudApp?.media?.(action); } catch { /* not in the app */ }
  }

  _showMusic() {
    const m = this.media, on = !!m && this.app.settings.showMusic !== false;
    setClass(this.music, 'hidden', !on);
    if (!on) { this.layout(); return; }
    setText(this.title, m.title || m.album || '');
    setText(this.artist, [m.artist, m.album].filter(Boolean).join(' · '));
    setText(this.source, m.app || '');
    if (this.artShown !== m.art) {
      this.artShown = m.art;
      this.art.style.backgroundImage = m.art ? `url("${m.art}")` : '';
      setClass(this.art, 'none', !m.art);
    }
    const ctl = !!this.demo || !!window.WebHudApp?.media;
    const can = m.actions || {};
    this.prev.disabled = !ctl || can.prev === false;
    this.next.disabled = !ctl || can.next === false;
    this.play.disabled = !ctl;
    const icon = m.playing ? 'pause' : 'play';
    if (this.play.dataset.icon !== icon) { this.play.innerHTML = iconSvg(icon); this.play.dataset.icon = icon; }
    setClass(this.music, 'timed', m.duration > 0);
    this.layout();
    this.tick();
  }

  // the progress bar: from the last position the app sent, played on at its speed while playing
  tick() {
    const m = this.media;
    if (!m || !(m.duration > 0) || this.music.classList.contains('hidden')) return;
    const pos = Math.min(m.duration, (m.position || 0) + (m.playing ? (Date.now() - (m.at || Date.now())) * (m.speed || 1) : 0));
    this.bar.style.width = `${(pos / m.duration * 100).toFixed(2)}%`;
    setText(this.elapsed, fmtTime(pos));
    setText(this.total, fmtTime(m.duration));
  }

  // ---- navigation ----

  _buildNav() {
    this.navIcon = el('div.nc-icon');
    this.navDist = el('b');
    this.navUnit = el('small');
    this.navWhat = el('div.nc-what');
    this.navTrip = el('div.nc-trip');
    this.navCard = el('section.card.navcard.hidden', { id: 'navcard', 'aria-label': 'Next turn' },
      this.navIcon, el('div.nc-dist', this.navDist, this.navUnit), el('div.nc-text', this.navWhat, this.navTrip));
    $('#app').append(this.navCard);
  }

  setNav(raw) {
    this.nav = raw && (raw.title || raw.text) ? { raw, parsed: parseNav(raw) } : null;
    if (this.nav && !raw.icon && this.navIconKey === raw.iconKey) raw.icon = this.navIconData;
    if (this.nav) { this.navIconKey = raw.iconKey; this.navIconData = raw.icon; }
    this._showNav();
  }

  _showNav() {
    const n = this.nav, on = !!n && this.app.settings.showNav !== false;
    setClass(this.navCard, 'hidden', !on);
    const arrow = this.app.scene.navArrow;
    if (!on) { arrow.set(null); this.layout(); return; }
    const p = n.parsed;
    setText(this.navDist, p.dist ? p.dist.value : '');
    setText(this.navUnit, p.dist ? p.dist.unit : '');
    setText(this.navWhat, p.street || p.instruction);
    setText(this.navTrip, p.street && p.instruction !== p.street ? `${p.instruction}${p.trip ? ' · ' + p.trip : ''}` : p.trip);
    // our arrow when the words say what to do, else the nav app's own picture of it
    const key = p.maneuver ? `${p.maneuver.kind}-${p.maneuver.side}` : `img:${n.raw.iconKey || ''}`;
    if (this.navIcon.dataset.key !== key) {
      this.navIcon.dataset.key = key;
      if (p.maneuver) this.navIcon.innerHTML = maneuverSvg(p.maneuver);
      else this.navIcon.replaceChildren(...(n.raw.icon ? [el('img', { src: n.raw.icon, alt: '' })] : []));
    }
    arrow.set(p.maneuver && p.dist ? { ...p.maneuver, m: p.dist.m, half: p.dist.half, step: p.instruction } : null);
    this.layout();
  }

  // ---- layout and per frame ----

  // the cards' heights for what stacks against them: the alerts under the nav card, the music card over
  // the replay bar
  layout() {
    const root = document.documentElement.style;
    const nav = this.navCard.classList.contains('hidden') ? 0 : this.navCard.offsetHeight;
    root.setProperty('--navcard-h', `${nav ? nav + 8 : 0}px`);
    const rb = $('#replaybar');
    if (rb.classList.contains('hidden') || !rb.offsetHeight) root.removeProperty('--music-bottom');
    else root.setProperty('--music-bottom', `${Math.round(window.innerHeight - rb.getBoundingClientRect().top + 10)}px`);
  }

  frame(dt) {
    if (this.demo) this.demo.frame(dt);
    this._t = (this._t || 0) + dt;
    if (this._t > 0.25) { this._t = 0; this.tick(); }
  }
}

// ---- demo ----------------------------------------------------------------------------------------

const DEMO_TRACKS = [
  ['Solar Sky', 'The Pulse Lines', 'Open Road', 214000, ['#3e6ae1', '#9b5de5']],
  ['Coastline at Night', 'Hollywood Mode', 'California', 187000, ['#f15bb5', '#fee440']],
  ['Lane Keeping', 'Adaptive Cruise', 'Long Drive', 241000, ['#00bbf9', '#00f5d4']],
];
const DEMO_ROUTE = [
  ['Turn right onto W Pico Blvd', 420],
  ['Turn left onto S Robertson Blvd', 650],
  ['Slight right onto the I-10 E ramp', 900],
  ['Keep left to continue on I-10 E', 1400],
  ['Take exit 7A toward Santa Monica Blvd', 1800],
  ['Make a U-turn', 500],
  ['Your destination will be on the right', 300],
];

// Plays the parts of the app and the nav app: a playlist that plays on, and a route whose next turn
// comes nearer as the car drives (the HUD's own speed), written the way Google Maps writes its notification.
class Demo {
  constructor(info) {
    this.info = info;
    this.track = 0;
    this.pos = 0;
    this.playing = true;
    this.step = 0;
    this.left = DEMO_ROUTE[0][1];
    this.sent = 0;
    this.arts = DEMO_TRACKS.map(([title, , , , colors]) => demoArt(title, colors));
    this._sendMedia();
    this._sendNav();
  }

  command(action) {
    if (action === 'toggle') this.playing = !this.playing;
    else if (action === 'next' || (action === 'prev' && this.pos < 3000)) {
      const n = DEMO_TRACKS.length;
      this.track = (this.track + (action === 'next' ? 1 : n - 1)) % n;
      this.pos = 0;
    } else if (action === 'prev') this.pos = 0;
    this._sendMedia();
  }

  frame(dt) {
    if (this.playing) {
      this.pos += dt * 1000;
      if (this.pos >= DEMO_TRACKS[this.track][3]) { this.command('next'); return; }
    }
    this.left -= this.info.app.vehicle.speed * dt;
    if (this.left < -15) {
      this.step = (this.step + 1) % DEMO_ROUTE.length;
      this.left = DEMO_ROUTE[this.step][1];
    }
    this.sent += dt;
    if (this.sent > 1) this._sendNav();   // the nav app updates its notification about once a second
  }

  _sendMedia() {
    const [title, artist, album, duration] = DEMO_TRACKS[this.track];
    this.info.setMedia({ app: 'Demo player', title, artist, album, duration, position: this.pos, speed: 1, at: Date.now(),
      playing: this.playing, art: this.arts[this.track], artKey: `demo${this.track}`, actions: { prev: true, next: true } });
  }

  _sendNav() {
    this.sent = 0;
    const app = this.info.app, metric = app.hud.unitFor(app.settings, app.state && app.state.fisker) === 'kmh';
    const fmt = (m) => {
      m = Math.max(0, m);
      if (metric) return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m / 50) * 50 || 10} m`;
      return m >= 161 ? `${(m / 1609.344).toFixed(1)} mi` : `${Math.round(m / 0.3048 / 50) * 50 || 20} ft`;
    };
    const rest = this.left + DEMO_ROUTE.slice(this.step + 1).reduce((a, [, d]) => a + d, 0);
    const min = Math.max(1, Math.round(rest / 13 / 60));
    const eta = new Date(Date.now() + min * 60000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    this.info.setNav({ app: 'Demo maps', title: fmt(this.left), text: DEMO_ROUTE[this.step][0], subText: `${min} min · ${fmt(rest)} · ${eta} ETA` });
  }
}

function demoArt(title, [a, b]) {
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  const g = c.getContext('2d');
  const grad = g.createLinearGradient(0, 0, 160, 160);
  grad.addColorStop(0, a);
  grad.addColorStop(1, b);
  g.fillStyle = grad;
  g.fillRect(0, 0, 160, 160);
  g.fillStyle = 'rgba(255,255,255,.9)';
  g.font = '700 64px system-ui, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(title.split(' ').map(w => w[0]).join('').slice(0, 2), 80, 84);
  return c.toDataURL('image/png');
}

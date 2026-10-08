import { iconFor } from './icons';
import { item } from '../items/items';
import type { Inventory } from '../items/Inventory';

/**
 * Helmet-projected HUD (on foot) and flight HUD (ship). DOM is built once;
 * per-frame updates only touch changed values.
 */

export interface CompassMarker {
  bearing: number; // radians, 0 = north, clockwise
  label: string;
  color: string;
  glyph: string;
}

export interface FootHudState {
  bodyName: string;
  bodyType: string;
  coords: string;
  altitude: number;
  timeOfDay: string;
  weather: string;
  heading: number;
  markers: CompassMarker[];
  health: number;
  oxygen: number; oxygenMax: number;
  energy: number; energyMax: number;
  integrity: number;
  bodyTemp: number;
  ambientTemp: number;
  radiation: number;
  radDose: number;
  food: number | null;
  water: number | null;
  breathable: string;
  pressurized: boolean;
  warnings: string[];
  prompt: string | null;
  targetInfo: string | null;
  mineProgress: number;
  objective: { title: string; hint: string; progress: string } | null;
  hotbarIndex: number;
  toolLabel: string;
}

export interface ShipHudState {
  speed: number;
  vspeed: number;
  altitude: number;
  altLabel: string;
  throttle: number;
  fuel: number;
  /** explorer mode: unlimited resources */
  unlimited?: boolean;
  hull: number;
  hullTemp: number;
  power: boolean;
  thrusters: boolean;
  engine: boolean;
  assist: boolean;
  gear: boolean;
  mode: string;
  nearest: string;
  target: string | null;
  stick: { x: number; y: number };
  vel: { x: number; y: number; visible: boolean };
  horizonRoll: number;
  horizonPitch: number;
  landing: string | null;
  navMarker: { x: number; y: number; label: string; edge: boolean } | null;
  bodyMarkers: { x: number; y: number; label: string }[];
  warnings: string[];
  cockpit: boolean;
  /** ship heading (deg, 0 = north) or null in deep space */
  heading: number | null;
  /** ship pitch / roll relative to the local horizon (deg) */
  pitchDeg: number;
  rollDeg: number;
  /** pitch ladder lines projected to screen (camera-relative) */
  ladder: { deg: number; x1: number; y1: number; x2: number; y2: number }[];
  /** where the ship's nose points on screen */
  nose: { x: number; y: number; visible: boolean };
  speedLevel: number;
  levels: { name: string; max: number }[];
  cruise: boolean;
  landingLight: boolean;
}

const h = (tag: string, cls = '', html = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

export class HUD {
  private root: HTMLElement;
  private ship: HTMLElement;
  private els: Record<string, HTMLElement> = {};
  private last: Record<string, string> = {};
  private bars: Record<string, { row: HTMLElement; fill: HTMLElement; val: HTMLElement }> = {};
  private slots: HTMLElement[] = [];
  private compassStrip!: HTMLElement;
  private feed!: HTMLElement;
  private centerMsg!: HTMLElement;
  private mineRing!: SVGCircleElement;
  private damageEl!: HTMLElement;
  private shipEls: Record<string, HTMLElement> = {};
  private bodyMarkEls: HTMLElement[] = [];
  private objEl!: HTMLElement;
  private lastObjTitle = '';
  private toolTimer = 0;

  constructor() {
    this.root = document.getElementById('hud')!;
    this.ship = document.getElementById('shiphud')!;
    this.buildFoot();
    this.buildShip();
  }

  private set(key: string, el: HTMLElement, text: string, html = false): void {
    if (this.last[key] === text) return;
    this.last[key] = text;
    if (html) el.innerHTML = text; else el.textContent = text;
  }

  private buildFoot(): void {
    const r = this.root;
    r.appendChild(h('div', 'crosshair'));
    const ring = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    ring.setAttribute('viewBox', '0 0 44 44');
    ring.classList.add('mine-ring');
    ring.innerHTML = `<circle cx="22" cy="22" r="19" fill="none" stroke="rgba(255,255,255,0.15)" stroke-width="2"/><circle cx="22" cy="22" r="19" fill="none" stroke="#5fe1ff" stroke-width="2.5" stroke-dasharray="119.4" stroke-dashoffset="119.4"/>`;
    r.appendChild(ring);
    this.mineRing = ring.querySelectorAll('circle')[1] as SVGCircleElement;
    this.els.ring = ring as unknown as HTMLElement;
    this.els.prompt = r.appendChild(h('div', 'prompt hud-shadow'));
    this.els.target = r.appendChild(h('div', 'target-info hud-shadow'));
    // compass
    const comp = r.appendChild(h('div', 'compass'));
    this.compassStrip = comp.appendChild(h('div', 'strip'));
    comp.appendChild(h('div', 'center'));
    this.els.heading = r.appendChild(h('div', 'heading hud-shadow'));
    // location
    const loc = r.appendChild(h('div', 'loc pnl'));
    this.els.locName = loc.appendChild(h('div', 'name'));
    this.els.locSub = loc.appendChild(h('div', 'sub'));
    this.els.locRow = loc.appendChild(h('div', 'row'));
    // objective
    this.objEl = r.appendChild(h('div', 'obj pnl'));
    this.objEl.appendChild(h('div', 'lbl', 'Objetivo'));
    this.els.objT = this.objEl.appendChild(h('div', 't'));
    this.els.objH = this.objEl.appendChild(h('div', 'h'));
    this.els.objP = this.objEl.appendChild(h('div', 'p'));
    // warnings
    this.els.warn = r.appendChild(h('div', 'warnings'));
    // vitals
    const v = r.appendChild(h('div', 'vitals pnl'));
    const bar = (key: string, icon: string, color: string) => {
      const row = v.appendChild(h('div', 'vbar'));
      row.appendChild(h('div', 'ic', icon));
      const track = row.appendChild(h('div', 'track'));
      const fill = track.appendChild(h('div', 'fill'));
      fill.style.background = color;
      const val = row.appendChild(h('div', 'val'));
      this.bars[key] = { row, fill, val };
    };
    bar('health', '✚', 'linear-gradient(90deg,#ff6b5f,#ff9b7a)');
    bar('oxygen', 'O₂', 'linear-gradient(90deg,#3fb7ff,#8fe0ff)');
    bar('energy', '⚡', 'linear-gradient(90deg,#ffb547,#ffe08a)');
    bar('integrity', '◈', 'linear-gradient(90deg,#9aa6b2,#dfe6ee)');
    bar('food', '◆', 'linear-gradient(90deg,#c8a26a,#ead2a0)');
    bar('water', '◇', 'linear-gradient(90deg,#4f8fff,#9fc6ff)');
    this.els.vrow = v.appendChild(h('div', 'vrow'));
    // hotbar
    const hb = r.appendChild(h('div', 'hotbar pnl'));
    for (let i = 0; i < 9; i++) {
      const s = hb.appendChild(h('div', 'slot'));
      s.appendChild(h('div', 'n', String(i + 1)));
      this.slots.push(s);
    }
    this.els.tool = r.appendChild(h('div', 'toolname hud-shadow'));
    this.feed = document.getElementById('toast')!;
    this.feed.className = 'feed';
    this.centerMsg = r.appendChild(h('div', 'center-msg hud-shadow'));
    this.damageEl = document.getElementById('app')!.appendChild(h('div', 'damage'));
  }

  private buildShip(): void {
    const s = this.ship;
    const e = this.shipEls;
    this.flCanvas = s.appendChild(document.createElement('canvas')) as HTMLCanvasElement;
    this.flCanvas.className = 'fl-canvas';
    // top: flight mode and destination (under the heading tape)
    const top = s.appendChild(h('div', 'fl-top'));
    e.mode = top.appendChild(h('div', 'fl-mode'));
    e.target = top.appendChild(h('div', 'fl-target'));
    // altitude info (under the altitude tape)
    const ai = s.appendChild(h('div', 'fl-altinfo'));
    e.altl = ai.appendChild(h('div', 'fl-cap'));
    e.near = ai.appendChild(h('div', 'fl-sub'));
    e.att = ai.appendChild(h('div', 'fl-sub'));
    // bottom systems strip
    const bottom = s.appendChild(h('div', 'fl-bottom'));
    // speed levels: segmented selector (keys 1-5 / mouse wheel)
    e.levels = bottom.appendChild(h('div', 'fl-lvlist'));
    const gauges = bottom.appendChild(h('div', 'fl-gauges'));
    const gauge = (key: string, label: string, color: string) => {
      const g = gauges.appendChild(h('div', 'fl-gauge'));
      const head = g.appendChild(h('div', 'gh'));
      head.appendChild(h('span', 'gl', label));
      e[key + 'V'] = head.appendChild(h('span', 'gv'));
      const t = g.appendChild(h('div', 'track'));
      const f = t.appendChild(h('div', 'fill'));
      f.style.background = color;
      e[key + 'F'] = f;
    };
    gauge('fuel', 'Combustível', 'linear-gradient(90deg,#3fb7ff,#9fe6ff)');
    gauge('hull', 'Casco', 'linear-gradient(90deg,#9aa6b2,#eef3f8)');
    gauge('temp', 'Temp. casco', 'linear-gradient(90deg,#ffb547,#ff5a4f)');
    e.status = bottom.appendChild(h('div', 'fl-pills'));
    e.warn = s.appendChild(h('div', 'fl-warn'));
    e.land = s.appendChild(h('div', 'land-ind hud-shadow'));
    e.hints = s.appendChild(h('div', 'fl-hints', '<div><span class="key">1–5</span>velocidade</div><div><span class="key">R</span>motor</div><div><span class="key">T</span>cruzeiro</div><div><span class="key">X</span>trem de pouso</div><div><span class="key">Z</span>assistência</div><div><span class="key">L</span>farol</div><div><span class="key">B</span>freio</div><div><span class="key">V</span>câmera</div><div><span class="key">M</span>mapa</div>'));
    e.nav = s.appendChild(h('div', 'navmark'));
    e.nav.innerHTML = '<div class="d"></div><span></span>';
  }

  showFoot(on: boolean): void {
    this.root.classList.toggle('on', on);
    document.getElementById('helmet')!.classList.toggle('on', on);
  }

  showShip(on: boolean): void {
    this.ship.classList.toggle('on', on);
    this.feed.classList.toggle('ship', on);
  }

  updateHotbar(inv: Inventory, sel: number): void {
    for (let i = 0; i < 9; i++) {
      const slot = this.slots[i];
      const s = inv.slots[i];
      const key = s ? `${s.id}:${s.count}:${i === sel}` : `-:${i === sel}`;
      if (slot.dataset.k === key) continue;
      slot.dataset.k = key;
      slot.classList.toggle('sel', i === sel);
      slot.querySelectorAll('img,.c').forEach((x) => x.remove());
      if (s) {
        const img = document.createElement('img');
        img.src = iconFor(s.id);
        img.alt = item(s.id).name;
        slot.appendChild(img);
        if (s.count > 1) slot.appendChild(h('div', 'c', String(s.count)));
      }
    }
  }

  updateFoot(s: FootHudState, dt: number): void {
    // compass
    const W = this.compassStrip.clientWidth || 560;
    const pxPerRad = W / (Math.PI * 0.9);
    let html = '';
    const toX = (b: number) => {
      let d = b - s.heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      return W / 2 + d * pxPerRad;
    };
    for (let deg = 0; deg < 360; deg += 15) {
      const x = toX((deg * Math.PI) / 180);
      if (x < -10 || x > W + 10) continue;
      const card = deg % 90 === 0;
      html += `<div class="tick${deg % 45 === 0 ? ' major' : ''}" style="left:${x.toFixed(1)}px"></div>`;
      if (card) html += `<div class="card" style="left:${x.toFixed(1)}px">${['N', 'L', 'S', 'O'][deg / 90]}</div>`;
      else if (deg % 45 === 0) html += `<div class="card" style="left:${x.toFixed(1)}px;font-size:10px;color:var(--dim)">${deg}</div>`;
    }
    for (const m of s.markers) {
      const x = toX(m.bearing);
      if (x < 0 || x > W) continue;
      html += `<div class="mk" style="left:${x.toFixed(1)}px;color:${m.color}" title="${m.label}">${m.glyph}</div>`;
    }
    this.compassStrip.innerHTML = html;
    const hdg = ((s.heading * 180) / Math.PI + 360) % 360;
    this.set('hdg', this.els.heading, `${String(Math.round(hdg)).padStart(3, '0')}°`);
    // location
    this.set('locName', this.els.locName, s.bodyName);
    this.set('locSub', this.els.locSub, `${s.bodyType} · ${s.weather}`);
    this.set('locRow', this.els.locRow, `<span>${s.coords}</span><span>ALT ${Math.round(s.altitude)} m</span><span>${s.timeOfDay}</span>`, true);
    // objective
    if (s.objective) {
      if (s.objective.title !== this.lastObjTitle) {
        this.lastObjTitle = s.objective.title;
        this.objEl.classList.remove('flash');
        void this.objEl.offsetWidth;
        this.objEl.classList.add('flash');
      }
      this.set('objT', this.els.objT, s.objective.title);
      this.set('objH', this.els.objH, s.objective.hint);
      this.set('objP', this.els.objP, s.objective.progress);
      this.objEl.style.display = '';
    } else this.objEl.style.display = 'none';
    // vitals
    const setBar = (k: string, v: number, max: number, shown = true) => {
      const b = this.bars[k];
      b.row.style.display = shown ? '' : 'none';
      if (!shown) return;
      const f = Math.max(0, Math.min(1, v / max));
      b.fill.style.transform = `scaleX(${f.toFixed(3)})`;
      this.set('bv' + k, b.val, String(Math.round(v)));
      b.row.classList.toggle('low', f < 0.2);
    };
    setBar('health', s.health, 100);
    setBar('oxygen', s.oxygen, s.oxygenMax);
    setBar('energy', s.energy, s.energyMax);
    setBar('integrity', s.integrity, 100);
    setBar('food', s.food ?? 0, 100, s.food !== null);
    setBar('water', s.water ?? 0, 100, s.water !== null);
    const tClass = s.ambientTemp < -40 || s.ambientTemp > 70 ? 'bad' : s.ambientTemp < 0 || s.ambientTemp > 40 ? 'warn' : '';
    const bClass = s.bodyTemp < 35.5 || s.bodyTemp > 38.8 ? 'bad' : '';
    let chips = `<span class="chip ${tClass}">EXT ${Math.round(s.ambientTemp)}°C</span><span class="chip ${bClass}">CORPO ${s.bodyTemp.toFixed(1)}°C</span>`;
    chips += `<span class="chip ${s.pressurized ? 'good' : ''}">${s.pressurized ? 'HABITAT PRESSURIZADO' : s.breathable}</span>`;
    if (s.radiation > 0.02 || s.radDose > 1) chips += `<span class="chip ${s.radDose > 60 ? 'bad' : 'warn'}">☢ ${s.radiation.toFixed(2)} · DOSE ${Math.round(s.radDose)}</span>`;
    this.set('vrow', this.els.vrow, chips, true);
    this.set('warn', this.els.warn, s.warnings.map((w) => `<span>${w}</span>`).join(''), true);
    // prompt & target
    this.els.prompt.classList.toggle('on', !!s.prompt);
    if (s.prompt) this.set('prompt', this.els.prompt, s.prompt, true);
    this.set('target', this.els.target, s.targetInfo ?? '');
    this.els.ring.classList.toggle('on', s.mineProgress > 0);
    this.mineRing.style.strokeDashoffset = String(119.4 * (1 - s.mineProgress));
    // tool label fades after selection change
    if (this.last.toolLabel !== s.toolLabel) { this.toolTimer = 2.5; }
    this.set('toolLabel', this.els.tool, s.toolLabel);
    this.toolTimer -= dt;
    this.els.tool.style.opacity = this.toolTimer > 0 ? '1' : '0';
  }

  updateShip(s: ShipHudState): void {
    const e = this.shipEls;
    this.drawFlight(s);
    this.ship.classList.toggle('cockpit', s.cockpit);
    this.set('mode', e.mode, s.mode);
    this.set('tgt', e.target, s.target ?? 'Sem destino · Mapa do Sistema (M)');
    // speed levels
    const lvHtml = s.levels.map((l, i) => {
      const max = l.max >= 1000 ? `${(l.max / 1000).toFixed(1)} km/s` : `${l.max} m/s`;
      return `<div class="lv${i === s.speedLevel && !s.cruise ? ' on' : ''}"><div class="nm"><span class="n">${i + 1}</span>${l.name}</div><div class="mx">${max}</div></div>`;
    }).join('') + `<div class="lv cr${s.cruise ? ' on' : ''}"><div class="nm"><span class="n">T</span>CRUZEIRO</div><div class="mx">${s.cruise ? 'ATIVO' : 'fora da atm.'}</div></div>`;
    this.set('lv', e.levels, lvHtml, true);
    this.set('altl', e.altl, s.altLabel);
    this.set('near', e.near, s.nearest);
    this.set('att', e.att, s.heading === null ? '' : `ARF ${s.pitchDeg >= 0 ? '+' : ''}${s.pitchDeg.toFixed(0)}° · ROL ${s.rollDeg >= 0 ? '+' : ''}${s.rollDeg.toFixed(0)}°`);
    const g = (k: string, v: number, txt: string) => {
      e[k + 'F'].style.transform = `scaleX(${Math.max(0, Math.min(1, v)).toFixed(3)})`;
      this.set('g' + k, e[k + 'V'], txt);
    };
    g('fuel', s.fuel / 100, s.unlimited ? '∞' : `${s.fuel.toFixed(0)}%`);
    g('hull', s.hull / 100, `${Math.round(s.hull)}%`);
    g('temp', (s.hullTemp - 20) / 1400, `${Math.round(s.hullTemp)}°C`);
    const pill = (state: 'on' | 'off' | 'mid', label: string) => `<span class="pill ${state}">${label}</span>`;
    this.set('st', e.status, [
      pill(s.power ? 'on' : 'off', s.power ? 'ENERGIA' : 'SEM ENERGIA'),
      pill(s.thrusters ? 'on' : 'off', s.thrusters ? 'PROPULSORES' : 'PROPULSOR AVARIADO'),
      pill(s.engine ? 'on' : 'off', s.engine ? 'MOTOR' : 'MOTOR OFF · R'),
      pill(s.assist ? 'on' : 'mid', s.assist ? 'ASSIST.' : 'ASSIST. OFF'),
      pill(s.gear ? 'on' : 'mid', s.gear ? 'TREM ▼' : 'TREM ▲'),
      s.landingLight ? pill('on', 'FAROL') : '',
      s.unlimited ? pill('on', 'EXPLORADOR') : '',
    ].join(''), true);
    this.set('swarn', e.warn, s.warnings.map((w) => `<span>${w}</span>`).join(''), true);
    this.set('land', e.land, s.landing ?? '', true);
    // nav marker
    if (s.navMarker) {
      e.nav.style.display = '';
      e.nav.style.left = `${s.navMarker.x}px`;
      e.nav.style.top = `${s.navMarker.y}px`;
      e.nav.classList.toggle('edge', s.navMarker.edge);
      this.set('navl', e.nav.querySelector('span') as HTMLElement, s.navMarker.label);
    } else e.nav.style.display = 'none';
    // body markers
    while (this.bodyMarkEls.length < s.bodyMarkers.length) this.bodyMarkEls.push(this.ship.appendChild(h('div', 'bodymark')));
    this.bodyMarkEls.forEach((el, i) => {
      const m = s.bodyMarkers[i];
      if (!m) { el.style.display = 'none'; return; }
      el.style.display = '';
      el.style.left = `${m.x}px`;
      el.style.top = `${m.y}px`;
      if (el.textContent !== m.label) el.textContent = m.label;
    });
  }

  // ------------------------------------------------------------------ flight instruments (canvas)
  private flCanvas!: HTMLCanvasElement;

  private drawFlight(s: ShipHudState): void {
    const cv = this.flCanvas;
    const W = window.innerWidth, H = window.innerHeight;
    const dpr = Math.min(1.5, window.devicePixelRatio || 1);
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
      cv.width = Math.round(W * dpr);
      cv.height = Math.round(H * dpr);
    }
    const g = cv.getContext('2d')!;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    const CY = '#5fe1ff', INK = '#e8f1f8', AMB = '#ffb547', GRN = '#7dffb0';
    const cx = W / 2, cy = H / 2;
    g.lineCap = 'round';
    g.shadowColor = 'rgba(0,0,0,0.6)';
    g.shadowBlur = 3;

    // ---------------- pitch ladder (kept clear of the heading tape and the bottom stack)
    const offT = Math.min(W * 0.31, 400);
    g.save();
    g.beginPath();
    g.rect(cx - offT + 60, 96, (offT - 60) * 2, H - 96 - 190);
    g.clip();
    g.font = '600 11px JetBrains Mono, monospace';
    g.textBaseline = 'middle';
    for (const l of s.ladder) {
      const dx = l.x2 - l.x1, dy = l.y2 - l.y1;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len, uy = dy / len;
      const mx = (l.x1 + l.x2) / 2, my = (l.y1 + l.y2) / 2;
      const gap = l.deg === 0 ? 70 : len * 0.28;
      g.strokeStyle = l.deg === 0 ? 'rgba(95,225,255,0.75)' : 'rgba(95,225,255,0.5)';
      g.lineWidth = l.deg === 0 ? 1.6 : 1.2;
      g.setLineDash(l.deg < 0 ? [6, 5] : []);
      g.beginPath();
      g.moveTo(l.x1, l.y1); g.lineTo(mx - ux * gap, my - uy * gap);
      g.moveTo(mx + ux * gap, my + uy * gap); g.lineTo(l.x2, l.y2);
      g.stroke();
      g.setLineDash([]);
      if (l.deg !== 0) {
        // end ticks point toward the horizon
        const nx = -uy * (l.deg > 0 ? 1 : -1) * 7, ny = ux * (l.deg > 0 ? 1 : -1) * 7;
        g.beginPath();
        g.moveTo(l.x1, l.y1); g.lineTo(l.x1 + nx, l.y1 + ny);
        g.moveTo(l.x2, l.y2); g.lineTo(l.x2 + nx, l.y2 + ny);
        g.stroke();
        g.fillStyle = 'rgba(95,225,255,0.75)';
        g.textAlign = 'right';
        g.fillText(String(Math.abs(l.deg)), l.x1 - ux * 8, l.y1 - uy * 8);
        g.textAlign = 'left';
        g.fillText(String(Math.abs(l.deg)), l.x2 + ux * 8, l.y2 + uy * 8);
      }
    }

    g.restore();

    // ---------------- nose (boresight) and flight path vector
    if (s.nose.visible) {
      const { x, y } = s.nose;
      g.strokeStyle = INK;
      g.lineWidth = 1.6;
      g.beginPath();
      g.moveTo(x - 22, y); g.lineTo(x - 10, y); g.lineTo(x - 5, y + 7); g.lineTo(x, y); g.lineTo(x + 5, y + 7); g.lineTo(x + 10, y); g.lineTo(x + 22, y);
      g.stroke();
    }
    if (s.vel.visible) {
      const { x, y } = s.vel;
      g.strokeStyle = GRN;
      g.lineWidth = 1.6;
      g.beginPath();
      g.arc(x, y, 7, 0, Math.PI * 2);
      g.moveTo(x - 7, y); g.lineTo(x - 18, y);
      g.moveTo(x + 7, y); g.lineTo(x + 18, y);
      g.moveTo(x, y - 7); g.lineTo(x, y - 14);
      g.stroke();
    }
    // stick input
    g.fillStyle = AMB;
    g.beginPath();
    g.arc(cx + s.stick.x * 110, cy + s.stick.y * 110, 3, 0, Math.PI * 2);
    g.fill();

    // ---------------- tapes
    const off = Math.min(W * 0.31, 400);
    const TH = Math.min(260, H * 0.42);
    const lvMax = s.levels[s.speedLevel]?.max ?? 260;
    const nice = (v: number) => {
      const p = Math.pow(10, Math.floor(Math.log10(v)));
      for (const m of [1, 2, 5, 10]) if (m * p >= v) return m * p;
      return 10 * p;
    };
    const tape = (x: number, value: number, range: number, right: boolean, fmt: (v: number) => string, unit: string, marker?: number) => {
      const upp = range / TH;
      const major = nice(range / 4), minor = major / 5;
      const top = cy - TH / 2;
      // backing
      const grd = g.createLinearGradient(x, top, x, top + TH);
      grd.addColorStop(0, 'rgba(4,10,16,0)'); grd.addColorStop(0.15, 'rgba(4,10,16,0.35)');
      grd.addColorStop(0.85, 'rgba(4,10,16,0.35)'); grd.addColorStop(1, 'rgba(4,10,16,0)');
      g.fillStyle = grd;
      g.fillRect(x - 34, top, 68, TH);
      g.save();
      g.beginPath(); g.rect(x - 40, top, 80, TH); g.clip();
      const edge = right ? x - 34 : x + 34, dir = right ? 1 : -1;
      g.strokeStyle = 'rgba(232,241,248,0.55)';
      g.fillStyle = 'rgba(232,241,248,0.7)';
      g.lineWidth = 1;
      g.textAlign = right ? 'left' : 'right';
      const v0 = Math.floor((value - range / 2) / minor) * minor;
      for (let v = v0; v <= value + range / 2; v += minor) {
        if (v < 0 && unit !== 'alt') continue;
        const y = cy - (v - value) / upp;
        const isMajor = Math.abs(v / major - Math.round(v / major)) < 1e-6;
        g.beginPath();
        g.moveTo(edge, y); g.lineTo(edge + dir * (isMajor ? 12 : 6), y);
        g.stroke();
        if (isMajor) g.fillText(fmt(v), edge + dir * 16, y);
      }
      if (marker !== undefined) {
        const y = cy - (marker - value) / upp;
        g.strokeStyle = AMB;
        g.lineWidth = 3;
        g.beginPath(); g.moveTo(edge, y); g.lineTo(edge + dir * 22, y); g.stroke();
      }
      g.restore();
      // readout
      g.fillStyle = 'rgba(4,10,16,0.82)';
      g.strokeStyle = CY;
      g.lineWidth = 1.2;
      const bw = 92, bh = 30, bx = right ? x - 34 - 8 : x + 34 + 8 - bw;
      g.beginPath();
      if (right) { g.moveTo(bx, cy); g.lineTo(bx + 8, cy - bh / 2); g.lineTo(bx + bw, cy - bh / 2); g.lineTo(bx + bw, cy + bh / 2); g.lineTo(bx + 8, cy + bh / 2); }
      else { g.moveTo(bx + bw, cy); g.lineTo(bx + bw - 8, cy - bh / 2); g.lineTo(bx, cy - bh / 2); g.lineTo(bx, cy + bh / 2); g.lineTo(bx + bw - 8, cy + bh / 2); }
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = INK;
      g.font = '700 17px JetBrains Mono, monospace';
      g.textAlign = 'center';
      g.fillText(fmt(value), bx + bw / 2 + (right ? 4 : -4), cy + 1);
      g.font = '600 11px JetBrains Mono, monospace';
    };
    const fmtSpeed = (v: number) => (Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
    const speedRange = s.cruise ? nice(Math.max(400, s.speed * 0.8)) : nice(Math.max(lvMax * 0.6, 20));
    tape(cx - off, s.speed, speedRange, false, fmtSpeed, 'spd', s.cruise ? undefined : lvMax);
    const altRange = nice(Math.max(120, s.altitude * 0.7));
    const fmtAlt = (v: number) => (Math.abs(v) >= 100000 ? `${Math.round(v / 1000)}k` : Math.abs(v) >= 10000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`);
    tape(cx + off, s.altitude, altRange, true, fmtAlt, 'alt');
    // captions + units
    g.font = '600 10px Rajdhani, sans-serif';
    g.fillStyle = 'rgba(232,241,248,0.6)';
    g.textAlign = 'center';
    g.fillText('VELOCIDADE  m/s', cx - off, cy - TH / 2 - 10);
    g.fillText('ALTITUDE  m', cx + off, cy - TH / 2 - 10);
    // throttle bar (outside the speed tape)
    const tx = cx - off - 58, tTop = cy - TH / 2 + 20, tH = TH - 40;
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(tx - 3, tTop, 6, tH);
    g.fillStyle = s.cruise ? CY : AMB;
    g.fillRect(tx - 3, tTop + tH * (1 - s.throttle), 6, tH * s.throttle);
    g.fillStyle = 'rgba(232,241,248,0.6)';
    g.font = '600 10px JetBrains Mono, monospace';
    g.fillText(`${Math.round(s.throttle * 100)}%`, tx, tTop + tH + 12);
    // vertical speed caret (inside the altitude tape)
    const vx = cx + off - 48;
    const vy = cy - Math.max(-1, Math.min(1, s.vspeed / 60)) * (TH / 2 - 16);
    g.strokeStyle = 'rgba(255,255,255,0.15)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(vx, cy - TH / 2 + 16); g.lineTo(vx, cy + TH / 2 - 16); g.stroke();
    g.fillStyle = s.vspeed < -8 ? AMB : GRN;
    g.beginPath(); g.moveTo(vx - 6, vy); g.lineTo(vx - 14, vy - 5); g.lineTo(vx - 14, vy + 5); g.closePath(); g.fill();
    g.textAlign = 'right';
    g.fillText(`${s.vspeed >= 0 ? '+' : ''}${s.vspeed.toFixed(0)}`, vx - 17, vy);

    // ---------------- heading tape
    if (s.heading !== null) {
      const hw = Math.min(220, W * 0.22), hy = 30;
      const ppd = hw / 45;
      const grd = g.createLinearGradient(cx - hw, 0, cx + hw, 0);
      grd.addColorStop(0, 'rgba(4,10,16,0)'); grd.addColorStop(0.2, 'rgba(4,10,16,0.4)');
      grd.addColorStop(0.8, 'rgba(4,10,16,0.4)'); grd.addColorStop(1, 'rgba(4,10,16,0)');
      g.fillStyle = grd;
      g.fillRect(cx - hw, hy - 16, hw * 2, 32);
      g.save();
      g.beginPath(); g.rect(cx - hw, hy - 18, hw * 2, 40); g.clip();
      const names: Record<number, string> = { 0: 'N', 45: 'NE', 90: 'L', 135: 'SE', 180: 'S', 225: 'SO', 270: 'O', 315: 'NO' };
      g.strokeStyle = 'rgba(232,241,248,0.55)';
      g.textAlign = 'center';
      for (let d = Math.floor((s.heading - 50) / 5) * 5; d <= s.heading + 50; d += 5) {
        const x = cx + (d - s.heading) * ppd;
        const dd = ((d % 360) + 360) % 360;
        const major = dd % 15 === 0;
        g.beginPath(); g.moveTo(x, hy + 14); g.lineTo(x, hy + (major ? 4 : 9)); g.stroke();
        if (major) {
          g.fillStyle = names[dd] ? AMB : 'rgba(232,241,248,0.7)';
          g.font = names[dd] ? '700 12px Rajdhani, sans-serif' : '600 10px JetBrains Mono, monospace';
          g.fillText(names[dd] ?? String(dd), x, hy - 4);
        }
      }
      g.restore();
      g.fillStyle = CY;
      g.beginPath(); g.moveTo(cx, hy + 16); g.lineTo(cx - 6, hy + 24); g.lineTo(cx + 6, hy + 24); g.closePath(); g.fill();
      g.font = '700 12px JetBrains Mono, monospace';
      g.fillText(`${String(Math.round(s.heading) % 360).padStart(3, '0')}°`, cx, hy + 34);
    }
  }

  toast(text: string, color = 'var(--ink)'): void {
    const d = h('div', 'pnl', text);
    d.style.color = color;
    this.feed.appendChild(d);
    setTimeout(() => d.classList.add('out'), 3200);
    setTimeout(() => d.remove(), 3800);
    while (this.feed.children.length > 6) this.feed.firstElementChild?.remove();
  }

  centerMessage(big: string, small = '', duration = 3.5): void {
    this.centerMsg.innerHTML = `<div class="big">${big}</div><div class="small">${small}</div>`;
    this.centerMsg.classList.add('on');
    clearTimeout((this.centerMsg as unknown as { _t: number })._t);
    (this.centerMsg as unknown as { _t: number })._t = window.setTimeout(() => this.centerMsg.classList.remove('on'), duration * 1000);
  }

  damageFlash(amount: number): void {
    const a = Math.min(0.65, amount / 25);
    this.damageEl.style.transition = 'none';
    this.damageEl.style.boxShadow = `inset 0 0 180px rgba(255,30,20,${a})`;
    requestAnimationFrame(() => {
      this.damageEl.style.transition = 'box-shadow 0.8s';
      this.damageEl.style.boxShadow = 'inset 0 0 180px rgba(255,30,20,0)';
    });
  }
}

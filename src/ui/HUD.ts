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
    e.horizon = s.appendChild(h('div', 'fl-horizon'));
    e.reticle = s.appendChild(h('div', 'fl-reticle'));
    e.stick = s.appendChild(h('div', 'fl-stick'));
    e.vel = s.appendChild(h('div', 'fl-vel', '⊕'));
    const left = s.appendChild(h('div', 'fl-left pnl'));
    left.appendChild(h('div', 'lbl', 'Velocidade'));
    e.speed = left.appendChild(h('div', 'fl-big'));
    e.vs = left.appendChild(h('div', 'fl-small'));
    e.thr = left.appendChild(h('div', 'fl-small'));
    const right = s.appendChild(h('div', 'fl-right pnl'));
    right.appendChild(h('div', 'lbl', 'Altitude'));
    e.alt = right.appendChild(h('div', 'fl-big'));
    e.altl = right.appendChild(h('div', 'fl-small'));
    e.near = right.appendChild(h('div', 'fl-small'));
    const top = s.appendChild(h('div', 'fl-top pnl'));
    e.mode = top.appendChild(h('div', 'fl-mode'));
    e.target = top.appendChild(h('div', 'fl-small'));
    e.warn = top.appendChild(h('div', 'fl-small'));
    const bottom = s.appendChild(h('div', 'fl-bottom pnl'));
    const gauge = (key: string, label: string, color: string) => {
      const g = bottom.appendChild(h('div', 'gauge'));
      g.appendChild(h('div', 'lbl', label));
      const t = g.appendChild(h('div', 'track'));
      const f = t.appendChild(h('div', 'fill'));
      f.style.background = color;
      e[key + 'F'] = f;
      e[key + 'V'] = g.appendChild(h('div', 'v'));
    };
    gauge('fuel', 'Combustível', 'linear-gradient(90deg,#3fb7ff,#9fe6ff)');
    gauge('hull', 'Integridade', 'linear-gradient(90deg,#9aa6b2,#eef3f8)');
    gauge('temp', 'Temp. casco', 'linear-gradient(90deg,#ffb547,#ff5a4f)');
    e.status = bottom.appendChild(h('div', 'fl-status'));
    e.land = s.appendChild(h('div', 'land-ind hud-shadow'));
    e.nav = s.appendChild(h('div', 'navmark'));
    e.nav.innerHTML = '<div class="d"></div><span></span>';
  }

  showFoot(on: boolean): void {
    this.root.classList.toggle('on', on);
    document.getElementById('helmet')!.classList.toggle('on', on);
  }

  showShip(on: boolean): void {
    this.ship.classList.toggle('on', on);
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
    const W = window.innerWidth, H = window.innerHeight;
    e.stick.style.left = `${W / 2 + s.stick.x * 120}px`;
    e.stick.style.top = `${H / 2 + s.stick.y * 120}px`;
    e.vel.style.display = s.vel.visible ? '' : 'none';
    e.vel.style.left = `${s.vel.x}px`;
    e.vel.style.top = `${s.vel.y}px`;
    e.horizon.style.transform = `translate(-50%, ${(-s.horizonPitch * H * 0.6).toFixed(1)}px) rotate(${(-s.horizonRoll * 180 / Math.PI).toFixed(1)}deg)`;
    e.horizon.style.display = s.horizonPitch === 999 ? 'none' : '';
    this.set('sp', e.speed, s.speed >= 10000 ? `${(s.speed / 1000).toFixed(1)}<span class="fl-unit">km/s</span>` : `${Math.round(s.speed)}<span class="fl-unit">m/s</span>`, true);
    this.set('vs', e.vs, `V/S ${s.vspeed >= 0 ? '+' : ''}${s.vspeed.toFixed(1)} m/s`);
    this.set('thr', e.thr, `EMPUXO ${Math.round(s.throttle * 100)}%`);
    const alt = s.altitude;
    this.set('alt', e.alt, alt >= 100000 ? `${(alt / 1000).toFixed(0)}<span class="fl-unit">km</span>` : alt >= 10000 ? `${(alt / 1000).toFixed(1)}<span class="fl-unit">km</span>` : `${Math.round(alt)}<span class="fl-unit">m</span>`, true);
    this.set('altl', e.altl, s.altLabel);
    this.set('near', e.near, s.nearest);
    this.set('mode', e.mode, s.mode);
    this.set('tgt', e.target, s.target ?? 'Sem destino — Mapa do Sistema (M)');
    this.set('swarn', e.warn, s.warnings.map((w) => `<span style="color:var(--red)">${w}</span>`).join(' · '), true);
    const g = (k: string, v: number, txt: string) => {
      e[k + 'F'].style.transform = `scaleX(${Math.max(0, Math.min(1, v)).toFixed(3)})`;
      this.set('g' + k, e[k + 'V'], txt);
    };
    g('fuel', s.fuel / 100, s.unlimited ? 'ILIMITADO' : `${s.fuel.toFixed(1)}%`);
    g('hull', s.hull / 100, `${Math.round(s.hull)}%`);
    g('temp', (s.hullTemp - 20) / 1400, `${Math.round(s.hullTemp)}°C`);
    const st = (on: boolean, a: string, b: string, mid = false) => `<span class="${mid ? 'mid' : on ? 'on' : 'off'}">● ${on ? a : b}</span>`;
    this.set('st', e.status, [
      st(s.power, 'ENERGIA', 'SEM ENERGIA'), st(s.thrusters, 'PROPULSORES', 'PROPULSORES AVARIADOS'), st(s.engine, 'MOTOR LIGADO', 'MOTOR DESLIGADO (R)'),
      st(s.assist, 'ASSISTÊNCIA', 'ASSIST. OFF (Z)', !s.assist), st(s.gear, 'TREM BAIXADO', 'TREM RECOLHIDO (X)', !s.gear),
      s.unlimited ? '<span class="on">● MODO EXPLORADOR</span>' : '',
    ].join(''), true);
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
    e.reticle.style.display = s.cockpit ? '' : '';
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

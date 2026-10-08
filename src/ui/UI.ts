import * as THREE from 'three';
import type { Game } from '../game/Game';
import { iconFor } from './icons';
import { item, ITEMS } from '../items/items';
import { RECIPES, canCraft, type Recipe } from '../items/recipes';
import { Inventory } from '../items/Inventory';
import { applyPreset, PRESETS, type Preset } from '../core/settings';
import { TYPE_LABEL, floraLabel } from '../universe/planetTypes';
import { fmtDist } from '../game/Pilot';
import type { Machine } from '../building/Machines';
import { ShipModel } from '../ship/ShipModel';
import { kelvinToRGB } from '../universe/systemGen';
import type { StarSummary } from '../universe/galaxy';
import { generateSystem } from '../universe/systemGen';

/**
 * Menus and terminal panels. Everything shown as a button performs a real
 * action on the game state.
 */

const h = (tag: string, cls = '', html = ''): HTMLElement => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html) e.innerHTML = html;
  return e;
};

const JUMP_RANGE = 26; // light years

export class UI {
  readonly game: Game;
  private menu: HTMLElement;
  private panels: HTMLElement;
  private terminalTab = 'inventory';
  private picked: number | null = null;
  private pickedCargo: number | null = null;
  private selRecipe: Recipe | null = null;
  private selBody: string | null = null;
  private selStar: StarSummary | null = null;
  private galaxyView = { cx: 0, cz: 0, zoom: 7 };
  private refreshTimer = 0;
  paused = false;
  private termEl: HTMLElement | null = null;

  constructor(game: Game) {
    this.game = game;
    this.menu = document.getElementById('menu')!;
    this.panels = document.getElementById('panels')!;
    window.addEventListener('keydown', (e) => this.onKey(e));
    game.canvas.addEventListener('click', () => {
      if ((game.mode === 'onfoot' || game.mode === 'ship') && !game.uiOpen) { game.input.lock(); game.audio.init(); }
    });
    setInterval(() => this.tick(), 250);
  }

  private onKey(e: KeyboardEvent): void {
    const g = this.game;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.code === 'Escape') {
      if (this.termEl) { this.closeTerminal(); e.preventDefault(); return; }
      if (this.menu.querySelector('.modal-wrap')) { this.closeModal(); return; }
    }
    if (this.termEl) {
      const keys: Record<string, string> = { Tab: 'inventory', KeyM: 'system', KeyG: 'galaxy' };
      const tab = keys[e.code];
      if (tab) {
        e.preventDefault();
        if (this.terminalTab === tab) this.closeTerminal(); else this.openTerminal(tab);
      }
    }
    void g;
  }

  private tick(): void {
    if (this.termEl && ['ship', 'suit'].includes(this.terminalTab)) this.renderTerminal();
  }

  // ------------------------------------------------------------------ main menu
  async showMainMenu(): Promise<void> {
    const g = this.game;
    const has = await g.save.hasSave('slot1');
    this.menu.innerHTML = '';
    this.menu.classList.add('on');
    const mm = h('div', 'mm');
    mm.innerHTML = `<div class="title">Horizonte<span>Sobrevivência · Exploração · Construção</span></div>`;
    const items = h('div', 'items');
    const btn = (label: string, fn: () => void, disabled = false, delay = 0) => {
      const b = h('button', 'item', label) as HTMLButtonElement;
      b.disabled = disabled;
      b.style.transitionDelay = `${0.6 + delay}s`;
      b.onclick = () => { g.audio.init(); g.audio.ui('click'); fn(); };
      b.onmouseenter = () => g.audio.ui('hover');
      items.appendChild(b);
    };
    btn('Continuar', () => void this.startContinue(), !has, 0);
    btn('Novo Jogo', () => this.newGameModal(has), false, 0.08);
    btn('Configurações', () => this.settingsModal(), false, 0.16);
    btn('Créditos', () => this.creditsModal(), false, 0.24);
    mm.appendChild(items);
    mm.appendChild(h('div', 'foot', 'WASD mover · Mouse olhar · TAB terminal · F1 controles · Clique para capturar o mouse'));
    mm.appendChild(h('div', 'info', `Sistema Aurora · Lua Kepra orbitando Thalassor<br>Renderizador WebGL2 · HDR · Dispersão atmosférica<br>v0.1 — fatia vertical`));
    this.menu.appendChild(mm);
    requestAnimationFrame(() => mm.classList.add('on'));
  }

  private hideMenu(): void {
    this.menu.classList.remove('on');
    this.menu.innerHTML = '';
  }

  private loading(on: boolean, p = 0, msg = ''): void {
    const el = document.getElementById('loading')!;
    el.classList.toggle('done', !on);
    (el.querySelector('.ld-bar i') as HTMLElement).style.width = `${Math.round(p * 100)}%`;
    (el.querySelector('.ld-step') as HTMLElement).textContent = msg;
    (el.querySelector('.ld-title') as HTMLElement).textContent = on ? 'CARREGANDO' : '';
  }

  private async startContinue(): Promise<void> {
    this.hideMenu();
    this.loading(true, 0.05, 'Lendo salvamento…');
    const ok = await this.game.continueGame((p, m) => this.loading(true, p, m));
    this.loading(false);
    if (!ok) { await this.showMainMenu(); return; }
    this.game.input.lock();
  }

  private newGameModal(hasSave: boolean): void {
    const g = this.game;
    type Mode = 'explorer' | 'standard' | 'full';
    let mode = 'standard' as Mode;
    const body = h('div');
    const intro = h('p');
    const texts = {
      explorer: 'Modo Explorador: a nave já está consertada e abastecida, nunca gasta combustível nem sofre danos, e o salto entre estrelas é livre. O traje não consome oxigênio nem energia. Ideal para voar e explorar à vontade.',
      standard: 'Você desperta após um pouso de emergência numa lua desconhecida. A nave está danificada; o ar é rarefeito. Repare os sistemas, alcance a órbita e descubra o que existe além.',
      full: 'Sobrevivência completa: como o modo Padrão, mas também é preciso comer e beber para manter a nutrição e a hidratação.',
    };
    intro.textContent = texts[mode];
    body.appendChild(intro);
    const row = h('div', 'row');
    row.innerHTML = '<label>Modo de jogo</label>';
    const seg = h('div', 'seg');
    const opts: [Mode, string][] = [['explorer', 'Explorador (fácil)'], ['standard', 'Padrão'], ['full', 'Completo (fome e sede)']];
    for (const [id, label] of opts) {
      const b = h('button', id === mode ? 'on' : '', label) as HTMLButtonElement;
      b.onclick = () => {
        mode = id;
        seg.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
        intro.textContent = texts[mode];
      };
      seg.appendChild(b);
    }
    row.appendChild(seg);
    body.appendChild(row);
    if (hasSave) body.appendChild(h('p', '', '<span style="color:var(--amber)">Atenção: o salvamento atual será substituído.</span>'));
    this.modal('Novo Jogo', body, [
      { label: 'Cancelar', fn: () => this.closeModal() },
      {
        label: 'Iniciar', primary: true, fn: async () => {
          this.closeModal();
          this.hideMenu();
          this.loading(true, 0.05, 'Preparando…');
          await g.newGame(mode === 'full', (p, m) => this.loading(true, p, m), mode === 'explorer');
          this.loading(false);
          g.input.lock();
        },
      },
    ]);
  }

  private creditsModal(): void {
    const body = h('div');
    body.innerHTML = `<p><b>Horizonte</b> — protótipo jogável de sobrevivência e exploração espacial em planetas esféricos inteiros, com terreno escavável, vegetação e fauna procedurais.</p>
      <h3>Tecnologia</h3><p>TypeScript, Three.js (WebGL2), Vite, Web Workers, IndexedDB e Web Audio API. Tipografia: Rajdhani e JetBrains Mono (SIL OFL).</p>
      <h3>Conteúdo</h3><p>Todo o universo, terrenos, texturas, modelos, música e efeitos sonoros são gerados proceduralmente em tempo de execução — nenhum arquivo de mídia externo é utilizado.</p>
      <h3>Direção</h3><p>Visual realista: terreno contínuo com materiais físicos, atmosfera com dispersão de luz, vegetação 3D e iluminação HDR.</p>`;
    this.modal('Créditos', body, [{ label: 'Fechar', fn: () => this.closeModal() }]);
  }

  // ------------------------------------------------------------------ modal helper
  private modal(title: string, body: HTMLElement, actions: { label: string; fn: () => void; primary?: boolean }[]): void {
    this.menu.querySelectorAll('.modal-wrap').forEach((e) => e.remove());
    this.menu.classList.add('on');
    const wrap = h('div', 'modal-wrap');
    const m = h('div', 'modal pnl');
    m.appendChild(h('h2', '', title));
    m.appendChild(body);
    const act = h('div', 'actions');
    for (const a of actions) {
      const b = h('button', `btn${a.primary ? ' primary' : ''}`, a.label);
      b.onclick = () => { this.game.audio.ui('click'); a.fn(); };
      act.appendChild(b);
    }
    m.appendChild(act);
    wrap.appendChild(m);
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) this.closeModal(); });
    this.menu.appendChild(wrap);
  }

  private closeModal(): void {
    this.menu.querySelectorAll('.modal-wrap').forEach((e) => e.remove());
    if (!this.menu.querySelector('.mm') && !this.menu.querySelector('.death')) this.menu.classList.remove('on');
    if (this.paused && !this.menu.querySelector('.modal-wrap')) this.openPause();
  }

  // ------------------------------------------------------------------ pause
  openPause(): void {
    const g = this.game;
    if (g.mode !== 'onfoot' && g.mode !== 'ship') return;
    this.paused = true;
    g.uiOpen = true;
    const body = h('div');
    body.innerHTML = `<p class="hint-line">Sistema ${g.universe.def.name} · ${g.universe.frame ? g.displayName(g.universe.frame.id) : 'espaço'} · ${Math.floor(g.universe.time / 60)} min de jogo</p>`;
    const list = h('div');
    list.style.display = 'flex';
    list.style.flexDirection = 'column';
    list.style.gap = '8px';
    const b = (label: string, fn: () => void, primary = false) => {
      const x = h('button', `btn${primary ? ' primary' : ''}`, label);
      x.onclick = () => { g.audio.ui('click'); fn(); };
      list.appendChild(x);
    };
    b('Retomar', () => this.resume(), true);
    b('Salvar jogo', () => void g.saveGame());
    b(`Modo Explorador: ${g.vitals.explorer ? 'LIGADO' : 'DESLIGADO'}`, () => {
      g.setExplorer(!g.vitals.explorer);
      this.openPause();
    });
    b('Configurações', () => { this.paused = false; this.settingsModal(true); });
    b('Controles', () => { this.paused = false; this.controlsModal(true); });
    b('Salvar e voltar ao menu', () => g.quitToMenu());
    body.appendChild(list);
    this.modal('Pausado', body, []);
  }

  resume(): void {
    this.paused = false;
    this.closeModal();
    this.game.uiOpen = false;
    this.game.input.lock();
  }

  // ------------------------------------------------------------------ settings
  settingsModal(fromPause = false): void {
    const g = this.game;
    const s = g.settings;
    const body = h('div');
    const tabs = h('div', 'tabs');
    const content = h('div');
    let tab = 'gfx';
    const render = () => {
      content.innerHTML = '';
      tabs.querySelectorAll('button').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.t === tab));
      const row = (label: string, ctl: HTMLElement) => {
        const r = h('div', 'row');
        r.appendChild(h('label', '', label));
        const c = h('div', 'ctl');
        c.appendChild(ctl);
        r.appendChild(c);
        content.appendChild(r);
      };
      const slider = (val: number, min: number, max: number, step: number, fmt: (v: number) => string, on: (v: number) => void) => {
        const wrap = h('div', 'ctl');
        const i = document.createElement('input');
        i.type = 'range'; i.min = String(min); i.max = String(max); i.step = String(step); i.value = String(val);
        const v = h('span', 'val', fmt(val));
        i.oninput = () => { const x = parseFloat(i.value); v.textContent = fmt(x); on(x); };
        wrap.append(i, v);
        return wrap;
      };
      const toggle = (val: boolean, on: (v: boolean) => void, a = 'Ligado', b = 'Desligado') => {
        const seg = h('div', 'seg');
        const x = h('button', val ? 'on' : '', a), y = h('button', val ? '' : 'on', b);
        x.onclick = () => { x.classList.add('on'); y.classList.remove('on'); on(true); };
        y.onclick = () => { y.classList.add('on'); x.classList.remove('on'); on(false); };
        seg.append(x, y);
        return seg;
      };
      const levels = (val: number, labels: string[], on: (v: number) => void) => {
        const seg = h('div', 'seg');
        labels.forEach((l, i) => {
          const b = h('button', i === val ? 'on' : '', l);
          b.onclick = () => { seg.querySelectorAll('button').forEach((x) => x.classList.remove('on')); b.classList.add('on'); on(i); };
          seg.appendChild(b);
        });
        return seg;
      };
      const gr = s.graphics;
      const custom = () => { gr.preset = 'custom'; };
      if (tab === 'gfx') {
        const presetSeg = h('div', 'seg');
        const names: [Preset, string][] = [['low', 'Baixo'], ['medium', 'Médio'], ['high', 'Alto'], ['ultra', 'Ultra'], ['cinematic', 'Cinematográfico']];
        for (const [p, l] of names) {
          const b = h('button', gr.preset === p ? 'on' : '', l);
          b.onclick = () => { applyPreset(gr, p); render(); };
          presetSeg.appendChild(b);
        }
        row('Predefinição', presetSeg);
        if (gr.preset === 'cinematic') content.appendChild(h('p', 'hint-line', 'Cinematográfico prioriza imagem sobre desempenho — opcional para hardware potente.'));
        row('Resolução interna', slider(gr.resolutionScale, 0.5, 1.5, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { gr.resolutionScale = v; custom(); }));
        row('Resolução dinâmica', toggle(gr.dynamicResolution, (v) => { gr.dynamicResolution = v; custom(); }));
        row('Distância de renderização', slider(gr.renderDistance, 2, 10, 1, (v) => `${v * 32} m`, (v) => { gr.renderDistance = v; custom(); }));
        row('Detalhe planetário (LOD)', slider(gr.lodDetail, 0.5, 2.5, 0.1, (v) => v.toFixed(1), (v) => { gr.lodDetail = v; custom(); }));
        row('Qualidade atmosférica', levels(gr.atmosphereQuality, ['Baixa', 'Média', 'Alta', 'Ultra'], (v) => { gr.atmosphereQuality = v; custom(); }));
        row('Sombras', levels(gr.shadows, ['Off', 'Baixa', 'Alta', 'Ultra'], (v) => { gr.shadows = v; custom(); }));
        row('Água', levels(gr.water, ['Simples', 'Média', 'Alta'], (v) => { gr.water = v; custom(); }));
        row('Bloom', toggle(gr.bloom, (v) => { gr.bloom = v; custom(); }));
        row('Pós-processamento', levels(gr.postFx, ['Mínimo', 'Leve', 'Completo', 'Filme'], (v) => { gr.postFx = v; custom(); }));
        row('Vegetação / fauna', levels(gr.vegetation, ['Baixa', 'Média', 'Alta'], (v) => { gr.vegetation = v; gr.objectDensity = [0.4, 0.75, 1][v]; custom(); }));
        row('Partículas', levels(gr.particles, ['Baixa', 'Média', 'Alta'], (v) => { gr.particles = v; custom(); }));
        row('Reflexos ambientais', toggle(gr.reflections, (v) => { gr.reflections = v; custom(); }));
        row('Anti-aliasing (FXAA)', toggle(gr.fxaa, (v) => { gr.fxaa = v; custom(); }));
        row('Campo de visão', slider(gr.fov, 55, 100, 1, (v) => `${v}°`, (v) => { gr.fov = v; }));
        row('Contador de FPS (F3)', toggle(s.showFps, (v) => { s.showFps = v; }));
        content.appendChild(h('p', 'hint-line', 'A resolução das texturas procedurais muda após reiniciar.'));
      } else if (tab === 'audio') {
        const a = s.audio;
        row('Volume geral', slider(a.master, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { a.master = v; g.audio.setVolumes(a); }));
        row('Música', slider(a.music, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { a.music = v; g.audio.setVolumes(a); }));
        row('Efeitos', slider(a.sfx, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { a.sfx = v; g.audio.setVolumes(a); }));
        row('Ambiente', slider(a.ambience, 0, 1, 0.05, (v) => `${Math.round(v * 100)}%`, (v) => { a.ambience = v; g.audio.setVolumes(a); }));
      } else {
        const c = s.controls;
        row('Sensibilidade do mouse', slider(c.sensitivity, 0.2, 3, 0.05, (v) => v.toFixed(2), (v) => { c.sensitivity = v; }));
        row('Inverter eixo Y (a pé)', toggle(c.invertY, (v) => { c.invertY = v; }));
        row('Inverter eixo Y (nave)', toggle(c.shipInvertY, (v) => { c.shipInvertY = v; }));
        row('Subir degraus automaticamente', toggle(c.autoStep, (v) => { c.autoStep = v; }));
        row('Balanço da câmera', toggle(c.headBob, (v) => { c.headBob = v; }));
        const kb = h('button', 'btn small', 'Ver mapa de teclas');
        kb.onclick = () => this.controlsModal(fromPause);
        content.appendChild(kb);
      }
    };
    for (const [t, l] of [['gfx', 'Gráficos'], ['audio', 'Áudio'], ['ctl', 'Controles']]) {
      const b = h('button', '', l);
      b.dataset.t = t;
      b.onclick = () => { tab = t; render(); };
      tabs.appendChild(b);
    }
    body.append(tabs, content);
    render();
    this.modal('Configurações', body, [
      { label: 'Restaurar padrão', fn: () => { applyPreset(s.graphics, 'high'); s.graphics.fov = 70; render(); } },
      { label: 'Aplicar', primary: true, fn: () => { g.applySettings(); this.paused = fromPause; this.closeModal(); } },
    ]);
  }

  controlsModal(fromPause = false): void {
    const body = h('div');
    const rows: [string, string][] = [
      ['W A S D', 'Mover'], ['Mouse', 'Olhar / pilotar'], ['Shift', 'Correr / pós-combustor'], ['Espaço', 'Saltar · nadar · jetpack (segurar no ar) · subir (nave)'],
      ['C / Ctrl', 'Descer (água, nave)'], ['E', 'Interagir · entrar/sair da nave'], ['R', 'Painel da nave (a pé) · ligar motores (cockpit)'],
      ['Clique esquerdo', 'Usar ferramenta (minerar, escanear, posicionar)'], ['Clique direito', 'Ação secundária (analisar, girar módulo)'],
      ['1–9 / roda', 'Barra de acesso rápido'], ['TAB', 'Terminal: inventário, fabricação, construção, traje, diário'], ['F', 'Lanterna'],
      ['V', 'Alternar 1ª / 3ª pessoa · cockpit / externa'], ['M', 'Mapa do sistema · navegação'], ['G', 'Mapa galáctico'],
      ['1–5 / roda', 'Nível de velocidade (nave): Precisão, Manobra, Normal, Rápido, Hiper'], ['Q / E', 'Rolagem (nave)'], ['X', 'Trem de pouso'], ['Z', 'Assistência de voo'], ['T', 'Motor de cruzeiro'], ['B', 'Freio'], ['L', 'Farol de pouso'],
      ['J', 'Salto interestelar (nave) · diário (a pé)'], ['F3', 'Contador de FPS'], ['Esc', 'Pausa / fechar'],
    ];
    for (const [k, d] of rows) {
      const r = h('div', 'row');
      r.innerHTML = `<label>${d}</label><span class="key">${k}</span>`;
      body.appendChild(r);
    }
    this.modal('Controles', body, [{ label: 'Fechar', fn: () => { this.paused = fromPause; this.closeModal(); } }]);
  }

  showDeath(cause: string): void {
    const g = this.game;
    this.menu.classList.add('on');
    const d = h('div', 'death');
    d.innerHTML = `<div class="big">SINAIS VITAIS PERDIDOS</div><div class="small">${cause}</div>`;
    const b = h('button', 'btn primary', 'Reativar traje de emergência');
    b.onclick = () => {
      d.remove();
      this.menu.classList.remove('on');
      g.respawn();
      g.input.lock();
    };
    d.appendChild(b);
    this.menu.appendChild(d);
  }

  // ------------------------------------------------------------------ terminal
  openTerminal(tab: string): void {
    const g = this.game;
    if (tab === 'controls') { g.uiOpen = true; g.input.unlock(); this.controlsModal(false); g.uiOpen = true; return; }
    this.terminalTab = tab;
    if (!this.termEl) {
      g.uiOpen = true;
      g.input.unlock();
      g.audio.ui('open');
      this.termEl = h('div', 'term pnl');
      this.panels.appendChild(this.termEl);
    }
    this.picked = null;
    this.pickedCargo = null;
    this.renderTerminal();
  }

  closeTerminal(): void {
    if (!this.termEl) return;
    this.termEl.remove();
    this.termEl = null;
    this.game.uiOpen = false;
    this.game.audio.ui('close');
    this.game.input.lock();
    this.game.hud.updateHotbar(this.game.inventory, this.game.hotbar);
  }

  private renderTerminal(): void {
    const g = this.game;
    const t = this.termEl;
    if (!t) return;
    const nearShip = g.mode === 'ship' || g.player.nearShip;
    const tabs: [string, string][] = [['inventory', 'Inventário'], ['craft', 'Fabricação'], ['build', 'Construção'], ['suit', 'Traje']];
    if (nearShip) tabs.push(['ship', 'Nave']);
    if (g.universe.frame && g.universe.bakes.has(g.universe.frame.id)) tabs.push(['surface', 'Superfície']);
    tabs.push(['journal', 'Diário'], ['system', 'Sistema'], ['galaxy', 'Galáxia']);
    if (this.terminalTab === 'ship' && !nearShip) this.terminalTab = 'inventory';
    t.innerHTML = '';
    const head = h('div', 'head');
    const tb = h('div', 'tabs');
    tb.style.marginBottom = '0';
    tb.style.borderBottom = 'none';
    for (const [id, label] of tabs) {
      const b = h('button', id === this.terminalTab ? 'on' : '', label);
      b.onclick = () => { g.audio.ui('click'); this.terminalTab = id; this.picked = null; this.renderTerminal(); };
      tb.appendChild(b);
    }
    head.appendChild(tb);
    const close = h('button', 'btn small', 'Fechar (Esc)');
    close.onclick = () => this.closeTerminal();
    head.appendChild(close);
    t.appendChild(head);
    const body = h('div', 'body');
    body.style.marginTop = '14px';
    t.appendChild(body);
    switch (this.terminalTab) {
      case 'inventory': this.tabInventory(body); break;
      case 'craft': this.tabCraft(body); break;
      case 'build': this.tabBuild(body); break;
      case 'suit': this.tabSuit(body); break;
      case 'ship': this.tabShip(body); break;
      case 'journal': this.tabJournal(body); break;
      case 'system': this.tabSystem(body); break;
      case 'galaxy': this.tabGalaxy(body); break;
      case 'surface': this.tabSurface(body); break;
    }
  }

  private slotEl(inv: Inventory, i: number, onClick: (i: number, e: MouseEvent) => void, picked: boolean, hot = false): HTMLElement {
    const s = inv.slots[i];
    const el = h('div', `slot${picked ? ' picked' : ''}${hot && i === this.game.hotbar ? ' sel' : ''}`);
    if (hot) el.appendChild(h('div', 'n', String(i + 1)));
    if (s) {
      const img = document.createElement('img');
      img.src = iconFor(s.id);
      el.appendChild(img);
      if (s.count > 1) el.appendChild(h('div', 'c', String(s.count)));
      el.title = item(s.id).name;
    }
    el.onmousedown = (e) => { e.preventDefault(); onClick(i, e); };
    el.oncontextmenu = (e) => e.preventDefault();
    return el;
  }

  private itemInfo(id: string | null, extra = ''): HTMLElement {
    const el = h('div', 'item-info pnl');
    if (!id) { el.innerHTML = '<div class="ds">Selecione um item. Clique para mover · clique direito para usar/instalar.</div>'; return el; }
    const d = item(id);
    const kind: Record<string, string> = { resource: 'Recurso', block: 'Bloco', component: 'Componente', tool: 'Ferramenta', consumable: 'Consumível', machine: 'Módulo de base', upgrade: 'Melhoria' };
    el.innerHTML = `<div class="lbl">${kind[d.kind]}</div><div class="nm">${d.name}</div><div class="ds">${d.desc}</div>${extra}`;
    return el;
  }

  private tabInventory(body: HTMLElement): void {
    const g = this.game;
    const inv = g.inventory;
    const col = h('div', 'col');
    col.appendChild(h('div', 'lbl', 'Barra de acesso rápido'));
    const hot = h('div', 'grid');
    hot.style.margin = '6px 0 14px';
    const click = (i: number, e: MouseEvent) => {
      const s = inv.slots[i];
      if (e.button === 2 && s) {
        const d = item(s.id);
        if (d.kind === 'consumable') g.consume(s.id);
        else if (d.kind === 'upgrade') g.installUpgrade(s.id);
        this.renderTerminal();
        return;
      }
      if (this.picked === null) { if (s) this.picked = i; }
      else { inv.move(this.picked, i); this.picked = null; g.audio.ui('click'); }
      this.renderTerminal();
    };
    for (let i = 0; i < 9; i++) hot.appendChild(this.slotEl(inv, i, click, this.picked === i, true));
    col.appendChild(hot);
    col.appendChild(h('div', 'lbl', 'Mochila'));
    const grid = h('div', 'grid');
    grid.style.marginTop = '6px';
    for (let i = 9; i < inv.slots.length; i++) grid.appendChild(this.slotEl(inv, i, click, this.picked === i));
    col.appendChild(grid);
    const pid = this.picked !== null ? inv.slots[this.picked]?.id ?? null : null;
    col.appendChild(this.itemInfo(pid));
    body.appendChild(col);
    const side = h('div', 'side');
    const v = g.vitals;
    side.innerHTML = `<div class="pnl" style="padding:14px"><div class="lbl">Resumo</div>
      <div class="kv" style="margin-top:8px"><div>Itens</div><div>${inv.slots.filter(Boolean).length}/${inv.slots.length} espaços</div>
      <div>Oxigênio</div><div>${Math.round(v.oxygen)}/${v.oxygenMax}</div><div>Energia</div><div>${Math.round(v.energy)}/${v.energyMax}</div>
      <div>Fabricador</div><div>${g.nearFabricator() ? '<span style="color:var(--green)">ao alcance</span>' : 'distante'}</div></div></div>
      <p class="hint-line">Dica: arraste itens para a barra (1–9). Blocos e módulos selecionados na barra são posicionados com o clique esquerdo.</p>`;
    body.appendChild(side);
  }

  private tabCraft(body: HTMLElement): void {
    const g = this.game;
    const inv = g.inventory;
    const near = g.nearFabricator();
    const list = h('div', 'col recipes');
    list.style.flex = '1';
    let cat = '';
    for (const r of RECIPES) {
      if (r.category !== cat) { cat = r.category; list.appendChild(h('div', 'cat', cat)); }
      const ok = canCraft(inv, r, near).ok;
      const el = h('div', `recipe${this.selRecipe === r ? ' sel' : ''}${ok ? '' : ' na'}`);
      const img = document.createElement('img');
      img.src = iconFor(r.out);
      el.appendChild(img);
      const mid = h('div');
      mid.appendChild(h('div', 'nm', `${item(r.out).name}${r.count > 1 ? ` ×${r.count}` : ''}`));
      mid.appendChild(h('div', 'in', r.inputs.map(([id, n]) => `<span class="${inv.count(id) >= n ? 'ok' : 'no'}">${item(id).name} ${inv.count(id)}/${n}</span>`).join(' · ')));
      el.appendChild(mid);
      el.appendChild(h('div', 'lbl', r.station === 'fabricator' ? (near ? 'Fabricador ✓' : 'Fabricador') : 'Traje'));
      el.onclick = () => { this.selRecipe = r; g.audio.ui('hover'); this.renderTerminal(); };
      list.appendChild(el);
    }
    body.appendChild(list);
    const side = h('div', 'side');
    const r = this.selRecipe;
    if (r) {
      side.appendChild(this.itemInfo(r.out, `<div class="hint-line" style="margin-top:8px">Estação: ${r.station === 'fabricator' ? 'Fabricador (até 6 m)' : 'micro-fabricador do traje'}</div>`));
      const bar = h('div', 'craftbar');
      const fill = h('i');
      bar.appendChild(fill);
      const b1 = h('button', 'btn primary', 'Fabricar');
      const b5 = h('button', 'btn', 'Fabricar ×5');
      const run = (n: number) => {
        let k = 0;
        const step = () => {
          if (k >= n || !this.termEl) { this.renderTerminal(); return; }
          if (!canCraft(inv, r, g.nearFabricator()).ok) { g.craft(r); this.renderTerminal(); return; }
          let t = 0;
          const iv = setInterval(() => {
            t += 0.05;
            fill.style.width = `${Math.min(100, (t / (r.time * 0.5)) * 100)}%`;
            if (t >= r.time * 0.5) {
              clearInterval(iv);
              g.craft(r);
              k++;
              fill.style.width = '0%';
              step();
            }
          }, 50);
        };
        step();
      };
      b1.onclick = () => run(1);
      b5.onclick = () => run(5);
      const act = h('div');
      act.style.display = 'flex';
      act.style.gap = '8px';
      act.append(b1, b5);
      side.append(bar, act);
    } else side.appendChild(this.itemInfo(null));
    side.appendChild(h('p', 'hint-line', near ? 'Fabricador ao alcance: receitas avançadas disponíveis.' : 'Receitas marcadas “Fabricador” exigem estar a até 6 m de um Fabricador instalado.'));
    body.appendChild(side);
  }

  private tabBuild(body: HTMLElement): void {
    const g = this.game;
    const inv = g.inventory;
    const col = h('div', 'col recipes');
    col.style.flex = '1';
    col.appendChild(h('div', 'cat', 'Peças disponíveis no inventário'));
    const ids = new Set<string>();
    for (const s of inv.slots) if (s && (item(s.id).kind === 'block' || item(s.id).kind === 'machine')) ids.add(s.id);
    if (!ids.size) col.appendChild(h('p', 'hint-line', 'Nenhuma peça. Fabrique blocos e módulos na aba Fabricação.'));
    for (const id of ids) {
      const el = h('div', 'recipe');
      const img = document.createElement('img');
      img.src = iconFor(id);
      el.appendChild(img);
      const mid = h('div');
      mid.appendChild(h('div', 'nm', item(id).name));
      mid.appendChild(h('div', 'in', item(id).desc));
      el.appendChild(mid);
      el.appendChild(h('div', 'lbl', `×${inv.count(id)}`));
      el.onclick = () => {
        // move into the selected hotbar slot and start building
        const from = inv.slots.findIndex((s) => s?.id === id);
        if (from >= 0) inv.swap(from, g.hotbar);
        g.audio.ui('click');
        this.closeTerminal();
        g.toast(`${item(id).name} pronto — clique para posicionar${item(id).kind === 'machine' ? ' · clique direito gira' : ''}`, 'var(--cyan)');
      };
      col.appendChild(el);
    }
    body.appendChild(col);
    const side = h('div', 'side');
    side.innerHTML = `<div class="pnl" style="padding:14px"><div class="lbl">Sistemas de base</div><p class="hint-line" style="line-height:1.6">
      • Painéis solares geram energia de dia; baterias armazenam para a noite.<br>
      • Máquinas a até 40 m formam uma rede elétrica.<br>
      • Um habitat fechado (paredes, piso, teto, porta) com Gerador de O₂ energizado fica pressurizado: ar respirável, 21 °C, recarga de oxigênio.<br>
      • Estação de Recarga repõe energia (e O₂ se houver gerador na rede).<br>
      • O extrator recolhe módulos de volta ao inventário.</p></div>`;
    body.appendChild(side);
  }

  private tabSuit(body: HTMLElement): void {
    const g = this.game;
    const v = g.vitals;
    const col = h('div', 'col');
    col.style.flex = '1';
    const bar = (label: string, val: number, max: number, color: string) => `<div class="lbl">${label} · ${Math.round(val)}/${max}</div><div class="bar2"><i style="background:${color};transform:scaleX(${Math.max(0, Math.min(1, val / max))})"></i></div>`;
    let html = '<div class="pnl" style="padding:16px">';
    html += bar('Vida', v.health, 100, '#ff6b5f') + bar('Oxigênio', v.oxygen, v.oxygenMax, '#5fc8ff') + bar('Energia', v.energy, v.energyMax, '#ffc34d') + bar('Integridade do traje', v.integrity, 100, '#dfe6ee');
    html += `<div class="kv"><div>Temp. corporal</div><div>${v.bodyTemp.toFixed(1)} °C ${v.regulating ? '' : '<span style="color:var(--amber)">(sem regulação)</span>'}</div>
      <div>Faixa térmica</div><div>${v.tempRange[0]} °C a ${v.tempRange[1]} °C</div><div>Dose de radiação</div><div>${v.radiation.toFixed(1)}</div>
      ${v.fullSurvival ? `<div>Nutrição</div><div>${Math.round(v.food)}%</div><div>Hidratação</div><div>${Math.round(v.water)}%</div>` : ''}</div></div>`;
    col.innerHTML = html;
    col.appendChild(h('div', 'cat', 'Melhorias'));
    const ups: [keyof typeof v.upgrades, string][] = [['extractorMk2', 'extractor_mk2'], ['jetpack', 'jetpack'], ['thermal', 'thermal_lining'], ['radShield', 'rad_shield'], ['o2Tank', 'o2_tank'], ['batteryPack', 'battery_pack']];
    for (const [k, id] of ups) {
      const el = h('div', 'recipe');
      const img = document.createElement('img');
      img.src = iconFor(id);
      el.appendChild(img);
      const mid = h('div');
      mid.appendChild(h('div', 'nm', item(id).name));
      mid.appendChild(h('div', 'in', item(id).desc));
      el.appendChild(mid);
      if (v.upgrades[k]) el.appendChild(h('div', 'lbl', '<span style="color:var(--green)">Instalado</span>'));
      else if (g.inventory.has(id)) {
        const b = h('button', 'btn small primary', 'Instalar');
        b.onclick = () => { g.installUpgrade(id); this.renderTerminal(); };
        el.appendChild(b);
      } else el.appendChild(h('div', 'lbl', 'Fabricar'));
      col.appendChild(el);
    }
    body.appendChild(col);
    const side = h('div', 'side');
    side.appendChild(h('div', 'lbl', 'Personalização do traje'));
    const palettes: Record<string, string[]> = {
      primary: ['#e9e7e2', '#cfd4da', '#f2efe6', '#9aa3ad', '#2e3238', '#c7b79a', '#a33a2a', '#2f5a7a'],
      secondary: ['#3b3f45', '#1f2226', '#5a5f66', '#6b4f39', '#2a3a4a', '#4a2a2a'],
      accent: ['#ea7a2c', '#3fb7ff', '#7dffb0', '#ffd166', '#ff5a6e', '#c49bff', '#ffffff'],
      visor: ['#b8862a', '#16130e', '#0a1016', '#5a6a7a', '#20101a'],
    };
    const labels: Record<string, string> = { primary: 'Cor principal', secondary: 'Cor secundária', accent: 'Detalhes', visor: 'Visor' };
    const variant = (label: string, key: 'helmet' | 'pack', names: string[]) => {
      side.appendChild(h('div', 'hint-line', label));
      const seg = h('div', 'seg');
      names.forEach((n, i) => {
        const b = h('button', (g.suit[key] ?? 0) === i ? 'on' : '', n);
        b.onclick = () => { g.setSuit({ ...g.suit, [key]: i }); this.renderTerminal(); };
        seg.appendChild(b);
      });
      side.appendChild(seg);
    };
    variant('Capacete', 'helmet', ['Clássico', 'Expedição']);
    variant('Mochila de suporte vital', 'pack', ['Padrão', 'Tanques duplos']);
    for (const key of Object.keys(palettes) as ('primary' | 'secondary' | 'accent' | 'visor')[]) {
      side.appendChild(h('div', 'hint-line', labels[key]));
      const sw = h('div', 'swatches');
      for (const c of palettes[key]) {
        const s = h('div', `sw${g.suit[key] === c ? ' on' : ''}`);
        s.style.background = c;
        s.onclick = () => { g.setSuit({ ...g.suit, [key]: c }); this.renderTerminal(); };
        sw.appendChild(s);
      }
      side.appendChild(sw);
    }
    side.appendChild(h('p', 'hint-line', 'Visualize em 3ª pessoa (V). Todas as variações usam o mesmo esqueleto e animações.'));
    body.appendChild(side);
  }

  private tabShip(body: HTMLElement): void {
    const g = this.game;
    const s = g.pilot.ship;
    const col = h('div', 'col');
    col.style.flex = '1';
    const bar = (label: string, val: number, color: string, txt: string) => `<div class="lbl">${label} · ${txt}</div><div class="bar2"><i style="background:${color};transform:scaleX(${Math.max(0, Math.min(1, val))})"></i></div>`;
    const status = h('div', 'pnl');
    status.style.padding = '16px';
    status.innerHTML = `<div class="lbl">${s.name} · exploradora classe Arandu</div><div style="height:8px"></div>` +
      bar('Integridade do casco', s.hull / 100, '#dfe6ee', `${Math.round(s.hull)}%`) + bar('Combustível', s.fuel / 100, '#5fc8ff', `${s.fuel.toFixed(1)}%`) +
      bar('Reserva de O₂', s.o2Reserve / 800, '#8fe0ff', `${Math.round(s.o2Reserve)}`) +
      `<div class="kv"><div>Energia</div><div>${s.powerOnline ? '<span style="color:var(--green)">online</span>' : '<span style="color:var(--red)">offline</span>'}</div>
      <div>Propulsores</div><div>${s.thrustersOnline ? '<span style="color:var(--green)">operacionais</span>' : '<span style="color:var(--red)">avariados</span>'}</div>
      <div>Motor de dobra</div><div>${s.warpCore ? '<span style="color:var(--green)">instalado</span>' : 'ausente'}</div>
      <div>Células de dobra</div><div>${g.inventory.count('warp_cell') + s.cargo.count('warp_cell')}</div></div>`;
    col.appendChild(status);
    const act = (label: string, need: string | null, fn: () => void, done: boolean) => {
      const el = h('div', 'recipe');
      const img = document.createElement('img');
      img.src = iconFor(need ?? 'o2_canister');
      el.appendChild(img);
      const mid = h('div');
      mid.appendChild(h('div', 'nm', label));
      mid.appendChild(h('div', 'in', need ? `Requer ${item(need).name} (${g.inventory.count(need)} no inventário)` : 'Usa as reservas da nave'));
      el.appendChild(mid);
      const b = h('button', `btn small${done ? '' : ' primary'}`, done ? 'Concluído' : 'Executar') as HTMLButtonElement;
      b.disabled = done || (!!need && !g.inventory.has(need));
      b.onclick = () => { fn(); this.renderTerminal(); };
      el.appendChild(b);
      col.appendChild(el);
    };
    col.appendChild(h('div', 'cat', 'Reparos e sistemas'));
    act('Reparar casco (+50%)', 'hull_patch', () => g.shipAction('hull'), s.hull >= 100);
    act('Instalar célula de energia', 'power_cell', () => g.shipAction('power'), s.powerOnline);
    act('Substituir acoplamento do propulsor', 'thruster_coupling', () => g.shipAction('thruster'), s.thrustersOnline);
    act('Reabastecer (+25%)', 'fuel_cell', () => g.shipAction('fuel'), s.fuel >= 100);
    act('Instalar núcleo de dobra', 'warp_core', () => g.shipAction('warp_core'), s.warpCore);
    act('Reabastecer traje (O₂ e energia)', null, () => g.shipAction('refill'), false);
    body.appendChild(col);
    // cargo transfer
    const side = h('div', 'side');
    side.style.width = '560px';
    side.appendChild(h('div', 'lbl', 'Compartimento de carga — clique para transferir'));
    const cg = h('div', 'grid');
    cg.style.gridTemplateColumns = 'repeat(8, 58px)';
    for (let i = 0; i < s.cargo.slots.length; i++) cg.appendChild(this.slotEl(s.cargo, i, (k) => {
      const st = s.cargo.slots[k];
      if (!st) return;
      const left = g.inventory.add(st.id, st.count);
      s.cargo.takeFromSlot(k, st.count - left);
      g.audio.ui('click');
      this.renderTerminal();
    }, false));
    side.appendChild(cg);
    side.appendChild(h('div', 'lbl', 'Inventário'));
    const ig = h('div', 'grid');
    ig.style.gridTemplateColumns = 'repeat(9, 58px)';
    for (let i = 0; i < g.inventory.slots.length; i++) ig.appendChild(this.slotEl(g.inventory, i, (k) => {
      const st = g.inventory.slots[k];
      if (!st || item(st.id).kind === 'tool') return;
      const left = s.cargo.add(st.id, st.count);
      g.inventory.takeFromSlot(k, st.count - left);
      g.audio.ui('click');
      this.renderTerminal();
    }, false));
    side.appendChild(ig);
    body.appendChild(side);
  }

  private tabJournal(body: HTMLElement): void {
    const g = this.game;
    const col = h('div', 'col');
    col.style.flex = '1';
    const obj = g.campaign.current;
    col.appendChild(h('div', 'cat', 'Objetivo atual'));
    col.appendChild(h('div', 'entry', `<div class="t">${obj.title}</div><div class="x">${obj.hint}</div>`));
    col.appendChild(h('div', 'cat', `Diário de exploração (${g.discoveries.length})`));
    if (!g.discoveries.length) col.appendChild(h('p', 'hint-line', 'Nenhum registro ainda.'));
    for (const d of g.discoveries) {
      const kind: Record<string, string> = { system: 'Sistema', body: 'Corpo celeste', resource: 'Recurso', species: 'Espécie', structure: 'Estrutura', note: 'Nota' };
      col.appendChild(h('div', 'entry', `<div class="lbl">${kind[d.kind]}</div><div class="t">${d.title}</div><div class="x">${d.text}</div><div class="tm">${new Date(d.time).toLocaleString('pt-BR')}</div>`));
    }
    body.appendChild(col);
    const side = h('div', 'side');
    const st = g.stats;
    side.innerHTML = `<div class="pnl" style="padding:14px"><div class="lbl">Estatísticas</div><div class="kv" style="margin-top:8px">
      <div>Blocos minerados</div><div>${st.mined ?? 0}</div><div>Blocos posicionados</div><div>${st.placed ?? 0}</div><div>Itens fabricados</div><div>${st.crafted ?? 0}</div>
      <div>Saltos de dobra</div><div>${st.jumps ?? 0}</div><div>Sistemas visitados</div><div>${g.visitedSystems.length}</div></div></div>`;
    body.appendChild(side);
  }

  // ------------------------------------------------------------------ system map
  private tabSystem(body: HTMLElement): void {
    const g = this.game;
    const u = g.universe;
    const canvas = document.createElement('canvas');
    canvas.className = 'mapcanvas';
    body.appendChild(canvas);
    const side = h('div', 'side');
    body.appendChild(side);
    const W = () => canvas.clientWidth, Hh = () => canvas.clientHeight;
    const maxR = Math.max(...u.system.bodies.filter((b) => !b.parent).map((b) => b.def.orbit.radius));
    const map = (r: number) => (Math.log(1 + r / 60000) / Math.log(1 + maxR / 60000)) * (Math.min(W(), Hh()) * 0.45);
    const posOf = new Map<string, [number, number]>();
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = W() * dpr; canvas.height = Hh() * dpr;
      const c = canvas.getContext('2d')!;
      c.scale(dpr, dpr);
      const cx = W() / 2, cy = Hh() / 2;
      c.clearRect(0, 0, W(), Hh());
      // star
      const sc = u.def.star.color;
      const grd = c.createRadialGradient(cx, cy, 2, cx, cy, 30);
      grd.addColorStop(0, `rgba(${sc[0] * 255},${sc[1] * 255},${sc[2] * 255},1)`);
      grd.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = grd;
      c.beginPath(); c.arc(cx, cy, 30, 0, Math.PI * 2); c.fill();
      // habitable zone
      c.strokeStyle = 'rgba(125,255,176,0.12)';
      c.lineWidth = Math.max(2, map(u.def.star.habitableOuter * 420000) - map(u.def.star.habitableInner * 420000));
      c.beginPath(); c.arc(cx, cy, (map(u.def.star.habitableOuter * 420000) + map(u.def.star.habitableInner * 420000)) / 2, 0, Math.PI * 2); c.stroke();
      posOf.clear();
      for (const b of u.system.bodies) {
        if (b.parent) continue;
        const r = map(b.def.orbit.radius);
        c.strokeStyle = 'rgba(160,220,255,0.15)';
        c.lineWidth = 1;
        c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
        const ang = Math.atan2(-b.pos.z, b.pos.x);
        const x = cx + Math.cos(ang) * r, y = cy - Math.sin(ang) * r;
        posOf.set(b.id, [x, y]);
        const moons = u.system.bodies.filter((m) => m.parent === b);
        moons.forEach((m, i) => {
          const mr = 14 + i * 9;
          c.strokeStyle = 'rgba(160,220,255,0.12)';
          c.beginPath(); c.arc(x, y, mr, 0, Math.PI * 2); c.stroke();
          const rel = m.pos.clone().sub(b.pos);
          const ma = Math.atan2(-rel.z, rel.x);
          const mx = x + Math.cos(ma) * mr, my = y - Math.sin(ma) * mr;
          posOf.set(m.id, [mx, my]);
        });
      }
      for (const b of u.system.bodies) {
        const p = posOf.get(b.id)!;
        const size = b.def.type === 'gas_giant' ? 8 : b.def.kind === 'moon' ? 3.5 : 5;
        const col = bodyColor(b.def.type);
        c.fillStyle = col;
        c.beginPath(); c.arc(p[0], p[1], size, 0, Math.PI * 2); c.fill();
        if (b.def.rings) { c.strokeStyle = 'rgba(220,200,170,0.6)'; c.beginPath(); c.ellipse(p[0], p[1], size * 2, size * 0.7, -0.3, 0, Math.PI * 2); c.stroke(); }
        const discovered = g.discoveries.some((d) => d.id === b.id && d.systemId === u.def.id);
        c.fillStyle = b.id === this.selBody ? '#fff' : discovered ? 'rgba(232,241,248,0.85)' : 'rgba(232,241,248,0.4)';
        c.font = '600 12px Rajdhani, sans-serif';
        c.fillText(g.displayName(b.id) + (discovered ? '' : ' ?'), p[0] + size + 4, p[1] - size - 2);
        if (b.id === g.navTarget) { c.strokeStyle = '#5fe1ff'; c.lineWidth = 1.5; c.strokeRect(p[0] - size - 5, p[1] - size - 5, size * 2 + 10, size * 2 + 10); }
        if (b.id === this.selBody) { c.strokeStyle = '#ffb547'; c.beginPath(); c.arc(p[0], p[1], size + 7, 0, Math.PI * 2); c.stroke(); }
      }
      if (u.station && u.stationHost && posOf.has(u.stationHost.id)) {
        const [hx, hy] = posOf.get(u.stationHost.id)!;
        c.strokeStyle = '#5fe1ff';
        c.beginPath(); c.moveTo(hx + 14, hy - 10); c.lineTo(hx + 18, hy - 6); c.lineTo(hx + 14, hy - 2); c.lineTo(hx + 10, hy - 6); c.closePath(); c.stroke();
        c.fillStyle = 'rgba(95,225,255,0.8)';
        c.font = '11px Rajdhani, sans-serif';
        c.fillText('Estação', hx + 21, hy - 3);
      }
      // ship
      const shipSys = u.system.posToSystem(u.frame, g.mode === 'ship' ? g.pilot.ship.pos : g.player.pos, new THREE.Vector3());
      let sx: number, sy: number;
      if (u.frame && posOf.has(u.frame.id)) { [sx, sy] = posOf.get(u.frame.id)!; sx += 6; sy -= 6; }
      else { const r = map(shipSys.length()); const a = Math.atan2(-shipSys.z, shipSys.x); sx = cx + Math.cos(a) * r; sy = cy - Math.sin(a) * r; }
      c.fillStyle = '#ea7a2c';
      c.beginPath(); c.moveTo(sx, sy - 7); c.lineTo(sx + 5, sy + 5); c.lineTo(sx - 5, sy + 5); c.closePath(); c.fill();
      c.fillStyle = 'rgba(232,241,248,0.5)';
      c.font = '11px JetBrains Mono, monospace';
      c.fillText('VOCÊ', sx + 8, sy + 4);
      c.fillText(`Sistema ${u.def.name} · ${u.def.star.label} ${u.def.star.spectral} · escala logarítmica`, 14, Hh() - 14);
    };
    const renderSide = () => {
      side.innerHTML = '';
      const id = this.selBody;
      const b = id ? u.system.body(id) : null;
      if (!b) {
        side.innerHTML = `<div class="pnl" style="padding:14px"><div class="lbl">Navegação</div><p class="hint-line" style="line-height:1.6">Clique num corpo celeste para ver detalhes e defini-lo como destino. Em voo, o marcador ◇ indica a direção; use o motor de cruzeiro (T) fora da atmosfera.</p></div>`;
        return;
      }
      const d = b.def;
      const key = `${u.def.id}:${b.id}`;
      const discovered = g.discoveries.some((x) => x.id === b.id && x.systemId === u.def.id);
      const pos = u.system.posToSystem(u.frame, g.mode === 'ship' ? g.pilot.ship.pos : g.player.pos, new THREE.Vector3());
      const dist = Math.max(0, b.pos.distanceTo(pos) - b.radius);
      const p = h('div', 'pnl');
      p.style.padding = '14px';
      p.innerHTML = `<div class="lbl">${TYPE_LABEL[d.type]}${d.kind === 'moon' ? ' · lua' : ''}</div><div style="font-size:22px;font-weight:700;margin:4px 0">${g.displayName(b.id)}</div>
        <div class="kv"><div>Distância</div><div>${fmtDist(dist)}</div><div>Raio</div><div>${fmtDist(d.radius)}</div><div>Gravidade</div><div>${d.gravity.toFixed(1)} m/s²</div>
        <div>Temperatura</div><div>${Math.round(d.temperature)} °C</div><div>Atmosfera</div><div>${d.atmosphere ? `${d.atmosphere.composition} · ${d.atmosphere.pressure.toFixed(2)} atm` : 'nenhuma'}</div>
        <div>Respirável</div><div>${d.atmosphere ? Math.round(d.atmosphere.breathable * 100) + '%' : '0%'}</div><div>Vida</div><div>${d.gen ? floraLabel(d.gen.flora) : '—'}</div>
        <div>Dia</div><div>${Math.round(d.rotation.period / 60)} min</div><div>Recursos</div><div>${discovered ? d.resources.slice(0, 7).join(', ') : 'desconhecidos — visite ou escaneie'}</div></div>
        <p class="hint-line" style="margin-top:10px;line-height:1.5">${discovered ? d.description : 'Dados preliminares obtidos por telescópio.'}</p>`;
      side.appendChild(p);
      const row = h('div');
      row.style.display = 'flex'; row.style.gap = '8px'; row.style.flexWrap = 'wrap';
      const b1 = h('button', 'btn primary', g.navTarget === b.id ? 'Destino definido ✓' : 'Definir destino');
      b1.onclick = () => { g.setNavTarget(b.id); g.audio.ui('click'); draw(); renderSide(); };
      const b2 = h('button', 'btn', 'Renomear');
      b2.onclick = () => this.renamePrompt(key, g.displayName(b.id), () => { draw(); renderSide(); });
      row.append(b1, b2);
      if (g.navTarget) {
        const b3 = h('button', 'btn small', 'Limpar destino');
        b3.onclick = () => { g.setNavTarget(null); draw(); renderSide(); };
        row.appendChild(b3);
      }
      side.appendChild(row);
    };
    canvas.onclick = (e) => {
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best: string | null = null, bd = 22;
      for (const [id, p] of posOf) { const d = Math.hypot(p[0] - x, p[1] - y); if (d < bd) { bd = d; best = id; } }
      this.selBody = best;
      g.audio.ui('hover');
      draw();
      renderSide();
    };
    requestAnimationFrame(() => { draw(); renderSide(); });
  }

  private renamePrompt(key: string, current: string, done: () => void): void {
    const g = this.game;
    const body = h('div');
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.value = current;
    inp.maxLength = 32;
    inp.style.width = '100%';
    body.appendChild(h('p', '', 'O nome é salvo apenas neste jogo; o conteúdo do corpo celeste continua determinado pela semente.'));
    body.appendChild(inp);
    const wrap = h('div', 'modal-wrap');
    const m = h('div', 'modal pnl');
    m.style.width = '420px';
    m.appendChild(h('h2', '', 'Renomear'));
    m.appendChild(body);
    const act = h('div', 'actions');
    const ok = h('button', 'btn primary', 'Salvar');
    const cancel = h('button', 'btn', 'Cancelar');
    const finish = (save: boolean) => {
      if (save) { g.rename(key, inp.value); void g.saveGame(true); }
      wrap.remove();
      done();
    };
    ok.onclick = () => finish(true);
    cancel.onclick = () => finish(false);
    inp.onkeydown = (e) => { if (e.key === 'Enter') finish(true); e.stopPropagation(); };
    act.append(cancel, ok);
    m.appendChild(act);
    wrap.appendChild(m);
    this.panels.appendChild(wrap);
    setTimeout(() => inp.focus(), 50);
  }

  // ------------------------------------------------------------------ surface map
  private tabSurface(body: HTMLElement): void {
    const g = this.game;
    const u = g.universe;
    const frame = u.frame;
    const bake = frame ? u.bakes.get(frame.id) : undefined;
    if (!frame || !bake) { body.appendChild(h('p', 'hint-line', 'Mapa indisponível.')); return; }
    const canvas = document.createElement('canvas');
    canvas.className = 'mapcanvas';
    body.appendChild(canvas);
    const side = h('div', 'side');
    body.appendChild(side);
    // equirect image from the planet bake (water rendered as deep blue)
    const img = document.createElement('canvas');
    img.width = bake.width; img.height = bake.height;
    const ictx = img.getContext('2d')!;
    const id = ictx.createImageData(bake.width, bake.height);
    for (let i = 0; i < bake.width * bake.height; i++) {
      const water = bake.data[i * 4 + 3] === 0;
      const hgt = bake.data[i * 4 + 3] / 255;
      const shade = water ? 1 : 0.75 + hgt * 0.5;
      id.data[i * 4] = water ? 18 : Math.min(255, bake.data[i * 4] * shade);
      id.data[i * 4 + 1] = water ? 44 : Math.min(255, bake.data[i * 4 + 1] * shade);
      id.data[i * 4 + 2] = water ? 72 : Math.min(255, bake.data[i * 4 + 2] * shade);
      id.data[i * 4 + 3] = 255;
    }
    ictx.putImageData(id, 0, 0);
    const toLL = (p: THREE.Vector3) => {
      const d = p.clone().normalize();
      return [Math.atan2(-d.z, d.x), Math.asin(THREE.MathUtils.clamp(d.y, -1, 1))] as const;
    };
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const W = canvas.clientWidth, H = canvas.clientHeight;
      canvas.width = W * dpr; canvas.height = H * dpr;
      const c = canvas.getContext('2d')!;
      c.scale(dpr, dpr);
      const mw = Math.min(W, H * 2) - 20, mh = mw / 2;
      const ox = (W - mw) / 2, oy = (H - mh) / 2;
      c.imageSmoothingEnabled = true;
      c.drawImage(img, ox, oy, mw, mh);
      c.strokeStyle = 'rgba(160,220,255,0.12)';
      for (let k = 1; k < 12; k++) { c.beginPath(); c.moveTo(ox + (mw * k) / 12, oy); c.lineTo(ox + (mw * k) / 12, oy + mh); c.stroke(); }
      for (let k = 1; k < 6; k++) { c.beginPath(); c.moveTo(ox, oy + (mh * k) / 6); c.lineTo(ox + mw, oy + (mh * k) / 6); c.stroke(); }
      const mark = (p: THREE.Vector3, color: string, label: string, shape: 'tri' | 'dot' | 'dia') => {
        const [lon, lat] = toLL(p);
        const x = ox + (lon / (2 * Math.PI) + 0.5) * mw, y = oy + (0.5 - lat / Math.PI) * mh;
        c.fillStyle = color; c.strokeStyle = color;
        c.beginPath();
        if (shape === 'tri') { c.moveTo(x, y - 7); c.lineTo(x + 6, y + 5); c.lineTo(x - 6, y + 5); c.closePath(); c.fill(); }
        else if (shape === 'dia') { c.moveTo(x, y - 6); c.lineTo(x + 6, y); c.lineTo(x, y + 6); c.lineTo(x - 6, y); c.closePath(); c.stroke(); }
        else { c.arc(x, y, 4, 0, Math.PI * 2); c.fill(); }
        c.font = '600 12px Rajdhani, sans-serif';
        c.fillText(label, x + 9, y + 4);
      };
      for (const m of g.machines.machines) if (m.type === 'beacon') mark(g.machines.worldPos(m), '#ff5f5f', m.label, 'dot');
      if (g.machines.machines.length) mark(g.machines.worldPos(g.machines.machines[0]), '#7dffb0', 'Base', 'dot');
      mark(g.pilot.ship.pos, '#ffb547', 'Nave', 'dia');
      mark(g.mode === 'ship' ? g.pilot.ship.pos : g.player.pos, '#ea7a2c', 'Você', 'tri');
      c.fillStyle = 'rgba(232,241,248,0.5)';
      c.font = '11px JetBrains Mono, monospace';
      c.fillText(`${g.displayName(frame.id)} · projeção equiretangular · grade 30°`, 14, H - 14);
    };
    const d = frame.def;
    side.innerHTML = `<div class="pnl" style="padding:14px"><div class="lbl">Cartografia orbital</div><div style="font-size:22px;font-weight:700;margin:4px 0">${g.displayName(frame.id)}</div>
      <div class="kv"><div>Tipo</div><div>${TYPE_LABEL[d.type]}</div><div>Raio</div><div>${fmtDist(d.radius)}</div><div>Gravidade</div><div>${d.gravity.toFixed(1)} m/s²</div>
      <div>Clima</div><div>${u.focus?.weather.label ?? '—'}</div><div>Estruturas</div><div>${g.knownPois.size} sinais registrados</div></div></div>
      <p class="hint-line">▲ você · ◆ nave · ● base e balizas. Use o scanner para revelar sinais na bússola.</p>`;
    requestAnimationFrame(draw);
  }

  // ------------------------------------------------------------------ galaxy map
  private tabGalaxy(body: HTMLElement): void {
    const g = this.game;
    const u = g.universe;
    const here = u.summary;
    const canvas = document.createElement('canvas');
    canvas.className = 'mapcanvas';
    body.appendChild(canvas);
    const side = h('div', 'side');
    body.appendChild(side);
    const view = this.galaxyView;
    if (view.cx === 0 && view.cz === 0) { view.cx = here.pos[0]; view.cz = here.pos[2]; }
    let stars: StarSummary[] = [];
    const refresh = () => { stars = u.galaxy.starsNear([view.cx, here.pos[1], view.cz], 80); };
    refresh();
    const toScreen = (p: [number, number, number]) => [canvas.clientWidth / 2 + (p[0] - view.cx) * view.zoom, canvas.clientHeight / 2 + (p[2] - view.cz) * view.zoom] as const;
    const draw = () => {
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = canvas.clientWidth * dpr; canvas.height = canvas.clientHeight * dpr;
      const c = canvas.getContext('2d')!;
      c.scale(dpr, dpr);
      c.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
      // grid
      c.strokeStyle = 'rgba(160,220,255,0.05)';
      const step = 12 * view.zoom;
      const ox = (canvas.clientWidth / 2 - view.cx * view.zoom) % step, oy = (canvas.clientHeight / 2 - view.cz * view.zoom) % step;
      for (let x = ox; x < canvas.clientWidth; x += step) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, canvas.clientHeight); c.stroke(); }
      for (let y = oy; y < canvas.clientHeight; y += step) { c.beginPath(); c.moveTo(0, y); c.lineTo(canvas.clientWidth, y); c.stroke(); }
      // range
      const [hx, hy] = toScreen(here.pos);
      c.strokeStyle = 'rgba(95,225,255,0.35)';
      c.setLineDash([6, 6]);
      c.beginPath(); c.arc(hx, hy, JUMP_RANGE * view.zoom, 0, Math.PI * 2); c.stroke();
      c.setLineDash([]);
      for (const s of stars) {
        const [x, y] = toScreen(s.pos);
        const col = kelvinToRGB({ M: 3200, K: 4500, G: 5700, F: 6700, A: 8500, B: 15000, RG: 3800 }[s.spectral]);
        const depth = 1 - Math.min(0.7, Math.abs(s.pos[1] - here.pos[1]) / 60);
        const size = ({ M: 2, K: 2.5, G: 3, F: 3.2, A: 3.5, B: 4.5, RG: 4.5 }[s.spectral]) * (0.7 + view.zoom / 20);
        c.fillStyle = `rgba(${col[0] * 255},${col[1] * 255},${col[2] * 255},${depth})`;
        c.beginPath(); c.arc(x, y, size, 0, Math.PI * 2); c.fill();
        const visited = g.visitedSystems.includes(s.id);
        if (visited) { c.strokeStyle = 'rgba(125,255,176,0.7)'; c.beginPath(); c.arc(x, y, size + 3, 0, Math.PI * 2); c.stroke(); }
        if (s.id === here.id) { c.strokeStyle = '#ea7a2c'; c.lineWidth = 2; c.beginPath(); c.arc(x, y, size + 6, 0, Math.PI * 2); c.stroke(); c.lineWidth = 1; }
        if (s.id === g.jumpTarget) { c.strokeStyle = '#5fe1ff'; c.beginPath(); c.moveTo(hx, hy); c.lineTo(x, y); c.stroke(); }
        if (s === this.selStar) { c.strokeStyle = '#ffb547'; c.strokeRect(x - size - 6, y - size - 6, size * 2 + 12, size * 2 + 12); }
        const dHere = Math.hypot(s.pos[0] - here.pos[0], s.pos[1] - here.pos[1], s.pos[2] - here.pos[2]);
        if ((view.zoom > 9 && dHere < JUMP_RANGE * 1.6) || (view.zoom > 4 && dHere < JUMP_RANGE) || visited || s.id === here.id || s === this.selStar) {
          c.fillStyle = 'rgba(232,241,248,0.6)';
          c.font = '11px Rajdhani, sans-serif';
          c.fillText(g.names[s.id] ?? s.name, x + size + 4, y + 3);
        }
      }
      c.fillStyle = 'rgba(232,241,248,0.5)';
      c.font = '11px JetBrains Mono, monospace';
      c.fillText(`Vista superior · 1 quadrícula = 12 anos-luz · alcance de salto ${JUMP_RANGE} al · roda = zoom · arrastar = mover`, 14, canvas.clientHeight - 14);
    };
    const renderSide = () => {
      side.innerHTML = '';
      const s = this.selStar;
      if (!s) {
        side.innerHTML = `<div class="pnl" style="padding:14px"><div class="lbl">Mapa galáctico</div><p class="hint-line" style="line-height:1.6">Selecione uma estrela dentro do alcance. Requer Núcleo de Dobra instalado e uma Célula de Dobra por salto. Na nave, fora da atmosfera, pressione J.</p>
          <div class="kv" style="margin-top:8px"><div>Sistema atual</div><div>${g.names[here.id] ?? here.name}</div><div>Visitados</div><div>${g.visitedSystems.length}</div></div></div>`;
        return;
      }
      const d = Math.hypot(s.pos[0] - here.pos[0], s.pos[1] - here.pos[1], s.pos[2] - here.pos[2]);
      const visited = g.visitedSystems.includes(s.id);
      const preview = generateSystem(s);
      const p = h('div', 'pnl');
      p.style.padding = '14px';
      p.innerHTML = `<div class="lbl">${preview.star.label} · classe ${s.spectral}</div><div style="font-size:22px;font-weight:700;margin:4px 0">${g.names[s.id] ?? s.name}</div>
        <div class="kv"><div>Distância</div><div>${d.toFixed(1)} anos-luz</div><div>Temperatura</div><div>${Math.round(preview.star.temperature)} K</div>
        <div>Corpos</div><div>${visited ? preview.bodies.length : '≈ ' + preview.bodies.filter((b) => b.kind === 'planet').length + ' planetas'}</div>
        <div>Status</div><div>${visited ? '<span style="color:var(--green)">visitado</span>' : 'inexplorado'}</div>
        <div>Coordenadas</div><div class="mono" style="font-size:11px">${s.pos.map((v) => v.toFixed(1)).join(' / ')}</div></div>`;
      side.appendChild(p);
      const row = h('div');
      row.style.display = 'flex'; row.style.gap = '8px';
      const b1 = h('button', 'btn primary', g.jumpTarget === s.id ? 'Rota definida ✓' : 'Definir salto') as HTMLButtonElement;
      b1.disabled = s.id === here.id || d > JUMP_RANGE;
      b1.onclick = () => { g.jumpTarget = s.id; g.toast(`Rota de dobra: ${s.name} (${d.toFixed(1)} al)`, 'var(--cyan)'); draw(); renderSide(); };
      const b2 = h('button', 'btn', 'Renomear');
      b2.onclick = () => this.renamePrompt(s.id, g.names[s.id] ?? s.name, () => { draw(); renderSide(); });
      row.append(b1, b2);
      side.appendChild(row);
      if (d > JUMP_RANGE) side.appendChild(h('p', 'hint-line', 'Fora do alcance do motor de dobra.'));
    };
    let drag: { x: number; y: number; moved: boolean } | null = null;
    canvas.onmousedown = (e) => { drag = { x: e.clientX, y: e.clientY, moved: false }; };
    window.addEventListener('mouseup', () => { drag = null; }, { once: true });
    canvas.onmousemove = (e) => {
      if (!drag || !(e.buttons & 1)) return;
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      view.cx -= dx / view.zoom; view.cz -= dy / view.zoom;
      drag.x = e.clientX; drag.y = e.clientY;
      refresh();
      draw();
    };
    canvas.onclick = (e) => {
      if (drag?.moved) return;
      const r = canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best: StarSummary | null = null, bd = 16;
      for (const s of stars) { const [sx, sy] = toScreen(s.pos); const d = Math.hypot(sx - x, sy - y); if (d < bd) { bd = d; best = s; } }
      this.selStar = best;
      g.audio.ui('hover');
      draw();
      renderSide();
    };
    canvas.onwheel = (e) => {
      e.preventDefault();
      view.zoom = THREE.MathUtils.clamp(view.zoom * (e.deltaY > 0 ? 0.85 : 1.18), 1.2, 30);
      draw();
    };
    requestAnimationFrame(() => { draw(); renderSide(); });
  }

  // ------------------------------------------------------------------ storage
  openStorage(m: Machine): void {
    const g = this.game;
    if (!m.inv) return;
    g.uiOpen = true;
    g.input.unlock();
    const inv = m.inv;
    const wrap = h('div', 'modal-wrap');
    const box = h('div', 'modal pnl');
    box.style.width = '640px';
    const render = () => {
      box.innerHTML = '<h2>Contêiner</h2><div class="lbl">Conteúdo — clique para retirar</div>';
      const cg = h('div', 'grid');
      cg.style.gridTemplateColumns = 'repeat(8, 58px)';
      cg.style.margin = '8px 0 16px';
      for (let i = 0; i < inv.slots.length; i++) cg.appendChild(this.slotEl(inv, i, (k) => {
        const st = inv.slots[k];
        if (!st) return;
        const left = g.inventory.add(st.id, st.count);
        inv.takeFromSlot(k, st.count - left);
        g.audio.ui('click');
        render();
      }, false));
      box.appendChild(cg);
      box.appendChild(h('div', 'lbl', 'Inventário — clique para guardar'));
      const ig = h('div', 'grid');
      ig.style.margin = '8px 0';
      for (let i = 0; i < g.inventory.slots.length; i++) ig.appendChild(this.slotEl(g.inventory, i, (k) => {
        const st = g.inventory.slots[k];
        if (!st || item(st.id).kind === 'tool') return;
        const left = inv.add(st.id, st.count);
        g.inventory.takeFromSlot(k, st.count - left);
        g.audio.ui('click');
        render();
      }, false));
      box.appendChild(ig);
      const act = h('div', 'actions');
      const close = h('button', 'btn primary', 'Fechar');
      close.onclick = () => { wrap.remove(); g.uiOpen = false; g.input.lock(); };
      act.appendChild(close);
      box.appendChild(act);
    };
    render();
    wrap.appendChild(box);
    this.panels.appendChild(wrap);
    const esc = (e: KeyboardEvent) => { if (e.code === 'Escape' || e.code === 'KeyE') { wrap.remove(); g.uiOpen = false; window.removeEventListener('keydown', esc); } };
    window.addEventListener('keydown', esc);
  }
}

function bodyColor(t: string): string {
  return ({ terrestrial: '#6fbf8a', ocean: '#3f8fd8', desert: '#d8a46a', frozen: '#cfe8f5', volcanic: '#d0603a', barren: '#9a958e', exotic: '#b06fd8', gas_giant: '#d8b98a' } as Record<string, string>)[t] ?? '#ccc';
}

// keep tree-shaking honest for unused helpers
void ITEMS;
void ShipModel;
void PRESETS;

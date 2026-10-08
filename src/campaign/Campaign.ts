/**
 * Opening campaign: crash-landed on an unknown moon, the astronaut learns by
 * doing — move, scan, gather, fabricate, repair the ship, take off, reach orbit,
 * pick a new world and land on it. Objectives are short, contextual and never
 * block free play.
 */

export interface CampaignContext {
  moved: number;
  scans: number;
  count(id: string): number;
  fabricatorPlaced: boolean;
  shipHull: number;
  shipPower: boolean;
  shipThrusters: boolean;
  engineOn: boolean;
  inShip: boolean;
  altitudeAboveAtmo: number;
  navTargetOther: boolean;
  landedBodyId: string | null;
  startBodyId: string;
  mined: number;
  warpJumps: number;
}

export interface Objective {
  id: string;
  title: string;
  hint: string;
  progress?: (c: CampaignContext) => string;
  done: (c: CampaignContext) => boolean;
}

const OBJECTIVES: Objective[] = [
  { id: 'wake', title: 'Sistemas do traje reiniciados', hint: 'Mova-se com W A S D e olhe ao redor com o mouse. V alterna a câmera.', done: (c) => c.moved > 10 },
  { id: 'scan', title: 'Analise o ambiente', hint: 'Selecione o Scanner (tecla 3) e clique para emitir um pulso. Minérios próximos vão brilhar.', done: (c) => c.scans > 0 },
  {
    id: 'gather', title: 'Colete recursos', hint: 'Use o Extrator (tecla 1) segurando o botão esquerdo. Afloramentos rochosos expõem minérios.',
    progress: (c) => `Ferro ${Math.min(c.count('iron'), 8)}/8 · Cobre ${Math.min(c.count('copper'), 4)}/4 · Silício ${Math.min(c.count('silicon'), 3)}/3`,
    done: (c) => c.count('iron') >= 8 && c.count('copper') >= 4 && c.count('silicon') >= 3,
  },
  { id: 'fabricator', title: 'Monte um Fabricador', hint: 'Abra o terminal (TAB) › Fabricação › Fabricador. Depois selecione-o na barra e clique para posicioná-lo no solo.', done: (c) => c.fabricatorPlaced },
  {
    id: 'hull', title: 'Repare o casco da nave', hint: 'Fabrique um Kit de Casco (Placas + Carbono). Aproxime-se da nave e pressione R para o painel de reparos.',
    progress: (c) => `Integridade do casco ${Math.round(c.shipHull)}%`, done: (c) => c.shipHull >= 80,
  },
  { id: 'power', title: 'Restaure a energia da nave', hint: 'A Célula de Energia exige Aurelita — cristais dourados luminosos, comuns em cavernas e afloramentos. Fabrique-a junto ao Fabricador.', done: (c) => c.shipPower },
  { id: 'thruster', title: 'Repare o acoplamento do propulsor', hint: 'Titânio aparece a mais de 9 m de profundidade. Escave, use o scanner e fabrique o acoplamento.', done: (c) => c.shipThrusters },
  { id: 'board', title: 'Ligue os sistemas da nave', hint: 'Pressione E junto à escotilha para entrar no cockpit e R para ligar os motores.', done: (c) => c.engineOn },
  { id: 'orbit', title: 'Alcance a órbita', hint: 'W acelera, ESPAÇO sobe, mouse direciona, SHIFT aciona o pós-combustor. Suba acima da atmosfera.', progress: (c) => (c.altitudeAboveAtmo < 0 ? `Faltam ${Math.round(-c.altitudeAboveAtmo)} m` : 'Órbita alcançada'), done: (c) => c.altitudeAboveAtmo > 0 },
  { id: 'identify', title: 'Identifique um novo mundo', hint: 'Abra o Mapa do Sistema (M), escolha um planeta ou lua e defina-o como destino.', done: (c) => c.navTargetOther },
  { id: 'travel', title: 'Viaje e pouse em outro mundo', hint: 'Aponte para o marcador e use o Motor de Cruzeiro (T). Perto do destino, desça com cuidado e baixe o trem de pouso (X).', done: (c) => !!c.landedBodyId && c.landedBodyId !== c.startBodyId },
  { id: 'warp', title: 'Além desta estrela', hint: 'Construa um Núcleo de Dobra e Células de Dobra no Fabricador, instale-os na nave e salte pela Galáxia (G, depois J).', done: (c) => c.warpJumps > 0 },
  { id: 'free', title: 'Exploração livre', hint: 'O universo é seu: construa bases, catalogue mundos e descubra o que existe entre as estrelas.', done: () => false },
];

/** index of an objective (e.g. to start explorer mode at 'board') */
export function objectiveIndex(id: string): number {
  return Math.max(0, OBJECTIVES.findIndex((o) => o.id === id));
}

export class Campaign {
  stage = 0;
  completed: string[] = [];
  onAdvance: ((completed: Objective, next: Objective) => void) | null = null;

  get current(): Objective {
    return OBJECTIVES[Math.min(this.stage, OBJECTIVES.length - 1)];
  }

  update(c: CampaignContext): void {
    // allow skipping ahead when players complete later steps first
    let guard = 0;
    while (guard++ < OBJECTIVES.length && this.stage < OBJECTIVES.length - 1 && this.current.done(c)) {
      const done = this.current;
      this.completed.push(done.id);
      this.stage++;
      this.onAdvance?.(done, this.current);
    }
  }

  serialize(): Record<string, unknown> {
    return { stage: this.stage, completed: this.completed };
  }

  load(d: Record<string, unknown>): void {
    this.stage = (d.stage as number) ?? 0;
    this.completed = (d.completed as string[]) ?? [];
  }
}

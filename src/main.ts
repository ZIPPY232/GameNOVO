import './ui/styles.css';
import { Game } from './game/Game';
import { UI } from './ui/UI';

function fail(msg: string): void {
  const el = document.getElementById('loading')!;
  el.querySelector('.ld-title')!.textContent = 'ERRO';
  el.querySelector('.ld-step')!.textContent = msg;
}

async function start(): Promise<void> {
  const canvas = document.getElementById('gl') as HTMLCanvasElement;
  const test = document.createElement('canvas').getContext('webgl2');
  if (!test) {
    fail('Seu navegador não suporta WebGL2. Use uma versão recente do Chrome, Edge ou Firefox.');
    return;
  }
  const bar = document.querySelector('#loading .ld-bar i') as HTMLElement;
  const step = document.querySelector('#loading .ld-step') as HTMLElement;
  const progress = (p: number, msg: string) => {
    bar.style.width = `${Math.round(p * 100)}%`;
    step.textContent = msg;
  };
  const game = new Game(canvas);
  const ui = new UI(game);
  game.ui = ui;
  (window as unknown as { game: Game }).game = game;
  await game.boot(progress);
  document.getElementById('loading')!.classList.add('done');
  await ui.showMainMenu();
}

start().catch((e) => {
  console.error(e);
  fail(String(e?.message ?? e));
});

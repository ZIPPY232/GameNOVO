import { item, type ItemDef } from '../items/items';
import { BLOCKS } from '../voxel/blocks';
import { LAYERS } from '../voxel/palette';

/** Procedurally drawn item icons (cached data URLs). */

const cache = new Map<string, string>();

function shade(rgb: [number, number, number], k: number): string {
  return `rgb(${Math.min(255, Math.round(rgb[0] * k))},${Math.min(255, Math.round(rgb[1] * k))},${Math.min(255, Math.round(rgb[2] * k))})`;
}

function cube(g: CanvasRenderingContext2D, top: [number, number, number], side: [number, number, number], glow: boolean): void {
  const cx = 32, cy = 34, s = 19;
  const p = (x: number, y: number) => [cx + x, cy + y] as const;
  const face = (pts: (readonly [number, number])[], fill: string) => {
    g.beginPath();
    g.moveTo(pts[0][0], pts[0][1]);
    for (const q of pts.slice(1)) g.lineTo(q[0], q[1]);
    g.closePath();
    g.fillStyle = fill;
    g.fill();
  };
  face([p(0, -s), p(s, -s / 2), p(0, 0), p(-s, -s / 2)], shade(top, 1.15));
  face([p(-s, -s / 2), p(0, 0), p(0, s), p(-s, s / 2)], shade(side, 0.82));
  face([p(s, -s / 2), p(0, 0), p(0, s), p(s, s / 2)], shade(side, 0.62));
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.lineWidth = 1;
  g.stroke();
  // speckle texture
  for (let i = 0; i < 40; i++) {
    const a = Math.random(), b = Math.random();
    const x = cx + (a - b) * s, y = cy - s / 2 + (a + b) * s / 2 - s / 2 + 2;
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.12})`;
    g.fillRect(x, y, 1.5, 1.5);
  }
  if (glow) {
    g.globalCompositeOperation = 'lighter';
    const gr = g.createRadialGradient(cx, cy - 4, 2, cx, cy, 28);
    gr.addColorStop(0, shade(top, 0.6));
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr;
    g.fillRect(0, 0, 64, 64);
    g.globalCompositeOperation = 'source-over';
  }
}

function hexToRgb(c: string): [number, number, number] {
  if (c.startsWith('rgb')) {
    const m = c.match(/\d+/g)!;
    return [+m[0], +m[1], +m[2]];
  }
  const h = c.replace('#', '');
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function crystal(g: CanvasRenderingContext2D, color: string): void {
  const rgb = hexToRgb(color);
  const shards: [number, number, number, number][] = [[32, 12, 9, 40], [22, 22, 7, 30], [42, 20, 7, 32], [28, 30, 6, 22]];
  for (const [x, y, w, h] of shards) {
    g.beginPath();
    g.moveTo(x, y);
    g.lineTo(x + w, y + h * 0.3);
    g.lineTo(x + w * 0.6, y + h);
    g.lineTo(x - w * 0.6, y + h);
    g.lineTo(x - w, y + h * 0.3);
    g.closePath();
    const gr = g.createLinearGradient(x - w, y, x + w, y + h);
    gr.addColorStop(0, shade(rgb, 1.35));
    gr.addColorStop(1, shade(rgb, 0.6));
    g.fillStyle = gr;
    g.fill();
    g.strokeStyle = 'rgba(255,255,255,0.25)';
    g.stroke();
  }
}

function device(g: CanvasRenderingContext2D, d: ItemDef): void {
  const rgb = hexToRgb(d.color);
  g.fillStyle = '#2b3036';
  g.strokeStyle = 'rgba(255,255,255,0.25)';
  g.beginPath();
  g.roundRect(12, 12, 40, 40, 6);
  g.fill();
  g.stroke();
  g.fillStyle = shade(rgb, 1);
  g.fillRect(12, 44, 40, 4);
  g.font = '700 18px Rajdhani, sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = shade(rgb, 1.2);
  g.fillText(d.glyph ?? d.name[0], 32, 30);
}

function canister(g: CanvasRenderingContext2D, d: ItemDef): void {
  const rgb = hexToRgb(d.color);
  const gr = g.createLinearGradient(20, 0, 44, 0);
  gr.addColorStop(0, shade(rgb, 0.6));
  gr.addColorStop(0.4, shade(rgb, 1.2));
  gr.addColorStop(1, shade(rgb, 0.5));
  g.fillStyle = gr;
  g.beginPath();
  g.roundRect(20, 16, 24, 38, 8);
  g.fill();
  g.fillStyle = '#3a3f45';
  g.fillRect(26, 10, 12, 8);
  g.font = '700 13px Rajdhani, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = '#081016';
  g.fillText(d.glyph ?? '', 32, 40);
}

function tool(g: CanvasRenderingContext2D, d: ItemDef): void {
  const rgb = hexToRgb(d.color);
  g.save();
  g.translate(32, 32);
  g.rotate(-0.6);
  g.fillStyle = '#d9dbdf';
  g.beginPath(); g.roundRect(-18, -7, 30, 14, 3); g.fill();
  g.fillStyle = '#2d3238';
  g.beginPath(); g.roundRect(-6, 5, 9, 16, 2); g.fill();
  g.fillStyle = shade(rgb, 1);
  g.fillRect(-18, -7, 6, 14);
  g.fillStyle = '#20252b';
  g.fillRect(12, -4, 9, 8);
  g.fillStyle = shade(rgb, 1.3);
  g.beginPath(); g.arc(22, 0, 3, 0, Math.PI * 2); g.fill();
  g.restore();
}

function nugget(g: CanvasRenderingContext2D, d: ItemDef): void {
  const rgb = hexToRgb(d.color);
  g.beginPath();
  g.moveTo(16, 38); g.lineTo(24, 20); g.lineTo(40, 16); g.lineTo(50, 30); g.lineTo(44, 48); g.lineTo(24, 50);
  g.closePath();
  const gr = g.createRadialGradient(28, 26, 2, 32, 34, 26);
  gr.addColorStop(0, shade(rgb, 1.4));
  gr.addColorStop(1, shade(rgb, 0.45));
  g.fillStyle = gr;
  g.fill();
  g.strokeStyle = 'rgba(0,0,0,0.4)';
  g.stroke();
  g.font = '700 14px Rajdhani, sans-serif';
  g.textAlign = 'center';
  g.fillStyle = 'rgba(255,255,255,0.85)';
  g.fillText(d.glyph ?? '', 33, 38);
}

export function iconFor(id: string): string {
  const hit = cache.get(id);
  if (hit) return hit;
  const d = item(id);
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  if (d.block !== undefined) {
    const b = BLOCKS[d.block];
    const top = LAYERS[b.top], side = LAYERS[b.side];
    const mixc = (l: typeof top): [number, number, number] => [0, 1, 2].map((i) => l.color[i] * 0.7 + l.accent[i] * 0.3) as [number, number, number];
    cube(g, mixc(top), mixc(side), b.emissive > 0.5);
  } else if (d.kind === 'resource') {
    if (['silicon', 'aurelite', 'radite', 'cryolith', 'luminite', 'sulfur'].includes(id)) crystal(g, d.color);
    else nugget(g, d);
  } else if (d.kind === 'tool') tool(g, d);
  else if (d.kind === 'consumable') canister(g, d);
  else device(g, d);
  const url = c.toDataURL();
  cache.set(id, url);
  return url;
}

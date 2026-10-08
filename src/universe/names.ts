import { Rng } from '../core/rng';

const START = ['Ka', 'Ve', 'Or', 'Tal', 'Ny', 'Se', 'Ar', 'Qua', 'Ze', 'Ul', 'Mi', 'Dra', 'Is', 'Eo', 'Rha', 'Cy', 'Lo', 'Ix', 'Va', 'Thes', 'Bel', 'Kor', 'Aes', 'Yr'];
const MID = ['ra', 'li', 'no', 'ven', 'tha', 'ri', 'sa', 'ko', 'mi', 'dor', 'ne', 'la', 'xi', 'ru', 'pha', 'ten', 'ga', 'lo'];
const END = ['on', 'is', 'a', 'ar', 'eth', 'ia', 'os', 'un', 'ix', 'ae', 'or', 'en', 'ys', 'ul', 'ara', 'ion'];
const GREEK = ['Alfa', 'Beta', 'Gama', 'Delta', 'Épsilon', 'Zeta', 'Eta', 'Teta'];

export function properName(rng: Rng): string {
  let s = rng.pick(START);
  const n = rng.int(0, 2);
  for (let i = 0; i < n; i++) s += rng.pick(MID);
  s += rng.pick(END);
  return s;
}

export function systemName(rng: Rng): string {
  const base = properName(rng);
  const r = rng.next();
  if (r < 0.25) return `${base} ${rng.pick(GREEK)}`;
  if (r < 0.45) return `${base}-${rng.int(2, 99)}`;
  return base;
}

export const ROMAN = ['I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];

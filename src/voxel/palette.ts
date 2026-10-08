import { L, LAYER_COUNT } from './blocks';

/**
 * Per-layer material description shared by the texture generator (detail),
 * the voxel shader (PBR constants) and the far-LOD terrain (vertex colours).
 */
export interface LayerMaterial {
  /** base albedo, sRGB 0..255 */
  color: [number, number, number];
  /** secondary colour used by patterns */
  accent: [number, number, number];
  roughness: number;
  metalness: number;
  /** emissive strength (HDR) multiplied by the emissive mask */
  emissive: number;
  /** vegetation layers get the planet's bio tint */
  tint: boolean;
  /** opacity for translucent blocks */
  opacity: number;
  pattern: Pattern;
}

export type Pattern =
  | 'rock' | 'basalt' | 'soil' | 'moss' | 'moss_side' | 'sand' | 'snow' | 'snow_side' | 'ice'
  | 'ore' | 'crystal' | 'carbon' | 'lava' | 'metal' | 'glass' | 'concrete' | 'lamp' | 'strata'
  | 'ash' | 'bark' | 'leaves' | 'mud' | 'bedrock' | 'regolith' | 'floor' | 'coral' | 'hull'
  | 'fungus' | 'bark_top';

const M = (color: [number, number, number], pattern: Pattern, o: Partial<LayerMaterial> = {}): LayerMaterial => ({
  color, accent: o.accent ?? color, roughness: 0.85, metalness: 0, emissive: 0, tint: false, opacity: 1, pattern, ...o,
});

export const LAYERS: LayerMaterial[] = [];
LAYERS[L.ROCK] = M([122, 118, 112], 'rock', { accent: [92, 88, 84], roughness: 0.82 });
LAYERS[L.BASALT] = M([58, 57, 61], 'basalt', { accent: [40, 40, 44], roughness: 0.78 });
LAYERS[L.SOIL] = M([104, 78, 58], 'soil', { accent: [78, 58, 42], roughness: 0.95 });
LAYERS[L.MOSS_TOP] = M([150, 158, 140], 'moss', { accent: [110, 118, 100], roughness: 0.9, tint: true });
LAYERS[L.MOSS_SIDE] = M([104, 78, 58], 'moss_side', { accent: [150, 158, 140], roughness: 0.92, tint: true });
LAYERS[L.SAND] = M([204, 172, 124], 'sand', { accent: [178, 146, 102], roughness: 0.93 });
LAYERS[L.SNOW] = M([236, 241, 246], 'snow', { accent: [210, 222, 236], roughness: 0.6 });
LAYERS[L.ICE] = M([158, 200, 224], 'ice', { accent: [210, 236, 250], roughness: 0.12 });
LAYERS[L.IRON_ORE] = M([116, 110, 104], 'ore', { accent: [150, 74, 42], roughness: 0.8 });
LAYERS[L.COPPER_ORE] = M([112, 110, 106], 'ore', { accent: [52, 168, 140], roughness: 0.75 });
LAYERS[L.QUARTZ] = M([206, 212, 220], 'crystal', { accent: [245, 248, 255], roughness: 0.2 });
LAYERS[L.CARBON] = M([36, 34, 34], 'carbon', { accent: [90, 90, 96], roughness: 0.55 });
LAYERS[L.TITANIUM_ORE] = M([84, 86, 92], 'ore', { accent: [182, 200, 222], roughness: 0.45, metalness: 0.35 });
LAYERS[L.RADITE] = M([50, 54, 48], 'ore', { accent: [120, 255, 90], roughness: 0.4, emissive: 2.2 });
LAYERS[L.AURELITE] = M([70, 60, 50], 'crystal', { accent: [255, 180, 60], roughness: 0.25, emissive: 3.0 });
LAYERS[L.LAVA] = M([40, 28, 24], 'lava', { accent: [255, 110, 20], roughness: 0.9, emissive: 9.0 });
LAYERS[L.METAL_PLATE] = M([158, 164, 170], 'metal', { accent: [120, 126, 132], roughness: 0.38, metalness: 0.85 });
LAYERS[L.GLASS] = M([190, 220, 236], 'glass', { accent: [90, 96, 104], roughness: 0.06, opacity: 0.28, metalness: 0.1 });
LAYERS[L.CONCRETE] = M([168, 164, 156], 'concrete', { accent: [140, 136, 130], roughness: 0.75 });
LAYERS[L.LAMP] = M([255, 238, 206], 'lamp', { accent: [70, 74, 80], roughness: 0.3, emissive: 6.0 });
LAYERS[L.SANDSTONE] = M([196, 140, 92], 'strata', { accent: [170, 112, 74], roughness: 0.88 });
LAYERS[L.ASH] = M([74, 71, 70], 'ash', { accent: [54, 50, 50], roughness: 0.97 });
LAYERS[L.SULFUR] = M([214, 196, 60], 'crystal', { accent: [240, 226, 110], roughness: 0.6 });
LAYERS[L.STALK] = M([86, 72, 98], 'bark', { accent: [120, 220, 210], roughness: 0.8, emissive: 1.2 });
LAYERS[L.CANOPY] = M([170, 176, 168], 'leaves', { accent: [210, 255, 240], roughness: 0.7, tint: true, emissive: 1.4 });
LAYERS[L.MUD] = M([74, 60, 46], 'mud', { accent: [58, 46, 36], roughness: 0.35 });
LAYERS[L.BEDROCK] = M([40, 40, 44], 'bedrock', { accent: [24, 24, 28], roughness: 0.9 });
LAYERS[L.CRYOLITH] = M([110, 150, 170], 'crystal', { accent: [130, 240, 255], roughness: 0.15, emissive: 2.0 });
LAYERS[L.LUMINITE] = M([70, 40, 90], 'crystal', { accent: [200, 100, 255], roughness: 0.2, emissive: 3.2 });
LAYERS[L.REGOLITH] = M([142, 138, 134], 'regolith', { accent: [112, 108, 104], roughness: 0.96 });
LAYERS[L.FLOOR] = M([110, 116, 122], 'floor', { accent: [70, 74, 78], roughness: 0.45, metalness: 0.75 });
LAYERS[L.CORAL] = M([224, 122, 106], 'coral', { accent: [255, 200, 170], roughness: 0.75, emissive: 0.8 });
LAYERS[L.SNOW_SIDE] = M([104, 78, 58], 'snow_side', { accent: [236, 241, 246], roughness: 0.8 });
LAYERS[L.HULL] = M([52, 56, 61], 'hull', { accent: [230, 120, 40], roughness: 0.42, metalness: 0.8 });
LAYERS[L.FUNGUS] = M([138, 95, 196], 'fungus', { accent: [120, 255, 230], roughness: 0.6, emissive: 2.5 });
LAYERS[L.RED_ROCK] = M([154, 82, 54], 'strata', { accent: [120, 60, 40], roughness: 0.85 });
LAYERS[L.STALK_TOP] = M([96, 80, 108], 'bark_top', { accent: [140, 120, 150], roughness: 0.8 });

for (let i = 0; i < LAYER_COUNT; i++) if (!LAYERS[i]) LAYERS[i] = LAYERS[L.ROCK];

export function srgbToLinear(c: number): number {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}

/** Approximate average linear albedo of a layer for distant rendering. */
export function layerAverageLinear(layer: number, bioTint: [number, number, number], rockTint: [number, number, number]): [number, number, number] {
  const m = LAYERS[layer];
  const mix = m.pattern === 'ore' ? 0.12 : m.pattern === 'moss_side' || m.pattern === 'snow_side' ? 0.3 : 0.25;
  const out: [number, number, number] = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    let c = srgbToLinear(m.color[i]) * (1 - mix) + srgbToLinear(m.accent[i]) * mix;
    if (m.tint) c *= bioTint[i] * 1.6;
    else if (isRockLike(m.pattern)) c *= rockTint[i];
    out[i] = c;
  }
  return out;
}

export function isRockLike(p: Pattern): boolean {
  return p === 'rock' || p === 'basalt' || p === 'regolith' || p === 'strata' || p === 'bedrock' || p === 'ore';
}

/** Persistent user settings (graphics, audio, controls). Stored in localStorage. */

export type Preset = 'low' | 'medium' | 'high' | 'ultra' | 'cinematic';

export interface GraphicsSettings {
  preset: Preset | 'custom';
  resolutionScale: number;
  dynamicResolution: boolean;
  renderDistance: number;
  lodDetail: number;
  atmosphereQuality: number;
  shadows: number;
  water: number;
  bloom: boolean;
  postFx: number;
  vegetation: number;
  particles: number;
  reflections: boolean;
  objectDensity: number;
  fxaa: boolean;
  textureSize: number;
  fov: number;
}

export interface AudioSettings {
  master: number;
  music: number;
  sfx: number;
  ambience: number;
}

export interface ControlSettings {
  sensitivity: number;
  invertY: boolean;
  shipInvertY: boolean;
  autoStep: boolean;
  headBob: boolean;
}

export interface Settings {
  graphics: GraphicsSettings;
  audio: AudioSettings;
  controls: ControlSettings;
  showFps: boolean;
}

export const PRESETS: Record<Preset, Omit<GraphicsSettings, 'preset' | 'fov'>> = {
  low: { resolutionScale: 0.7, dynamicResolution: true, renderDistance: 3, lodDetail: 0.7, atmosphereQuality: 0, shadows: 0, water: 0, bloom: false, postFx: 0, vegetation: 0, particles: 0, reflections: false, objectDensity: 0.5, fxaa: true, textureSize: 128 },
  medium: { resolutionScale: 0.85, dynamicResolution: true, renderDistance: 4, lodDetail: 1.0, atmosphereQuality: 1, shadows: 1, water: 1, bloom: true, postFx: 1, vegetation: 1, particles: 1, reflections: true, objectDensity: 0.75, fxaa: true, textureSize: 256 },
  high: { resolutionScale: 1.0, dynamicResolution: true, renderDistance: 5, lodDetail: 1.25, atmosphereQuality: 2, shadows: 2, water: 2, bloom: true, postFx: 2, vegetation: 2, particles: 2, reflections: true, objectDensity: 1, fxaa: true, textureSize: 256 },
  ultra: { resolutionScale: 1.0, dynamicResolution: false, renderDistance: 7, lodDetail: 1.6, atmosphereQuality: 3, shadows: 3, water: 2, bloom: true, postFx: 2, vegetation: 2, particles: 2, reflections: true, objectDensity: 1, fxaa: true, textureSize: 256 },
  cinematic: { resolutionScale: 1.25, dynamicResolution: false, renderDistance: 9, lodDetail: 2.0, atmosphereQuality: 3, shadows: 3, water: 2, bloom: true, postFx: 3, vegetation: 2, particles: 2, reflections: true, objectDensity: 1.2, fxaa: true, textureSize: 256 },
};

const KEY = 'vr-space-settings-v1';

export function defaultSettings(): Settings {
  return {
    graphics: { preset: 'high', fov: 70, ...PRESETS.high },
    audio: { master: 0.8, music: 0.55, sfx: 0.8, ambience: 0.7 },
    controls: { sensitivity: 1, invertY: false, shipInvertY: false, autoStep: true, headBob: true },
    showFps: false,
  };
}

export function loadSettings(): Settings {
  const d = defaultSettings();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return d;
    const s = JSON.parse(raw) as Partial<Settings>;
    return {
      graphics: { ...d.graphics, ...(s.graphics ?? {}) },
      audio: { ...d.audio, ...(s.audio ?? {}) },
      controls: { ...d.controls, ...(s.controls ?? {}) },
      showFps: s.showFps ?? d.showFps,
    };
  } catch {
    return d;
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable */
  }
}

export function applyPreset(g: GraphicsSettings, p: Preset): void {
  Object.assign(g, PRESETS[p]);
  g.preset = p;
}

/**
 * Astronaut life support. Every bar drives real consequences:
 *  - oxygen: consumed unless the atmosphere is breathable; 0 = suffocation damage
 *  - energy: powers tools, lights, jetpack and thermal regulation
 *  - body temperature: drifts toward ambient when regulation fails
 *  - suit integrity: falls/heat/creatures damage it; low integrity leaks O2
 *  - radiation dose: accumulates near radioactive sources / in hard vacuum
 *  - food / water (full survival mode only)
 */

export interface Environment {
  breathable: number;
  pressure: number;
  temperature: number;
  radiation: number;
  underwater: boolean;
  vacuum: boolean;
  pressurized: boolean;
  heatSource: number;
  wind: number;
  sunlight: number;
}

export interface Activity {
  sprinting: boolean;
  mining: boolean;
  jetpack: boolean;
  flashlight: boolean;
  inShip: boolean;
  dt: number;
}

export interface Upgrades {
  o2Tank: boolean;
  batteryPack: boolean;
  thermal: boolean;
  radShield: boolean;
  jetpack: boolean;
  extractorMk2: boolean;
}

export type DamageCause = 'oxygen' | 'cold' | 'heat' | 'radiation' | 'fall' | 'hunger' | 'thirst' | 'creature' | 'impact' | 'lava';

export class Vitals {
  health = 100;
  oxygen = 100;
  energy = 100;
  bodyTemp = 37;
  integrity = 100;
  radiation = 0;
  food = 100;
  water = 100;
  fullSurvival = false;
  upgrades: Upgrades = { o2Tank: false, batteryPack: false, thermal: false, radShield: false, jetpack: false, extractorMk2: false };
  lastDamage = 99;
  lastCause: DamageCause | null = null;
  /** effective regulation status for HUD */
  regulating = true;
  warnings: string[] = [];
  dead = false;
  /** Modo Explorador: no consumption, no damage */
  explorer = false;
  onDamage: ((amount: number, cause: DamageCause) => void) | null = null;

  get oxygenMax(): number { return this.upgrades.o2Tank ? 200 : 100; }
  get energyMax(): number { return this.upgrades.batteryPack ? 200 : 100; }
  get tempRange(): [number, number] { return this.upgrades.thermal ? [-170, 220] : [-75, 95]; }

  damage(amount: number, cause: DamageCause): void {
    if (this.dead || amount <= 0 || this.explorer) return;
    this.health -= amount;
    this.lastDamage = 0;
    this.lastCause = cause;
    this.onDamage?.(amount, cause);
    if (this.health <= 0) {
      this.health = 0;
      this.dead = true;
    }
  }

  drainEnergy(n: number): boolean {
    if (this.energy < n) return false;
    this.energy -= n;
    return true;
  }

  update(env: Environment, act: Activity): void {
    if (this.dead) return;
    const dt = act.dt;
    this.lastDamage += dt;
    this.warnings.length = 0;
    if (this.explorer) {
      // explorer mode: the suit never runs dry and the body never suffers
      this.oxygen = this.oxygenMax;
      this.energy = this.energyMax;
      this.health = Math.min(100, this.health + 10 * dt);
      this.bodyTemp = 37;
      this.radiation = 0;
      this.food = 100;
      this.water = 100;
      this.integrity = 100;
      return;
    }

    // ------------------------------------------------ oxygen
    let o2Rate = 0.42 * (act.sprinting ? 1.6 : 1) * (act.mining ? 1.15 : 1);
    const breath = act.inShip || env.pressurized ? 1 : env.underwater ? 0 : env.breathable;
    o2Rate *= 1 - breath;
    if (this.integrity < 25 && !act.inShip && !env.pressurized) o2Rate += 0.5 * (1 - this.integrity / 25);
    this.oxygen = Math.max(0, this.oxygen - o2Rate * dt);
    if (breath >= 0.999 && this.oxygen < this.oxygenMax) this.oxygen = Math.min(this.oxygenMax, this.oxygen + 4 * dt);
    if (this.oxygen <= 0) {
      this.damage(5 * dt, 'oxygen');
      this.warnings.push('SEM OXIGÊNIO');
    } else if (this.oxygen < this.oxygenMax * 0.2) this.warnings.push('OXIGÊNIO BAIXO');

    // ------------------------------------------------ energy & thermal regulation
    let eRate = 0.03;
    if (act.flashlight) eRate += 0.12;
    if (act.mining) eRate += 0.55;
    if (act.jetpack) eRate += 5;
    const ambient = act.inShip || env.pressurized ? 21 : env.temperature + env.heatSource;
    const comfortLo = 5, comfortHi = 32;
    const beyond = ambient < comfortLo ? comfortLo - ambient : ambient > comfortHi ? ambient - comfortHi : 0;
    eRate += beyond * 0.0035;
    this.energy = Math.max(0, this.energy - eRate * dt);
    const [lo, hi] = this.tempRange;
    const withinRating = ambient >= lo && ambient <= hi;
    this.regulating = this.energy > 0 && withinRating;
    if (this.energy <= 0) this.warnings.push('ENERGIA ESGOTADA');
    else if (this.energy < this.energyMax * 0.15) this.warnings.push('ENERGIA BAIXA');

    // ------------------------------------------------ body temperature
    if (this.regulating) {
      this.bodyTemp += (37 - this.bodyTemp) * Math.min(1, dt * 0.5);
    } else {
      // suit insulation slows drift; beyond-rating heat bleeds in faster
      const k = withinRating ? 0.0025 : 0.006;
      this.bodyTemp += (ambient - this.bodyTemp) * k * dt;
      if (!withinRating) this.warnings.push(ambient < lo ? 'FRIO EXTREMO' : 'CALOR EXTREMO');
    }
    if (this.bodyTemp < 34.5) this.damage((34.5 - this.bodyTemp) * 1.2 * dt, 'cold');
    if (this.bodyTemp > 39.8) this.damage((this.bodyTemp - 39.8) * 1.5 * dt, 'heat');
    if (env.heatSource > 200 && !act.inShip) {
      this.integrity = Math.max(0, this.integrity - 4 * dt);
      this.damage(6 * dt, 'lava');
    }

    // ------------------------------------------------ radiation
    const shield = this.upgrades.radShield ? 0.3 : 1;
    const rad = act.inShip ? env.radiation * 0.1 : env.pressurized ? env.radiation * 0.25 : env.radiation;
    if (rad > 0.02) this.radiation += rad * shield * dt;
    else this.radiation = Math.max(0, this.radiation - 0.25 * dt);
    if (this.radiation > 60) this.damage((this.radiation > 100 ? 3 : 1) * dt, 'radiation');
    if (rad * shield > 0.3) this.warnings.push('RADIAÇÃO ELEVADA');
    this.radiation = Math.min(150, this.radiation);

    // ------------------------------------------------ hunger & thirst
    if (this.fullSurvival) {
      this.food = Math.max(0, this.food - (100 / 2700) * dt * (act.sprinting ? 1.4 : 1));
      this.water = Math.max(0, this.water - (100 / 1800) * dt * (env.temperature > 35 ? 1.5 : 1));
      if (this.food <= 0) this.damage(0.5 * dt, 'hunger');
      if (this.water <= 0) this.damage(0.7 * dt, 'thirst');
      if (this.food < 15) this.warnings.push('FOME');
      if (this.water < 15) this.warnings.push('DESIDRATAÇÃO');
    }

    if (this.integrity < 25) this.warnings.push('TRAJE COMPROMETIDO');

    // ------------------------------------------------ regeneration
    const healthy = this.oxygen > 0 && this.bodyTemp > 35 && this.bodyTemp < 39.5 && this.radiation < 40 && (!this.fullSurvival || (this.food > 0 && this.water > 0));
    if (healthy && this.lastDamage > 5) this.health = Math.min(100, this.health + 0.6 * dt);
  }

  refill(o2: number, energy: number): void {
    this.oxygen = Math.min(this.oxygenMax, this.oxygen + o2);
    this.energy = Math.min(this.energyMax, this.energy + energy);
  }

  applyConsumable(c: { oxygen?: number; energy?: number; health?: number; integrity?: number; food?: number; water?: number; radiation?: number }): void {
    if (c.oxygen) this.oxygen = Math.min(this.oxygenMax, this.oxygen + c.oxygen);
    if (c.energy) this.energy = Math.min(this.energyMax, this.energy + c.energy);
    if (c.health) this.health = Math.min(100, this.health + c.health);
    if (c.integrity) this.integrity = Math.min(100, this.integrity + c.integrity);
    if (c.food) this.food = Math.min(100, this.food + c.food);
    if (c.water) this.water = Math.min(100, this.water + c.water);
    if (c.radiation) this.radiation = Math.max(0, this.radiation + c.radiation);
  }

  respawn(): void {
    this.dead = false;
    this.health = 60;
    this.oxygen = Math.max(this.oxygen, this.oxygenMax * 0.6);
    this.energy = Math.max(this.energy, this.energyMax * 0.5);
    this.integrity = Math.max(this.integrity, 50);
    this.bodyTemp = 37;
    this.radiation = Math.min(this.radiation, 20);
    this.food = Math.max(this.food, 50);
    this.water = Math.max(this.water, 50);
  }

  serialize(): Record<string, unknown> {
    return {
      health: this.health, oxygen: this.oxygen, energy: this.energy, bodyTemp: this.bodyTemp, integrity: this.integrity,
      radiation: this.radiation, food: this.food, water: this.water, fullSurvival: this.fullSurvival, explorer: this.explorer, upgrades: { ...this.upgrades },
    };
  }

  load(d: Record<string, unknown>): void {
    Object.assign(this, { ...d, upgrades: { ...this.upgrades, ...((d.upgrades as object) ?? {}) } });
    this.explorer = !!d.explorer;
    this.dead = false;
  }
}

/**
 * Keyboard / mouse input with pointer lock. Tracks held keys, per-frame
 * presses and accumulated mouse deltas.
 */
export class Input {
  private held = new Set<string>();
  private pressed = new Set<string>();
  private released = new Set<string>();
  mouseDX = 0;
  mouseDY = 0;
  wheel = 0;
  buttons = 0;
  private btnPressed = 0;
  private btnReleased = 0;
  locked = false;
  enabled = true;
  private canvas: HTMLElement;
  onLockChange: ((locked: boolean) => void) | null = null;

  constructor(canvas: HTMLElement) {
    this.canvas = canvas;
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      if (['Tab', 'Space', 'ArrowUp', 'ArrowDown', 'F1', 'F3'].includes(e.code)) e.preventDefault();
      if (!this.held.has(e.code)) this.pressed.add(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
      this.released.add(e.code);
    });
    window.addEventListener('blur', () => {
      this.held.clear();
      this.buttons = 0;
    });
    canvas.addEventListener('mousedown', (e) => {
      if (!this.locked) return;
      this.buttons |= 1 << e.button;
      this.btnPressed |= 1 << e.button;
    });
    window.addEventListener('mouseup', (e) => {
      this.buttons &= ~(1 << e.button);
      this.btnReleased |= 1 << e.button;
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    });
    window.addEventListener('wheel', (e) => {
      if (this.locked) this.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) { this.buttons = 0; this.held.clear(); }
      this.onLockChange?.(this.locked);
    });
  }

  lock(): void {
    if (this.locked) return;
    const r = this.canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
    if (r && typeof r.catch === 'function') r.catch(() => {});
  }

  unlock(): void {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  down(code: string): boolean {
    return this.enabled && this.held.has(code);
  }
  hit(code: string): boolean {
    return this.enabled && this.pressed.has(code);
  }
  up(code: string): boolean {
    return this.released.has(code);
  }
  mouse(btn: number): boolean {
    return this.enabled && (this.buttons & (1 << btn)) !== 0;
  }
  mouseHit(btn: number): boolean {
    return this.enabled && (this.btnPressed & (1 << btn)) !== 0;
  }
  mouseUp(btn: number): boolean {
    return (this.btnReleased & (1 << btn)) !== 0;
  }
  /** call once per frame after the update */
  endFrame(): void {
    this.pressed.clear();
    this.released.clear();
    this.btnPressed = 0;
    this.btnReleased = 0;
    this.mouseDX = 0;
    this.mouseDY = 0;
    this.wheel = 0;
  }
  /** for UI-driven key presses in tests */
  simulatePress(code: string): void {
    this.pressed.add(code);
  }
}

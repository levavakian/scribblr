import { OWN_TAG, TOOLTIP_TAG } from './own';

const STYLE = `
:host { all: initial; }
.tip {
  position: fixed; left: 0; top: 0; z-index: 2147483647;
  max-width: min(420px, calc(100vw - 16px)); box-sizing: border-box;
  padding: 7px 10px 8px; border-radius: 8px;
  background: #1d2230; color: #f4f5f8;
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
  box-shadow: 0 8px 28px rgba(15, 18, 30, 0.28), 0 0 0 1px rgba(255, 255, 255, 0.06);
  pointer-events: none; opacity: 0; transition: opacity 120ms ease;
  white-space: normal; overflow-wrap: anywhere;
}
.tip.show { opacity: 1; }
.label {
  display: block; margin-bottom: 2px;
  font-size: 10px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: #9ba5b7;
}
`;

/** Shows the original text when hovering a translated chunk. */
export class Tooltip {
  private host: HTMLElement | null = null;
  private box: HTMLDivElement | null = null;
  private text: HTMLDivElement | null = null;
  private current: string | null = null;

  constructor(private readonly originalOf: (chunkId: string) => string | undefined) {}

  attach(): void {
    document.addEventListener('mouseover', this.onOver, true);
    document.addEventListener('mouseout', this.onOut, true);
    window.addEventListener('scroll', this.hide, { capture: true, passive: true });
  }

  detach(): void {
    document.removeEventListener('mouseover', this.onOver, true);
    document.removeEventListener('mouseout', this.onOut, true);
    window.removeEventListener('scroll', this.hide, { capture: true });
    this.hide();
    this.host?.remove();
    this.host = this.box = this.text = null;
  }

  private ensureHost(): void {
    if (this.host?.isConnected) return;
    const host = document.createElement(TOOLTIP_TAG);
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLE;
    const box = document.createElement('div');
    box.className = 'tip';
    box.setAttribute('role', 'tooltip');
    const label = document.createElement('span');
    label.className = 'label';
    label.textContent = 'Original';
    const text = document.createElement('div');
    box.append(label, text);
    root.append(style, box);
    document.documentElement.appendChild(host);
    this.host = host;
    this.box = box;
    this.text = text;
  }

  private slotsOf(id: string): HTMLElement[] {
    return [...document.querySelectorAll<HTMLElement>(`${OWN_TAG}[data-chunk="${CSS.escape(id)}"]`)];
  }

  private onOver = (event: MouseEvent): void => {
    const slot = (event.target as Element | null)?.closest?.(OWN_TAG);
    const id = slot?.getAttribute('data-chunk');
    if (!slot || !id || id === this.current) return;
    const original = this.originalOf(id);
    if (!original) return;
    this.hide();
    this.current = id;
    this.ensureHost();
    const slots = this.slotsOf(id);
    for (const el of slots) el.setAttribute('data-hover', '');
    this.text!.textContent = original;
    this.place(slots, slot, event.clientX, event.clientY);
    this.box!.classList.add('show');
  };

  private onOut = (event: MouseEvent): void => {
    if (!this.current) return;
    const to = (event.relatedTarget as Element | null)?.closest?.(OWN_TAG);
    if (to?.getAttribute('data-chunk') === this.current) return;
    if (!(event.target as Element | null)?.closest?.(OWN_TAG)) return;
    this.hide();
  };

  private hide = (): void => {
    if (!this.current) return;
    for (const el of this.slotsOf(this.current)) el.removeAttribute('data-hover');
    this.current = null;
    this.box?.classList.remove('show');
  };

  private place(slots: HTMLElement[], hovered: Element, x: number, y: number): void {
    const box = this.box!;
    const rects = slots.flatMap((el) => [...el.getClientRects()]);
    const rect =
      rects.find((r) => x >= r.left - 2 && x <= r.right + 2 && y >= r.top - 2 && y <= r.bottom + 2) ??
      hovered.getBoundingClientRect();
    const { width, height } = box.getBoundingClientRect();
    let top = rect.top - height - 8;
    if (top < 4) top = rect.bottom + 8;
    const left = Math.max(4, Math.min(rect.left + rect.width / 2 - width / 2, window.innerWidth - width - 4));
    box.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  }
}

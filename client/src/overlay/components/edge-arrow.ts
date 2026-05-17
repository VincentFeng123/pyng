// Edge-arrow renderer for off-FOV ping projections. The overlay's rAF tick
// (overlay.ts) decides whether a tracked ping is on- or off-screen and calls
// showEdgeArrow / hideEdgeArrow accordingly. The arrow is a 24x24 SVG chevron
// pointing right by default; the caller supplies an angle so it points at the
// off-screen ping's actual bearing.
//
// The arrow lives as a sibling of `.ping` inside the `.ping-container` parent
// (see overlay.ts buildPingHtml). On hide, only the arrow's display flips —
// the .ping node's opacity is the caller's concern when toggling back to the
// in-FOV branch.

const ARROW_W = 34;
const ARROW_H = 28;
const ARROW_CENTER_X = ARROW_W / 2;
const ARROW_CENTER_Y = ARROW_H / 2;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function getOrCreate(pingNode: HTMLElement, color: string): HTMLElement | null {
  const container = pingNode.parentElement;
  if (!container) return null;
  let arrow = container.querySelector<HTMLElement>('.edge-arrow');
  if (!arrow) {
    arrow = document.createElement('div');
    arrow.className = 'edge-arrow';
    arrow.innerHTML = `<svg viewBox="0 0 ${ARROW_W} ${ARROW_H}" xmlns="http://www.w3.org/2000/svg"><path d="M9 5 L25 14 L9 23" fill="none" stroke="${escapeHtml(color)}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
    container.appendChild(arrow);
  }
  return arrow;
}

// Show or update the edge arrow as a sibling of `pingNode`. Creates the SVG
// node on first call; mutates style on subsequent calls. Hides the normal
// `.ping` marker (opacity 0) so the arrow stands in for it.
export function showEdgeArrow(
  pingNode: HTMLElement,
  x: number,
  y: number,
  angleDeg: number,
  confidence: number,
  color: string,
): void {
  pingNode.style.opacity = '0';
  pingNode.style.visibility = 'hidden';
  const arrow = getOrCreate(pingNode, color);
  if (!arrow) return;
  arrow.style.width = `${ARROW_W}px`;
  arrow.style.height = `${ARROW_H}px`;
  arrow.style.left = `${x - ARROW_CENTER_X}px`;
  arrow.style.top = `${y - ARROW_CENTER_Y}px`;
  arrow.style.transform = `rotate(${angleDeg}deg)`;
  arrow.style.opacity = String(confidence);
  arrow.style.display = 'block';
}

// Hide any existing edge arrow sibling of `pingNode`. No-op if no arrow was
// ever created. Does NOT restore `pingNode.style.opacity` — the caller's
// in-FOV branch handles that.
export function hideEdgeArrow(pingNode: HTMLElement): void {
  const container = pingNode.parentElement;
  const arrow = container?.querySelector<HTMLElement>('.edge-arrow');
  if (arrow) arrow.style.display = 'none';
}

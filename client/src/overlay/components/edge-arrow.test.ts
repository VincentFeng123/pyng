import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { showEdgeArrow, hideEdgeArrow } from './edge-arrow.js';

// happy-dom Window installs DOM globals (document, HTMLElement, etc.) onto
// globalThis so edge-arrow.ts can call document.createElement directly without
// any injection seam. Single shared Window is fine — each test builds its own
// container subtree, no cross-test bleed.
let win: Window;

before(() => {
  win = new Window();
  // Expose document + HTMLElement globally so the production module's bare
  // `document.createElement` works.
  (globalThis as unknown as { document: unknown }).document = win.document;
  (globalThis as unknown as { HTMLElement: unknown }).HTMLElement = win.HTMLElement;
});

function buildContainerWithPing(): { container: HTMLElement; ping: HTMLElement } {
  // happy-dom's Element types are structurally compatible with the lib.dom
  // HTMLElement that edge-arrow.ts is typed against, but TS doesn't see them
  // as identical. Cast through `any` only at appendChild — happy-dom's Node
  // accepts its own elements but TS resolves to lib.dom Node here.
  const container = win.document.createElement('div') as unknown as HTMLElement;
  container.className = 'ping-container';
  const ping = win.document.createElement('div') as unknown as HTMLElement;
  ping.className = 'ping';
  (container as unknown as { appendChild: (n: unknown) => void }).appendChild(ping);
  (win.document.body as unknown as { appendChild: (n: unknown) => void }).appendChild(container);
  return { container, ping };
}

describe('showEdgeArrow', () => {
  it('creates a .edge-arrow sibling on first call and sets visible state', () => {
    const { container, ping } = buildContainerWithPing();

    showEdgeArrow(ping, 200, 150, 45, 0.75, '#ff3344');

    const arrow = container.querySelector('.edge-arrow') as unknown as HTMLElement;
    assert.ok(arrow, 'edge-arrow element should be created');
    // Position is centered on the supplied edge point.
    assert.equal(arrow.style.left, '183px');
    assert.equal(arrow.style.top, '136px');
    assert.equal(arrow.style.width, '34px');
    assert.equal(arrow.style.height, '28px');
    assert.equal(arrow.style.transform, 'rotate(45deg)');
    assert.equal(arrow.style.opacity, '0.75');
    assert.equal(arrow.style.display, 'block');
    // The ping marker itself is hidden when the arrow shows.
    assert.equal(ping.style.opacity, '0');
    assert.equal(ping.style.visibility, 'hidden');
  });

  it('reuses the existing .edge-arrow on subsequent calls (no duplicate)', () => {
    const { container, ping } = buildContainerWithPing();

    showEdgeArrow(ping, 100, 100, 0, 1.0, '#abcdef');
    showEdgeArrow(ping, 300, 50, 90, 0.5, '#abcdef');

    const arrows = container.querySelectorAll('.edge-arrow');
    assert.equal(arrows.length, 1, 'only one .edge-arrow should exist');
    const arrow = arrows[0] as unknown as HTMLElement;
    // Latest call wins.
    assert.equal(arrow.style.left, '283px');
    assert.equal(arrow.style.top, '36px');
    assert.equal(arrow.style.transform, 'rotate(90deg)');
    assert.equal(arrow.style.opacity, '0.5');
  });

  it('html-escapes the color attribute in the SVG (no script element injected)', () => {
    const { container, ping } = buildContainerWithPing();

    showEdgeArrow(ping, 0, 0, 0, 1.0, '"><script>alert(1)</script>');

    const arrow = container.querySelector('.edge-arrow') as unknown as HTMLElement;
    // The security-relevant assertion: no actual <script> element should have
    // been parsed into the DOM tree. (Reading innerHTML back can show raw
    // angle brackets inside attribute values per HTML spec — that's not a
    // security issue, the parser kept them inside the attribute.)
    const scripts = arrow.querySelectorAll('script');
    assert.equal(scripts.length, 0, 'no <script> element should be injected');
    // The path element's stroke attribute should hold the escaped color.
    const path = arrow.querySelector('path') as unknown as HTMLElement | null;
    assert.ok(path, 'path element should exist');
    const fill = path.getAttribute('stroke') ?? '';
    // The attribute value is the parsed (decoded) form of the input.
    assert.equal(fill, '"><script>alert(1)</script>');
  });

  it('returns silently when the ping has no parent (defensive)', () => {
    const orphan = win.document.createElement('div') as unknown as HTMLElement;
    // No parentElement — getOrCreate returns null and showEdgeArrow bails.
    assert.doesNotThrow(() => showEdgeArrow(orphan, 0, 0, 0, 1.0, '#fff'));
    // Even though no arrow could be created, the marker is still hidden — the
    // caller asked for "edge arrow mode" and that always implies the marker
    // goes invisible.
    assert.equal(orphan.style.opacity, '0');
  });
});

describe('hideEdgeArrow', () => {
  it('flips display to none on an existing arrow', () => {
    const { container, ping } = buildContainerWithPing();
    showEdgeArrow(ping, 100, 100, 0, 1.0, '#fff');

    hideEdgeArrow(ping);

    const arrow = container.querySelector('.edge-arrow') as unknown as HTMLElement;
    assert.equal(arrow.style.display, 'none');
  });

  it('is a no-op when no arrow has been created', () => {
    const { ping } = buildContainerWithPing();
    assert.doesNotThrow(() => hideEdgeArrow(ping));
  });

  it('does NOT touch the ping marker opacity', () => {
    const { ping } = buildContainerWithPing();
    showEdgeArrow(ping, 100, 100, 0, 1.0, '#fff');
    // After show, ping.style.opacity === '0'.
    hideEdgeArrow(ping);
    // hideEdgeArrow doesn't restore it — that's the caller's job (the in-FOV
    // branch sets it back via `node.style.opacity = String(confidence)`).
    assert.equal(ping.style.opacity, '0');
  });
});

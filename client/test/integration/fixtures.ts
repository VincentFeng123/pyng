/**
 * Shared test fixtures for the integration suite.
 *
 * `TEST_AVATAR_BASE64` is the same 32×32 solid #7c3aed (pyng accent purple) PNG
 * that `scripts/mock-peer.ts` bakes in — duplicated here as a string constant
 * so this file has zero runtime dependencies. Kept in sync by convention: when
 * the mock-peer's avatar changes, update this constant too. See the regen
 * recipe in `scripts/mock-peer.ts`.
 *
 * The avatar is deliberately 32×32 (not 64×64) to exercise the renderer's
 * scale-to-slot path. 104 raw PNG bytes / 140 base64 chars.
 */

export const TEST_AVATAR_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMHKRjcpkgBg3E/Or6b2kEhAQEBAQEBAQEBAQEBAQSAceEceIl/4VGFEAAAAASUVORK5CYII=';

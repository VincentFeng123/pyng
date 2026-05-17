import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isReservedAccelerator } from './conflict-check.js';

test('plain alphanumeric is allowed', () => {
  assert.equal(isReservedAccelerator('Z').reserved, false);
  assert.equal(isReservedAccelerator('A').reserved, false);
  assert.equal(isReservedAccelerator('F1').reserved, false);
});

test('Ctrl/Shift/Alt+letter combos are allowed', () => {
  assert.equal(isReservedAccelerator('Ctrl+Shift+P').reserved, false);
  assert.equal(isReservedAccelerator('Alt+Z').reserved, false);
});

test('Ctrl+Alt+Delete is blocked', () => {
  const r = isReservedAccelerator('Ctrl+Alt+Delete');
  assert.equal(r.reserved, true);
  assert.match(r.reason ?? '', /OS/i);
});

test('Alt+F4 is blocked', () => {
  assert.equal(isReservedAccelerator('Alt+F4').reserved, true);
});

test('Alt+Tab is blocked', () => {
  assert.equal(isReservedAccelerator('Alt+Tab').reserved, true);
});

test('Win+anything is blocked (Windows key combos)', () => {
  assert.equal(isReservedAccelerator('Win+L').reserved, true);
  assert.equal(isReservedAccelerator('Win+R').reserved, true);
  assert.equal(isReservedAccelerator('Win+E').reserved, true);
});

test('Super+anything is blocked', () => {
  assert.equal(isReservedAccelerator('Super+L').reserved, true);
});

test('macOS Cmd+Q / Cmd+W / Cmd+Tab / Cmd+Space are blocked', () => {
  assert.equal(isReservedAccelerator('Cmd+Q').reserved, true);
  assert.equal(isReservedAccelerator('Cmd+W').reserved, true);
  assert.equal(isReservedAccelerator('Cmd+Tab').reserved, true);
  assert.equal(isReservedAccelerator('Cmd+Space').reserved, true);
});

test('case-insensitive', () => {
  assert.equal(isReservedAccelerator('alt+f4').reserved, true);
  assert.equal(isReservedAccelerator('CMD+Q').reserved, true);
});

test('empty / whitespace-only rejected', () => {
  assert.equal(isReservedAccelerator('').reserved, true);
  assert.equal(isReservedAccelerator('   ').reserved, true);
});

test('Cmd+other (non-blocked) is allowed', () => {
  assert.equal(isReservedAccelerator('Cmd+P').reserved, false);
});

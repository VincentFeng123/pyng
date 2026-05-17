// Tests for the pure parsing logic in hotkey.ts. The uiohook integration
// itself can't be tested in this Node-only suite — it requires the live
// native module + Accessibility permission. Use `_registerHotkeyForTest` +
// `triggerForTest` (which DON'T touch uiohook) for higher-level integration
// tests that need to drive hold-start / hold-end events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { UiohookKey } from 'uiohook-napi';
import {
  HotkeyParseError,
  _movementStateForTest,
  _registerHotkeyForTest,
  parseAccelerator,
  triggerForTest,
} from './hotkey.js';

test('parses single-key accelerator', () => {
  const r = parseAccelerator('Z');
  assert.equal(typeof r.keycode, 'number');
  assert.equal(r.requireCtrl, false);
  assert.equal(r.requireAlt, false);
  assert.equal(r.requireShift, false);
  assert.equal(r.requireMeta, false);
});

test('parses Ctrl+Shift+P', () => {
  const r = parseAccelerator('Ctrl+Shift+P');
  assert.equal(r.requireCtrl, true);
  assert.equal(r.requireShift, true);
  assert.equal(r.requireAlt, false);
  assert.equal(r.requireMeta, false);
});

test('parses Cmd+X (treats Cmd as meta)', () => {
  const r = parseAccelerator('Cmd+X');
  assert.equal(r.requireMeta, true);
});

test('parses Option+Z (treats Option as alt)', () => {
  const r = parseAccelerator('Option+Z');
  assert.equal(r.requireAlt, true);
});

test('case-insensitive modifiers', () => {
  const r = parseAccelerator('ctrl+shift+P');
  assert.equal(r.requireCtrl, true);
  assert.equal(r.requireShift, true);
});

test('rejects empty', () => {
  assert.throws(() => parseAccelerator(''), HotkeyParseError);
  assert.throws(() => parseAccelerator('   '), HotkeyParseError);
});

test('rejects multiple key tokens', () => {
  assert.throws(() => parseAccelerator('Z+X'), HotkeyParseError);
});

test('rejects no key token', () => {
  assert.throws(() => parseAccelerator('Ctrl+Alt'), HotkeyParseError);
});

test('rejects unknown key token', () => {
  assert.throws(() => parseAccelerator('Ctrl+Wat'), HotkeyParseError);
});

test('triggerForTest fires onHoldStart only once per session and is paired with onHoldEnd', () => {
  process.env.NODE_ENV = 'test';
  const events: string[] = [];
  const unsub = _registerHotkeyForTest({
    onHoldStart: () => events.push('start'),
    onHoldEnd: () => events.push('end'),
  });
  try {
    triggerForTest('hold-start');
    triggerForTest('hold-start'); // duplicate while held → ignored
    triggerForTest('hold-end');
    triggerForTest('hold-end'); // duplicate while released → ignored
    triggerForTest('hold-start');
    triggerForTest('hold-end');
    assert.deepEqual(events, ['start', 'end', 'start', 'end']);
  } finally {
    unsub();
  }
});

test('triggerForTest unsubscribe stops further events', () => {
  process.env.NODE_ENV = 'test';
  const events: string[] = [];
  const unsub = _registerHotkeyForTest({
    onHoldStart: () => events.push('start'),
    onHoldEnd: () => events.push('end'),
  });
  triggerForTest('hold-start');
  unsub();
  triggerForTest('hold-end');
  assert.deepEqual(events, ['start']);
});

test('movement key state reports WASD axes and actions', () => {
  process.env.NODE_ENV = 'test';
  const state = _movementStateForTest(
    [
      parseAccelerator('W').keycode,
      parseAccelerator('D').keycode,
      parseAccelerator('Space').keycode,
      UiohookKey.Shift,
    ],
    123,
  );

  assert.equal(state.forward, true);
  assert.equal(state.right, true);
  assert.equal(state.jump, true);
  assert.equal(state.sprint, true);
  assert.equal(state.horizontalAxis, 1);
  assert.equal(state.verticalAxis, 1);
  assert.equal(state.active, true);
  assert.equal(state.eventTimeNs, 123);
});

test('movement key state cancels opposite directions without losing activity', () => {
  process.env.NODE_ENV = 'test';
  const state = _movementStateForTest([
    parseAccelerator('W').keycode,
    parseAccelerator('S').keycode,
    parseAccelerator('A').keycode,
    parseAccelerator('D').keycode,
  ]);

  assert.equal(state.horizontalAxis, 0);
  assert.equal(state.verticalAxis, 0);
  assert.equal(state.active, true);
});

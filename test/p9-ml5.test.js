// 승5패 is not on the Betman NBA list (first capture 2026-10-23); shown as not offered and never evaluated
// (2026-10-23 approval). Display only: odds input, evaluation and picks are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TEXT, forbiddenIn } from '../engine/dashboard-data.js';
import { SELECTIONS } from '../engine/odds.js';

test('the 승5패 wording is fixed and passes the wording check', () => {
  assert.equal(TEXT.notOffered, '미제공');
  assert.equal(TEXT.ml5NotOffered, '승5패: 베트맨 미제공 — 평가 안 함');
  assert.deepEqual(forbiddenIn(TEXT.ml5NotOffered), []);
});

test('display only: the odds format still takes 승5패 with its three selections', () => {
  assert.deepEqual(SELECTIONS.ML5, ['home', 'close', 'away']);
});

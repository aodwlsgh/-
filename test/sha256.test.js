// The pick log's own SHA-256 (engine/pick-log.js) against standard test vectors (2026-10-23 user condition 2)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { sha256 } from '../engine/pick-log.js';

const VECTORS = [
  ['empty string', '', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
  ['"abc"', 'abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
  ['56 bytes (NIST, padding spills into a second block)', 'abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq', '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1'],
  ['55 bytes (largest single-block message)', 'a'.repeat(55), '9f4390f8d30c2dd92ec9f095b65e2b9ae9b0a925a5258e241c9f1e910f734318'],
  ['64 bytes (exactly one block of data)', 'a'.repeat(64), 'ffe054fe7ae0cb6dc65c3af9b61d5209f439851db43d0ba5997337df154668eb'],
  ['112 bytes (NIST, multiple blocks)', 'abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu', 'cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1'],
  ['one million "a" (NIST, many blocks)', 'a'.repeat(1e6), 'cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0'],
  ['Korean text (UTF-8, 34 bytes)', '기록 전용 — 구매 비권장', '3a1597740324dbf484cd51282e0f20dc037690d7f27611cd9b906cfb9ddd0e9e'],
];

for (const [name, input, expected] of VECTORS) {
  test(`SHA-256 test vector: ${name}`, () => assert.equal(sha256(input), expected));
}

test('SHA-256 equals node:crypto for every length 0..300 (block boundaries)', () => {
  for (let n = 0; n <= 300; n++) {
    const s = Array.from({ length: n }, (_, i) => String.fromCharCode(33 + ((i * 7) % 90))).join('');
    assert.equal(sha256(s), createHash('sha256').update(s).digest('hex'), `length ${n}`);
  }
});

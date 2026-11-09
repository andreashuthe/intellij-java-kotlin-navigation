// Run with: npm test   (pure Node, no VS Code needed)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createLimiter, hasBodyAfterName, CancelledError } = require('../out/util');
const s = require('../out/signature');

test('hasBodyAfterName – Kotlin interface members', () => {
  assert.equal(hasBodyAfterName('(who: Any, times: Int): String'), false);
  assert.equal(hasBodyAfterName('(who: Any): String = "hi"'), true);
  assert.equal(hasBodyAfterName('(x: Int = 1, f: (Int) -> Int = { it }): Int {'), true);
  assert.equal(hasBodyAfterName('(x: Int)\n    fun other() {'), false);
  assert.equal(hasBodyAfterName('() {'), true);
});

test('limiter runs at most N tasks at once', async () => {
  const limit = createLimiter(2);
  let active = 0;
  let peak = 0;
  const task = () => limit(async () => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(r => setTimeout(r, 10));
    active--;
  });
  await Promise.all(Array.from({ length: 8 }, task));
  assert.equal(peak, 2);
});

test('limiter drops queued tasks after cancellation', async () => {
  const token = { isCancellationRequested: false };
  const limit = createLimiter(1, token);
  let ran = 0;
  const p1 = limit(async () => {
    ran++;
    token.isCancellationRequested = true; // cancelled while the first request is running
  });
  const p2 = limit(async () => ran++);
  await p1;
  await assert.rejects(p2, CancelledError);
  assert.equal(ran, 1);
});

test('Kotlin and Java parameter types match', () => {
  assert.ok(s.paramsCompatible(['Any', 'Int'], ['Object', 'int']));
  assert.ok(s.paramsCompatible(['MutableList', 'Long'], ['List', 'long']));
  assert.ok(s.paramsCompatible(['IntArray', 'Array'], ['int[]', 'String[]']));
  assert.ok(s.paramsCompatible(['Boolean', 'Char'], ['boolean', 'char']));
  assert.ok(!s.paramsCompatible(['String'], ['Object']));
  assert.ok(!s.paramsCompatible(['Int'], ['long']));
  const javaSuper = [{ name: 'greet', params: ['Object', 'int'] }, { name: 'greet', params: ['String'] }];
  assert.equal(s.findMatchingMethod({ name: 'greet', params: ['Any', 'Int'] }, javaSuper), javaSuper[0]);
});

const { mapPosition, mapPositionAll, usageLabel } = require('../out/util');
const P = (line, character) => ({ line, character });
const C = (sl, sc, el, ec, text) => ({ start: P(sl, sc), end: P(el, ec), text });

test('mapPosition – edits before, after and around a declaration', () => {
  const name = P(10, 8);
  assert.deepEqual(mapPosition(name, C(2, 0, 2, 0, '\n\n')), P(12, 8)); // 2 lines inserted above
  assert.deepEqual(mapPosition(name, C(3, 0, 5, 0, '')), P(8, 8)); // 2 lines deleted above
  assert.deepEqual(mapPosition(name, C(20, 0, 20, 0, 'x')), name); // edit below
  assert.deepEqual(mapPosition(name, C(10, 4, 10, 4, 'abc')), P(10, 11)); // typed in front, same line
  assert.deepEqual(mapPosition(name, C(10, 20, 10, 20, 'abc')), name); // typed behind, same line
  assert.equal(mapPosition(name, C(9, 0, 11, 0, '')), undefined); // declaration deleted
  assert.deepEqual(mapPosition(name, C(10, 0, 10, 4, '\n  ')), P(11, 6)); // line split in front of it
});

test('mapPositionAll applies several changes in order', () => {
  assert.deepEqual(mapPositionAll(P(5, 2), [C(0, 0, 0, 0, '\n'), C(0, 0, 0, 0, '\n')]), P(7, 2));
  assert.equal(mapPositionAll(P(5, 2), [C(4, 0, 6, 0, ''), C(0, 0, 0, 0, '\n')]), undefined);
});

test('usageLabel uses IntelliJ wording', () => {
  assert.equal(usageLabel(0), 'no usages');
  assert.equal(usageLabel(1), '1 usage');
  assert.equal(usageLabel(7), '7 usages');
});

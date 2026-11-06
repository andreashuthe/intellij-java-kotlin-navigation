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

// Run with: npm test   (pure Node, no VS Code needed)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const s = require('../out/signature');

test('normalizeType', () => {
  assert.equal(s.normalizeType('java.util.List<String>'), 'List');
  assert.equal(s.normalizeType('Map<String, List<Long>>[]'), 'Map[]');
  assert.equal(s.normalizeType('String...'), 'String[]');
  assert.equal(s.normalizeType('@NonNull Object'), 'Object');
  assert.equal(s.normalizeType('String?'), 'String');
});

test('parseParameterTypes – Java', () => {
  assert.deepEqual(s.parseParameterTypes('(Object object);', 'java'), ['Object']);
  assert.deepEqual(s.parseParameterTypes('(Object object, Long id) {', 'java'), ['Object', 'Long']);
  assert.deepEqual(s.parseParameterTypes('(Class clazz, Long id);', 'java'), ['Class', 'Long']);
  assert.deepEqual(s.parseParameterTypes('();', 'java'), []);
  assert.deepEqual(s.parseParameterTypes('(final Map<String, Integer> m, @Nullable String... rest) {', 'java'), ['Map', 'String[]']);
  assert.deepEqual(s.parseParameterTypes('(int a[], byte[] b) {', 'java'), ['int[]', 'byte[]']);
});

test('parseParameterTypes – Kotlin', () => {
  assert.deepEqual(s.parseParameterTypes('(obj: Any, id: Long = 0L): Any', 'kotlin'), ['Any', 'Long']);
  assert.deepEqual(s.parseParameterTypes('(vararg xs: String, m: Map<String, Int>?)', 'kotlin'), ['String[]', 'Map']);
});

test('symbol names that already contain the signature', () => {
  assert.equal(s.bareName('contains(Object) : boolean'), 'contains');
  assert.deepEqual(s.typesFromSymbolName('get(Class<?>, Long)'), ['Class', 'Long']);
  assert.equal(s.typesFromSymbolName('flush'), undefined);
});

test('findMatchingMethod', () => {
  const cands = [
    { name: 'load', params: ['Object', 'Long'] },
    { name: 'load', params: ['Object'] },
    { name: 'save', params: ['T'] },
  ];
  assert.equal(s.findMatchingMethod({ name: 'load', params: ['Object', 'Long'] }, cands), cands[0]);
  assert.equal(s.findMatchingMethod({ name: 'load', params: ['Object'] }, cands), cands[1]);
  assert.equal(s.findMatchingMethod({ name: 'save', params: ['Customer'] }, cands), cands[2]); // generic T
  assert.equal(s.findMatchingMethod({ name: 'load', params: ['String', 'String', 'String'] }, cands), undefined);
  assert.equal(s.findMatchingMethod({ name: 'delete', params: [] }, cands), undefined);
});

test('parseSupertypeRefs – Java', () => {
  const h = ' extends HibernateDaoSupport implements EntityRepository, Comparable<Foo> ';
  const refs = s.parseSupertypeRefs(h, 'java');
  assert.deepEqual(refs.map(r => r.name), ['HibernateDaoSupport', 'EntityRepository', 'Comparable']);
  for (const r of refs) assert.equal(h.slice(r.offset, r.offset + r.name.length), r.name);
  assert.deepEqual(s.parseSupertypeRefs('<T extends Number> extends com.x.Base<T>', 'java').map(r => r.name).slice(-1), ['Base']);
  assert.deepEqual(s.parseSupertypeRefs(' extends IRepository ', 'java').map(r => r.name), ['IRepository']);
});

test('parseSupertypeRefs – Kotlin', () => {
  const h = '(val x: Int) : Base(x), Repo<Foo>, Other by delegate ';
  assert.deepEqual(s.parseSupertypeRefs(h, 'kotlin').map(r => r.name), ['Base', 'Repo', 'Other']);
});

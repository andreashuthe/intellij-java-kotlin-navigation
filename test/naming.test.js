// Run with: npm test   (pure Node, no VS Code needed)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const n = require('../out/naming');

test('test class names for a subject', () => {
  assert.deepEqual(n.testNamesFor('OrderService'), [
    'OrderServiceTest', 'OrderServiceTests', 'OrderServiceIT', 'OrderServiceIntegrationTest', 'OrderServiceSpec', 'TestOrderService',
  ]);
});

test('subject name of a test class', () => {
  assert.equal(n.subjectNameOf('OrderServiceTest'), 'OrderService');
  assert.equal(n.subjectNameOf('OrderServiceTests'), 'OrderService');
  assert.equal(n.subjectNameOf('OrderServiceIT'), 'OrderService');
  assert.equal(n.subjectNameOf('OrderServiceIntegrationTest'), 'OrderService');
  assert.equal(n.subjectNameOf('TestOrderService'), 'OrderService');
  assert.equal(n.subjectNameOf('OrderService'), undefined);
  assert.equal(n.subjectNameOf('Contest'), undefined); // lower-case "test" is not a suffix
  assert.equal(n.subjectNameOf('Testament'), undefined);
  assert.equal(n.subjectNameOf('Test'), undefined);
});

test('test or not: source folder wins over the name', () => {
  assert.equal(n.isTestFile('/p/src/test/java/a/OrderServiceTest.java', 'OrderServiceTest'), true);
  assert.equal(n.isTestFile('/p/src/test/java/a/Fixtures.java', 'Fixtures'), true);
  assert.equal(n.isTestFile('/p/src/main/java/a/AbTest.java', 'AbTest'), false); // a domain class called "…Test"
  assert.equal(n.isTestFile('/p/src/integrationTest/kotlin/a/FooIT.kt', 'FooIT'), true);
  assert.equal(n.isTestFile('/p/lib/FooTest.java', 'FooTest'), true); // no Maven layout → by name
  assert.equal(n.isTestFile('C:\\p\\src\\test\\java\\a\\FooTest.java', 'FooTest'), true); // Windows paths
});

test('main ↔ test directories', () => {
  assert.equal(n.testDirFor('/p/mod/src/main/java/com/acme/OrderService.java'), '/p/mod/src/test/java/com/acme');
  assert.equal(n.testDirFor('/p/mod/src/main/kotlin/com/acme/Order.kt'), '/p/mod/src/test/kotlin/com/acme');
  assert.equal(n.testDirFor('/p/lib/Foo.java'), '/p/lib');
  assert.equal(n.subjectDirFor('/p/mod/src/test/java/com/acme/OrderServiceTest.java'), '/p/mod/src/main/java/com/acme');
  assert.equal(n.subjectDirFor('/p/mod/src/integrationTest/java/com/acme/OrderServiceIT.java'), '/p/mod/src/main/java/com/acme');
});

test('ranking prefers the expected package, then the same module', () => {
  const from = '/p/a/src/main/java/com/acme/OrderService.java';
  const exp = '/p/a/src/test/java/com/acme';
  const exact = n.rankCandidate('/p/a/src/test/java/com/acme/OrderServiceTest.java', exp, from);
  const otherPkg = n.rankCandidate('/p/a/src/test/java/com/other/OrderServiceTest.java', exp, from);
  const kotlinSamePkg = n.rankCandidate('/p/a/src/test/kotlin/com/acme/OrderServiceTest.kt', exp, from);
  const otherModule = n.rankCandidate('/p/b/src/test/java/com/acme/OrderServiceTest.java', exp, from);
  assert.ok(exact < kotlinSamePkg && kotlinSamePkg < otherPkg && otherPkg < otherModule, [exact, kotlinSamePkg, otherPkg, otherModule].join());
});

test('package and JUnit detection', () => {
  assert.equal(n.packageOf('// header\npackage com.acme.orders;\n\nclass X {}'), 'com.acme.orders');
  assert.equal(n.packageOf('package com.acme\n\nclass X'), 'com.acme');
  assert.equal(n.packageOf('class X {}'), undefined);
  assert.equal(n.junitVersionOf(['<dependency><groupId>org.junit.jupiter</groupId></dependency>']), 5);
  assert.equal(n.junitVersionOf(['testImplementation "junit:junit:4.13.2"']), 4);
  assert.equal(n.junitVersionOf(['<artifactId>junit</artifactId><version>4.13</version>']), 4);
  assert.equal(n.junitVersionOf(['spring-boot-starter-test']), 5);
  assert.equal(n.junitVersionOf([]), 5);
});

test('test skeletons', () => {
  const j5 = n.testSource({ lang: 'java', pkg: 'com.acme', testName: 'OrderServiceTest', junit: 5 });
  assert.equal(j5.text, 'package com.acme;\n\nimport org.junit.jupiter.api.Test;\n\nclass OrderServiceTest {\n\n    @Test\n    void test() {\n        \n    }\n}\n');
  assert.equal(j5.text.split('\n')[j5.cursorLine], '        ');
  const j4 = n.testSource({ lang: 'java', testName: 'FooTest', junit: 4 });
  assert.match(j4.text, /^import org\.junit\.Test;\n\npublic class FooTest \{\n\n    @Test\n    public void test\(\) \{/);
  const kt = n.testSource({ lang: 'kotlin', pkg: 'com.acme', testName: 'OrderTest', junit: 5 });
  assert.match(kt.text, /^package com\.acme\n\nimport org\.junit\.jupiter\.api\.Test\n\nclass OrderTest \{\n\n    @Test\n    fun test\(\) \{/);
});

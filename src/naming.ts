/**
 * Pure helpers for "Go to Test / Test Subject" (no `vscode` import, unit-testable with plain Node).
 * Conventions follow IntelliJ: Foo ↔ FooTest, FooTests, FooIT, FooIntegrationTest, FooSpec, TestFoo;
 * src/main/{java,kotlin}/a/b ↔ src/test/{java,kotlin}/a/b.
 */

/** Longest first, so `FooIntegrationTest` maps to `Foo` and not to `FooIntegration`. */
const TEST_SUFFIXES = ['IntegrationTest', 'Tests', 'Test', 'Spec', 'IT'];

/** Candidate test class names for a class under test, most common first. */
export function testNamesFor(subject: string): string[] {
  return [`${subject}Test`, `${subject}Tests`, `${subject}IT`, `${subject}IntegrationTest`, `${subject}Spec`, `Test${subject}`];
}

/** If `name` looks like a test class name, the name of the class it tests. */
export function subjectNameOf(name: string): string | undefined {
  for (const s of TEST_SUFFIXES) {
    if (name.length > s.length && name.endsWith(s)) return name.slice(0, -s.length);
  }
  if (/^Test[A-Z]/.test(name)) return name.slice(4);
  return undefined;
}

const TEST_ROOT = /\/src\/(test|it|integrationTest|testIntegration|intTest)\//;
const MAIN_ROOT = /\/src\/main\//;

/** Is this file a test? The source folder decides; without a Maven/Gradle layout the class name does. */
export function isTestFile(path: string, className: string): boolean {
  const p = path.replace(/\\/g, '/');
  if (TEST_ROOT.test(p)) return true;
  if (MAIN_ROOT.test(p)) return false;
  return subjectNameOf(className) !== undefined;
}

/** Directory a new test for `subjectPath` should go to (src/main/… → src/test/…, else next to it). */
export function testDirFor(subjectPath: string): string {
  const p = subjectPath.replace(/\\/g, '/');
  const dir = p.slice(0, p.lastIndexOf('/'));
  return MAIN_ROOT.test(p) ? dir.replace(MAIN_ROOT, '/src/test/') : dir;
}

/** Directory the class under test is expected in (src/test/… → src/main/…). */
export function subjectDirFor(testPath: string): string {
  const p = testPath.replace(/\\/g, '/');
  const dir = p.slice(0, p.lastIndexOf('/'));
  return TEST_ROOT.test(p) ? dir.replace(TEST_ROOT, '/src/main/') : dir;
}

/** Module root: everything before `/src/` (or the directory itself). */
function moduleOf(path: string): string {
  const p = path.replace(/\\/g, '/');
  const i = p.lastIndexOf('/src/');
  return i >= 0 ? p.slice(0, i) : p.slice(0, p.lastIndexOf('/'));
}

/** Lower is better: expected package directory < same module < same language < anything else. */
export function rankCandidate(candidatePath: string, expectedDir: string, fromPath: string): number {
  const c = candidatePath.replace(/\\/g, '/');
  const dir = c.slice(0, c.lastIndexOf('/'));
  const sameLangDir = (d: string) => d.replace(/\/(java|kotlin)\//, '/{lang}/');
  let score = 0;
  if (dir !== expectedDir) score += 1;
  if (sameLangDir(dir) !== sameLangDir(expectedDir)) score += 1;
  if (moduleOf(c) !== moduleOf(fromPath)) score += 2;
  return score;
}

/** `package a.b;` (Java) or `package a.b` (Kotlin) */
export function packageOf(source: string): string | undefined {
  return source.match(/^\s*package\s+([\w.]+)/m)?.[1];
}

export type JUnit = 4 | 5;

/** JUnit version from build files: JUnit 5 unless only JUnit 4 is referenced. */
export function junitVersionOf(buildFiles: string[]): JUnit {
  const all = buildFiles.join('\n');
  if (/junit-jupiter|org\.junit\.jupiter|useJUnitPlatform|spring-boot-starter-test|kotest/.test(all)) return 5;
  if (/junit:junit|<artifactId>junit<\/artifactId>|"junit:junit/.test(all)) return 4;
  return 5;
}

/** Skeleton of a new test class (like IntelliJ's "Create Test" with one empty test). */
export function testSource(opts: { lang: 'java' | 'kotlin'; pkg?: string; testName: string; junit: JUnit }): { text: string; cursorLine: number } {
  const { lang, pkg, testName, junit } = opts;
  const imp = junit === 5 ? 'org.junit.jupiter.api.Test' : 'org.junit.Test';
  const lines: string[] = [];
  if (lang === 'java') {
    if (pkg) lines.push(`package ${pkg};`, '');
    lines.push(`import ${imp};`, '');
    lines.push(`${junit === 5 ? '' : 'public '}class ${testName} {`, '');
    lines.push('    @Test');
    lines.push(`    ${junit === 5 ? '' : 'public '}void test() {`);
    const cursorLine = lines.length;
    lines.push('        ', '    }', '}', '');
    return { text: lines.join('\n'), cursorLine };
  }
  if (pkg) lines.push(`package ${pkg}`, '');
  lines.push(`import ${imp}`, '');
  lines.push(`class ${testName} {`, '');
  lines.push('    @Test');
  lines.push('    fun test() {');
  const cursorLine = lines.length;
  lines.push('        ', '    }', '}', '');
  return { text: lines.join('\n'), cursorLine };
}

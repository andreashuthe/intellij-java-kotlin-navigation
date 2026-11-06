// Generates a large Java/Kotlin hierarchy for the performance benchmark.
const fs = require('fs');
const path = require('path');
module.exports = function generate(dir, n = 150) {
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const w = (f, s) => fs.writeFileSync(path.join(dir, f), s);
  const sig = i => `Object m${i}(Object a${i}, Long id${i})`;
  // Base interface (20 methods) and big interface (n methods)
  w('BaseRepository.java', `package perf;\n\npublic interface BaseRepository {\n${Array.from({ length: 20 }, (_, i) => `    public void base${i}(String s);\n`).join('\n')}}\n`);
  w('BigRepository.java', `package perf;\n\n/** Big interface. */\npublic interface BigRepository extends BaseRepository {\n${Array.from({ length: n }, (_, i) => `    /** Method ${i}. */\n    public ${sig(i)};\n`).join('\n')}}\n`);
  // Abstract base implementing half of the methods
  w('AbstractBigDao.java', `package perf;\n\npublic abstract class AbstractBigDao implements BigRepository {\n${Array.from({ length: n / 2 }, (_, i) => `    public ${sig(i)} {\n        return null;\n    }\n`).join('\n')}}\n`);
  // Concrete DAO implementing everything (+ private helpers)
  const body = [];
  for (let i = 0; i < n; i++) body.push(`    public ${sig(i)} {\n        // work ${i}\n        return null;\n    }\n`);
  for (let i = 0; i < 20; i++) body.push(`    public void base${i}(String s) {\n    }\n`);
  for (let i = 0; i < 30; i++) body.push(`    private void helper${i}() {\n    }\n`);
  w('BigDao.java', `package perf;\n\npublic class BigDao extends AbstractBigDao {\n${body.join('\n')}}\n`);
  // Three subclasses overriding a few methods
  for (const s of ['A', 'B', 'C']) {
    w(`BigDao${s}.java`, `package perf;\n\npublic class BigDao${s} extends BigDao {\n${Array.from({ length: 30 }, (_, i) => `    public ${sig(i * 5)} {\n        return null;\n    }\n`).join('\n')}}\n`);
  }
  // Kotlin: a final class with many methods (nothing can override them)
  w('KotlinService.kt', `package perf\n\nclass KotlinService : BaseRepository {\n${Array.from({ length: 20 }, (_, i) => `    override fun base${i}(s: String) {\n    }\n`).join('\n')}\n${Array.from({ length: 80 }, (_, i) => `    fun work${i}(x: Int): Int {\n        return x\n    }\n`).join('\n')}}\n`);
};

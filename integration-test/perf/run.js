// node integration-test/perf/run.js [latencyMs] [outFile] [suite]   (needs a display: xvfb-run on Linux)
//   suite: "suite" (default – open/edit big files) or "workflows" (autosave, multi-file edit, tab switch, external changes)
const path = require('path');
const os = require('os');
const { runTests } = require('@vscode/test-electron');
const generate = require('./gen-fixture');
(async () => {
  const root = path.resolve(__dirname, '..', '..');
  const fixture = path.join(os.tmpdir(), 'ijnav-perf-fixture');
  generate(fixture);
  const out = path.resolve(process.argv[3] || 'perf-results.json');
  process.env.MOCK_FIXTURE_DIR = fixture;
  process.env.MOCK_LATENCY_MS = process.argv[2] || '15';
  process.env.PERF_OUT = out;
  await runTests({
    extensionDevelopmentPath: [root, path.join(root, 'integration-test', 'mock-lsp')],
    extensionTestsPath: path.join(__dirname, `${process.argv[4] || 'suite'}.js`),
    launchArgs: [fixture, '--disable-extensions', '--disable-gpu', '--no-sandbox'],
    extensionTestsEnv: { MOCK_FIXTURE_DIR: fixture, MOCK_LATENCY_MS: process.env.MOCK_LATENCY_MS, PERF_OUT: out },
  });
  console.log(require('fs').readFileSync(out, 'utf8'));
})().catch(e => { console.error(e); process.exit(1); });

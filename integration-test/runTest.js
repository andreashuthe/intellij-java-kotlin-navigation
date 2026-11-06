const path = require('path');
const { runTests } = require('@vscode/test-electron');
(async () => {
  const root = path.resolve(__dirname, '..');
  try {
    await runTests({
      extensionDevelopmentPath: [root, path.join(__dirname, 'mock-lsp')],
      extensionTestsPath: path.join(__dirname, 'suite.js'),
      launchArgs: [path.join(__dirname, 'fixture'), '--disable-extensions', '--disable-gpu', '--no-sandbox'],
    });
  } catch (e) { console.error('Integration tests failed', e); process.exit(1); }
})();

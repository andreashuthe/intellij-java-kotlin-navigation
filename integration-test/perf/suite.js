// Runs inside the extension host. Measures cold + warm analysis of large files.
const vscode = require('vscode');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = process.env.MOCK_FIXTURE_DIR;

async function waitFor(api, doc, sinceVersion) {
  const t0 = Date.now();
  for (;;) {
    const info = api.markersInfo(doc.uri);
    if (info && info.version === doc.version && info.version !== sinceVersion) return { ms: Date.now() - t0, n: info.markers.length };
    if (Date.now() - t0 > 120000) throw new Error('timeout ' + doc.uri.fsPath);
    await sleep(10);
  }
}

function dumpMarkers(ms) {
  const t = n => n ? n.kind + '[' + n.targets.map(x => `${x.label}@${x.line}:${x.character}`).sort().join(',') + ']' : '-';
  return ms.map(m => `${m.range.start.line}:${m.member}:${m.name} up=${t(m.up)} down=${t(m.down)}`);
}

async function scenario(api, file, edit) {
  await vscode.commands.executeCommand('mockLsp.reset');
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(dir, file)));
  const editor = await vscode.window.showTextDocument(doc);
  const cpu0 = process.cpuUsage();
  const t0 = Date.now();
  const r = await waitFor(api, doc);
  const dump = dumpMarkers(api.markersInfo(doc.uri).markers);
  const cold = { analysisMs: api.markersInfo(doc.uri).ms, ms: Date.now() - t0, markers: r.n, cpuMs: Math.round((process.cpuUsage(cpu0).user + process.cpuUsage(cpu0).system) / 1000), requests: await vscode.commands.executeCommand('mockLsp.stats') };
  let warm;
  if (edit) {
    await sleep(300);
    await vscode.commands.executeCommand('mockLsp.reset');
    const v = doc.version;
    const cpu1 = process.cpuUsage();
    const t1 = Date.now();
    // simulate a short typing burst at the end of the file
    for (const ch of ['/', '/', ' ', 'x']) {
      await editor.edit(e => e.insert(new vscode.Position(doc.lineCount - 1, 0), ch));
      await sleep(80);
    }
    const r2 = await waitFor(api, doc, v);
    warm = { ms: Date.now() - t1, markers: r2.n, cpuMs: Math.round((process.cpuUsage(cpu1).user + process.cpuUsage(cpu1).system) / 1000), requests: await vscode.commands.executeCommand('mockLsp.stats') };
    await vscode.commands.executeCommand('workbench.action.files.revert');
  }
  return { file, cold, warm, dump };
}

exports.run = async () => {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'intellij-java-kotlin-navigation');
  const api = await ext.activate();
  await vscode.extensions.all.find(e => e.packageJSON.name === 'mock-java-lsp').activate();
  await vscode.workspace.getConfiguration('intellijNav').update('refreshDelay', 300, vscode.ConfigurationTarget.Global);
  const results = [];
  results.push(await scenario(api, 'BigDao.java', true));
  results.push(await scenario(api, 'BigRepository.java', false));
  results.push(await scenario(api, 'KotlinService.kt', false));
  // same big file again after closing it and dropping all caches: cold analysis in an already warm VS Code
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  await vscode.commands.executeCommand('intellijNav.refresh');
  results.push(await scenario(api, 'BigDao.java', false));
  require('fs').writeFileSync(process.env.PERF_OUT, JSON.stringify(results, null, 2));
};

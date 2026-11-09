// Realistic workflows (runs inside the extension host): request counts and CPU of the extension host.
//   autosave      – type + save every ~300 ms (files.autoSave "afterDelay")
//   multiFileEdit – a refactoring changes 6 files that are not open in an editor
//   tabSwitch     – switch between two big editors 30 times
//   idle          – nothing happens: no requests, (almost) no CPU
//   externalBurst – 300 files created and deleted outside VS Code (git checkout, build)
const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const dir = process.env.MOCK_FIXTURE_DIR;
const uri = f => vscode.Uri.file(path.join(dir, f));
const stats = () => vscode.commands.executeCommand('mockLsp.stats');
const reset = () => vscode.commands.executeCommand('mockLsp.reset');
const cpu = c0 => {
  const c = process.cpuUsage(c0);
  return Math.round((c.user + c.system) / 1000);
};

async function settle(api, doc) {
  for (let i = 0; i < 600 && api.markersInfo(doc.uri)?.version !== doc.version; i++) await sleep(20);
  await sleep(2500); // usages of the visible members
}

exports.run = async () => {
  const api = await vscode.extensions.all.find(e => e.packageJSON.name === 'intellij-java-kotlin-navigation').activate();
  await vscode.extensions.all.find(e => e.packageJSON.name === 'mock-java-lsp').activate();
  await vscode.workspace.getConfiguration('intellijNav').update('refreshDelay', 300, vscode.ConfigurationTarget.Global);
  const results = {};

  // ---- autosave while typing
  const dao = await vscode.workspace.openTextDocument(uri('BigDao.java'));
  const ed = await vscode.window.showTextDocument(dao);
  await settle(api, dao);
  await reset();
  let c0 = process.cpuUsage();
  for (let i = 0; i < 8; i++) {
    await ed.edit(e => e.insert(new vscode.Position(dao.lineCount - 1, 0), '// x\n'));
    await dao.save();
    await sleep(300);
  }
  await settle(api, dao);
  results.autosave = { requests: await stats(), cpuMs: cpu(c0) };
  // undo the edits on disk
  await ed.edit(e => e.delete(new vscode.Range(dao.lineCount - 9, 0, dao.lineCount - 1, 0)));
  await dao.save();
  await settle(api, dao);

  // ---- refactoring touching files that are not shown
  await reset();
  c0 = process.cpuUsage();
  const we = new vscode.WorkspaceEdit();
  for (const f of ['BigRepository.java', 'AbstractBigDao.java', 'BigDaoA.java', 'BigDaoB.java', 'BigDaoC.java', 'BaseRepository.java']) {
    const d = await vscode.workspace.openTextDocument(uri(f)); // open as model only (like a rename refactoring)
    we.insert(d.uri, new vscode.Position(1, 0), '// refactored\n');
  }
  await vscode.workspace.applyEdit(we);
  await sleep(3000);
  results.multiFileEdit = { requests: await stats(), cpuMs: cpu(c0) };
  for (const d of vscode.workspace.textDocuments) if (d.isDirty && d.uri.fsPath.startsWith(dir)) {
    const w = new vscode.WorkspaceEdit();
    w.delete(d.uri, new vscode.Range(1, 0, 2, 0));
    await vscode.workspace.applyEdit(w);
  }
  await sleep(1500);

  // ---- tab switching
  const repo = await vscode.workspace.openTextDocument(uri('BigRepository.java'));
  await vscode.window.showTextDocument(repo, vscode.ViewColumn.One);
  await settle(api, repo);
  await vscode.window.showTextDocument(dao, vscode.ViewColumn.One);
  await settle(api, dao);
  await reset();
  c0 = process.cpuUsage();
  for (let i = 0; i < 30; i++) {
    await vscode.window.showTextDocument(i % 2 ? dao : repo, vscode.ViewColumn.One);
    await sleep(60);
  }
  await sleep(1500);
  results.tabSwitch = { requests: await stats(), cpuMs: cpu(c0) };
  // ---- idle: after VS Code's own delayed housekeeping, the extension must not do any work (no loops/timers)
  await sleep(6000);
  await reset();
  c0 = process.cpuUsage();
  await sleep(5000);
  results.idle = { requests: await stats(), cpuMs: cpu(c0) };

  // ---- burst of external file changes
  const ext = path.join(dir, 'generated');
  fs.mkdirSync(ext, { recursive: true });
  await sleep(500);
  await reset();
  c0 = process.cpuUsage();
  for (let i = 0; i < 300; i++) fs.writeFileSync(path.join(ext, `Gen${i}.java`), `package perf;\nclass Gen${i} {}\n`);
  await sleep(2500);
  fs.rmSync(ext, { recursive: true, force: true });
  await sleep(2500);
  results.externalBurst = { requests: await stats(), cpuMs: cpu(c0) };

  fs.writeFileSync(process.env.PERF_OUT, JSON.stringify(results, null, 2));
};

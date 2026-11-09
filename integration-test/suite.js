const vscode = require('vscode');
const path = require('path');
const assert = require('assert');
const fx = f => vscode.Uri.file(path.join(__dirname, 'fixture', f));
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function markersOf(api, file) {
  const doc = await vscode.workspace.openTextDocument(fx(file));
  await vscode.window.showTextDocument(doc);
  for (let i = 0; i < 60; i++) { const m = api.markers(doc.uri); if (m) return m; await sleep(250); }
  throw new Error('no markers for ' + file);
}
/** Inlay hints of a file as "line:label" (1-based lines), polled until `ready(labels)` is true. */
async function hintsOf(file, ready) {
  const doc = await vscode.workspace.openTextDocument(fx(file));
  await vscode.window.showTextDocument(doc);
  let labels = [];
  for (let i = 0; i < 100; i++) {
    const hints = (await vscode.commands.executeCommand('vscode.executeInlayHintProvider', doc.uri, new vscode.Range(0, 0, doc.lineCount, 0))) || [];
    labels = hints.map(h => `${h.position.line + 1}:${typeof h.label === 'string' ? h.label : h.label.map(p => p.value).join('')}`);
    if (ready(labels)) return { doc, labels };
    await sleep(200);
  }
  throw new Error(`hints for ${file} not ready:\n${labels.join('\n')}`);
}
const fmt = ms => ms.map(m => `${m.range.start.line + 1}:${m.name} up=${m.up ? m.up.kind + '[' + m.up.targets.map(t => t.label).join(',') + ']' : '-'} down=${m.down ? m.down.kind + '[' + m.down.targets.map(t => t.label).join(',') + ']' : '-'}`);
exports.run = async () => {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'intellij-java-kotlin-navigation');
  const api = await ext.activate();
  const results = {};
  for (const f of ['EntityRepository.java', 'EntityRepositoryDao.java', 'SpecialDao.java', 'IRepository.java', 'Greeter.java', 'BaseGreeter.kt', 'FancyGreeter.kt', 'KotlinGreeter.kt']) {
    results[f] = fmt(await markersOf(api, f));
    console.log('\n== ' + f + '\n' + results[f].join('\n'));
  }
  const repo = results['EntityRepository.java'];
  assert.ok(repo.includes('3:EntityRepository up=- down=I[EntityRepositoryDao,SpecialDao]'));
  assert.ok(repo.includes('4:contains up=- down=I[EntityRepositoryDao]'));
  assert.ok(repo.includes('14:flush up=I[IRepository] down=I[EntityRepositoryDao,SpecialDao]'));
  const dao = results['EntityRepositoryDao.java'];
  assert.ok(dao.includes('4:EntityRepositoryDao up=- down=O[SpecialDao]'));
  assert.ok(dao.includes('6:contains up=I[EntityRepository] down=-'));
  assert.ok(dao.includes('17:lock up=I[EntityRepository] down=O[SpecialDao]'));
  assert.ok(dao.includes('24:flush up=I[EntityRepository,IRepository] down=O[SpecialDao]'));
  assert.ok(!dao.some(l => l.includes(':create') || l.includes(':helper')));
  const sp = results['SpecialDao.java'];
  assert.ok(sp.includes('5:flush up=O[EntityRepositoryDao,EntityRepository,IRepository] down=-'), sp.join('\n'));
  assert.ok(sp.includes('8:lock up=O[EntityRepositoryDao,EntityRepository] down=-'));
  // Mixed Java/Kotlin: Kotlin `Any`/`Int` must match Java `Object`/`int`; Kotlin classes are final by default
  const eq = (file, expected) => assert.deepStrictEqual(results[file], expected, `${file}:\n${results[file].join('\n')}`);
  eq('Greeter.java', [
    '3:Greeter up=- down=I[BaseGreeter,FancyGreeter,KotlinGreeter]',
    '4:greet up=- down=I[BaseGreeter,FancyGreeter,KotlinGreeter]',
  ]);
  eq('BaseGreeter.kt', [
    '3:BaseGreeter up=- down=O[FancyGreeter]',
    '4:greet up=I[Greeter] down=O[FancyGreeter]',
  ]);
  eq('FancyGreeter.kt', ['4:greet up=O[BaseGreeter,Greeter] down=-']);
  eq('KotlinGreeter.kt', ['4:greet up=I[Greeter] down=-']);
  // Usages ("7 usages"): fields (also private), methods, types; no hint for constructors and @Test methods
  const svcExpected = ['3:1 usage', '4:4 usages', '5:no usages', '11:1 usage', '15:no usages'];
  const svc = await hintsOf('EntityService.java', l => svcExpected.every(x => l.includes(x)));
  console.log('\n== usages EntityService.java\n' + svc.labels.join('\n'));
  assert.deepStrictEqual(svc.labels, svcExpected);
  const testExpected = ['3:no usages', '5:1 usage'];
  const tst = await hintsOf('EntityServiceTest.java', l => testExpected.every(x => l.includes(x)));
  console.log('== usages EntityServiceTest.java\n' + tst.labels.join('\n'));
  assert.deepStrictEqual(tst.labels, testExpected, 'no usage hint for @Test methods');
  // usage counts combine with navigation hints on the same line
  const daoHints = await hintsOf('EntityRepositoryDao.java', l => l.some(x => /^6:\S.* usages?\s+↑ EntityRepository$/.test(x) || /^6:no usages\s+↑ EntityRepository$/.test(x)));
  console.log('== EntityRepositoryDao.java (combined)\n' + daoHints.labels.slice(0, 3).join('\n'));

  // While typing, hints move along with their declarations instead of disappearing
  const editor = await vscode.window.showTextDocument(svc.doc);
  await editor.edit(e => e.insert(new vscode.Position(1, 0), '\n\n'));
  const moved = (await vscode.commands.executeCommand('vscode.executeInlayHintProvider', svc.doc.uri, new vscode.Range(0, 0, svc.doc.lineCount, 0)))
    .map(h => `${h.position.line + 1}:${typeof h.label === 'string' ? h.label : h.label.map(p => p.value).join('')}`);
  console.log('== right after inserting 2 lines\n' + moved.join('\n'));
  assert.deepStrictEqual(moved, ['5:1 usage', '6:4 usages', '7:no usages', '13:1 usage', '17:no usages']);
  await vscode.commands.executeCommand('workbench.action.files.revert');

  console.log('\nALL INTEGRATION ASSERTIONS PASSED');
};

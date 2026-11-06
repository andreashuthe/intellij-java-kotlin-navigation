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
const fmt = ms => ms.map(m => `${m.range.start.line + 1}:${m.name} up=${m.up ? m.up.kind + '[' + m.up.targets.map(t => t.label).join(',') + ']' : '-'} down=${m.down ? m.down.kind + '[' + m.down.targets.map(t => t.label).join(',') + ']' : '-'}`);
exports.run = async () => {
  const ext = vscode.extensions.all.find(e => e.packageJSON.name === 'intellij-java-kotlin-navigation');
  const api = await ext.activate();
  const results = {};
  for (const f of ['EntityRepository.java', 'EntityRepositoryDao.java', 'SpecialDao.java', 'IRepository.java']) {
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
  console.log('\nALL INTEGRATION ASSERTIONS PASSED');
};

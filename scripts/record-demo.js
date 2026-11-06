/**
 * Records docs/demo.gif: drives a real VS Code (downloaded by `npm run test:integration`)
 * with the mock Java language server from integration-test/ and records a video.
 *
 *   npm run test:integration          # once, downloads VS Code into .vscode-test/
 *   npm i --no-save playwright
 *   xvfb-run -a node scripts/record-demo.js   # Linux; on macOS just `node scripts/record-demo.js`
 *   (needs ffmpeg on PATH)
 */
const { _electron } = require('playwright');
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const root = path.resolve(__dirname, '..');
const fixture = path.join(root, 'integration-test', 'fixture');
const W = 1280;
const H = 720;

function findCode() {
  const base = path.join(root, '.vscode-test');
  const dir = fs.readdirSync(base).find(d => d.startsWith('vscode-'));
  if (!dir) throw new Error('Run `npm run test:integration` first to download VS Code');
  const candidates = [
    path.join(base, dir, 'code'),
    path.join(base, dir, 'Visual Studio Code.app', 'Contents', 'MacOS', 'Electron'),
    path.join(base, dir, 'Code.exe'),
  ];
  return candidates.find(c => fs.existsSync(c));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ijnav-demo-'));
  const userData = path.join(tmp, 'user');
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'workbench.tips.enabled': false,
      'workbench.colorTheme': 'Default Dark Modern',
      'chat.disableAIFeatures': true,
      'window.commandCenter': false,
      'window.title': '${activeEditorShort} — ${rootName}',
      'editor.fontSize': 16,
      'editor.lineHeight': 26,
      'editor.minimap.enabled': false,
      'editor.renderLineHighlight': 'none',
      'editor.occurrencesHighlight': 'off',
      'editor.selectionHighlight': false,
      'editor.guides.indentation': false,
      'editor.stickyScroll.enabled': false,
      'breadcrumbs.enabled': false,
      'git.enabled': false,
      'explorer.openEditors.visible': 0,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
    }),
  );
  const videoDir = path.join(tmp, 'video');
  const app = await _electron.launch({
    executablePath: findCode(),
    args: [
      '--no-sandbox', '--disable-gpu', '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes',
      `--user-data-dir=${userData}`, `--extensions-dir=${path.join(tmp, 'ext')}`,
      `--extensionDevelopmentPath=${root}`, `--extensionDevelopmentPath=${path.join(root, 'integration-test', 'mock-lsp')}`,
      fixture, path.join(fixture, 'EntityRepository.java'),
    ],
    recordVideo: { dir: videoDir, size: { width: W, height: H } },
  });
  const t0 = Date.now();
  const w = await app.firstWindow();
  await w.setViewportSize({ width: W, height: H });
  await sleep(6000);
  for (let i = 0; i < 3; i++) {
    await w.keyboard.press('Escape');
    await sleep(300);
  }

  // Overlay: visible mouse pointer, click ripple, key badge and captions
  await w.evaluate(() => {
    const css = document.createElement('style');
    css.textContent = `
      .notifications-toasts, .notification-toast-container { display: none !important; }
      #demo-cursor { position: fixed; left: 0; top: 0; width: 22px; height: 22px; z-index: 100000; pointer-events: none;
        transform: translate(-3px, -2px); filter: drop-shadow(0 1px 2px rgba(0,0,0,.6)); }
      #demo-ripple { position: fixed; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%;
        border: 3px solid #FF8A3D; z-index: 99999; pointer-events: none; opacity: 0; }
      #demo-ripple.on { animation: demo-r .5s ease-out; }
      @keyframes demo-r { from { opacity: 1; transform: scale(.3); } to { opacity: 0; transform: scale(1.4); } }
      #demo-key { position: fixed; z-index: 100001; pointer-events: none; padding: 2px 8px; border-radius: 6px;
        background: #FF8A3D; color: #fff; font: 600 13px/20px -apple-system, Segoe UI, sans-serif; display: none; }
      #demo-caption { position: fixed; left: 50%; bottom: 46px; transform: translateX(-50%); z-index: 100002;
        pointer-events: none; padding: 10px 22px; border-radius: 10px; background: rgba(20,21,23,.92);
        border: 1px solid #FF8A3D; color: #fff; font: 600 19px/26px -apple-system, Segoe UI, sans-serif;
        box-shadow: 0 6px 24px rgba(0,0,0,.5); transition: opacity .25s; opacity: 0; white-space: nowrap; }`;
    document.head.appendChild(css);
    const cur = document.createElement('div');
    cur.id = 'demo-cursor';
    // VS Code enforces Trusted Types → build the pointer SVG with DOM calls instead of innerHTML
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 22 22');
    svg.setAttribute('width', '22');
    svg.setAttribute('height', '22');
    const arrow = document.createElementNS(NS, 'path');
    arrow.setAttribute('d', 'M3 2 L3 18 L7.5 14 L10.5 20.5 L13 19.4 L10.1 13 L16 13 Z');
    arrow.setAttribute('fill', '#fff');
    arrow.setAttribute('stroke', '#000');
    arrow.setAttribute('stroke-width', '1.3');
    arrow.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(arrow);
    cur.appendChild(svg);
    const rip = document.createElement('div');
    rip.id = 'demo-ripple';
    const key = document.createElement('div');
    key.id = 'demo-key';
    key.textContent = '⌘ / Ctrl';
    const cap = document.createElement('div');
    cap.id = 'demo-caption';
    document.body.append(cur, rip, key, cap);
    let x = 0;
    let y = 0;
    document.addEventListener('mousemove', e => {
      x = e.clientX;
      y = e.clientY;
      cur.style.left = x + 'px';
      cur.style.top = y + 'px';
      key.style.left = x + 18 + 'px';
      key.style.top = y + 18 + 'px';
    }, true);
    document.addEventListener('mousedown', e => {
      rip.style.left = e.clientX + 'px';
      rip.style.top = e.clientY + 'px';
      rip.classList.remove('on');
      void rip.offsetWidth;
      rip.classList.add('on');
    }, true);
    window.__demoKey = on => (key.style.display = on ? 'block' : 'none');
    window.__demoCaption = text => {
      cap.style.opacity = text ? '1' : '0';
      if (text) cap.textContent = text;
    };
  });

  const caption = t => w.evaluate(t2 => window.__demoCaption(t2), t);
  const key = on => w.evaluate(o => window.__demoKey(o), on);

  /** Bounding box of the inlay hint (or word) `label` on the editor line containing `lineText`. */
  async function box(lineText, label) {
    const r = await w.evaluate(([lt, lb]) => {
      const norm = s => s.replace(/\u00a0/g, ' ').trim(); // VS Code renders spaces as &nbsp;
      const lines = [...document.querySelectorAll('.editor-instance .view-line')].filter(l => norm(l.textContent).includes(lt));
      for (const line of lines) {
        const els = [...line.querySelectorAll('span')].filter(s => norm(s.textContent) === lb && ![...s.children].some(c => norm(c.textContent) === lb));
        if (els.length) {
          const b = els[els.length - 1].getBoundingClientRect();
          return { x: b.x, y: b.y, width: b.width, height: b.height };
        }
      }
      return null;
    }, [lineText, label]);
    if (!r) throw new Error(`not found: ${label} on line with ${lineText}`);
    return { x: r.x + Math.min(r.width / 2, 40), y: r.y + r.height / 2 };
  }
  let mx = W / 2;
  let my = H / 2;
  async function moveTo(p, steps = 28) {
    await w.mouse.move(p.x, p.y, { steps });
    mx = p.x;
    my = p.y;
  }
  async function cmdClick(p) {
    await moveTo(p);
    await sleep(350);
    await key(true);
    await w.keyboard.down('Control');
    await sleep(450);
    await w.mouse.click(p.x, p.y);
    await w.keyboard.up('Control');
    await sleep(250);
    await key(false);
  }
    // Make sure hints are there
  for (let i = 0; i < 40; i++) {
    const n = await w.evaluate(() => [...document.querySelectorAll('.view-line span')].filter(s => s.textContent.replace(/\u00a0/g, ' ').trim() === '1 implementation').length);
    if (n) break;
    await sleep(250);
  }
  await w.mouse.move(mx, my);
  await sleep(500);
  const demoStart = Date.now();

  // 1) Overview
  await caption('IntelliJ-style hints for implementations, overrides & super methods');
  await sleep(2600);

  // 2) Interface method → implementation
  await caption('⌘/Ctrl + Click a hint to jump to the implementation');
  await cmdClick(await box('contains(Object object);', '1 implementation'));
  await sleep(1800);

  // 3) Implementation → interface
  await caption('… and back up to the interface');
  await cmdClick(await box('contains(Object object)', '↑ EntityRepository'));
  await sleep(1800);

  // 4) Several targets → picker
  await caption('Several targets? Pick one, like IntelliJ\'s “Choose Implementation”');
  await cmdClick(await box('void lock(Object object);', '2 implementations'));
  await sleep(1300);
  await w.keyboard.press('ArrowDown');
  await sleep(700);
  await w.keyboard.press('Enter');
  await sleep(1800);

  // 5) Overrides chain in the subclass → jump to the top-most interface
  await caption('Works across the whole hierarchy');
  await cmdClick(await box('void flush()', '↑ EntityRepositoryDao +2'));
  await sleep(1400);
  await w.keyboard.press('ArrowDown');
  await sleep(450);
  await w.keyboard.press('ArrowDown');
  await sleep(700);
  await w.keyboard.press('Enter');
  await sleep(1500);

  // 6) Hover
  await caption('Or hover a member name');
  await moveTo(await box('public void flush();', 'flush'));
  await sleep(2800);
  await caption('');
  await sleep(600);
  const demoEnd = Date.now();

  const video = w.video();
  await app.close();
  const src = await video.path();
  const out = path.join(root, 'docs', 'demo.gif');
  // The recording's clock drifts a little against Date.now(); start a bit earlier so the
  // first caption is never cut off (the lead-in is just the static editor with hints).
  const LEAD = 3;
  const ss = Math.max(0, (demoStart - t0) / 1000 - LEAD).toFixed(2);
  const dur = ((demoEnd - demoStart) / 1000 + LEAD).toFixed(2);
  // crop the window title bar (shows "[Extension Development Host]")
  const filters = `crop=iw:ih-30:0:30,fps=12,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle`;
  execFileSync('ffmpeg', ['-y', '-ss', ss, '-t', dur, '-i', src, '-vf', filters, '-loop', '0', out], { stdio: 'inherit' });
  // Optional MP4 (e.g. for social media): DEMO_MP4=path/to/demo.mp4
  if (process.env.DEMO_MP4) {
    execFileSync('ffmpeg', ['-y', '-ss', ss, '-t', dur, '-i', src,
      '-vf', 'crop=iw:ih-30:0:30,scale=1280:-2:flags=lanczos,fps=30',
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an',
      process.env.DEMO_MP4], { stdio: 'inherit' });
    console.log(`wrote ${process.env.DEMO_MP4}`);
  }
  console.log(`\nwrote ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB)`);
})().catch(e => {
  console.error(e);
  process.exit(1);
});

/*
 * End-to-end test: loads the unpacked extension into Chromium, imports answer
 * keys through the real popup page, then plays mock Blooket, Kahoot and
 * hand-made quiz pages and checks every answer the extension clicked.
 *
 *   npm run test:e2e            (set HEADED=1 to watch it; needs a display or xvfb-run)
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, 'fixtures');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (err) {
    const globalRoot = require('node:child_process').execSync('npm root -g').toString().trim();
    return require(path.join(globalRoot, 'playwright'));
  }
}

function fixture(name) {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

async function step(name, fn) {
  const started = Date.now();
  await fn();
  console.log(`  ✓ ${name} (${Date.now() - started} ms)`);
}

async function main() {
  const { chromium } = loadPlaywright();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'quiz-autopilot-e2e-'));
  const extensionDir = path.join(tmp, 'extension');
  fs.cpSync(path.join(ROOT, 'extension'), extensionDir, { recursive: true });
  // Stand-in for clicking "Enable on this site" (a browser permission prompt can't be automated).
  const manifestPath = path.join(extensionDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.host_permissions.push('https://my-quiz.example/*');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  const context = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: !process.env.HEADED,
    args: [`--disable-extensions-except=${extensionDir}`, `--load-extension=${extensionDir}`],
  });
  const problems = [];
  context.on('page', (page) => {
    page.on('pageerror', (err) => problems.push(`${page.url()}: ${err.message}`));
    page.on('console', (msg) => {
      if (/Quiz Autopilot/.test(msg.text()) || msg.type() === 'error') problems.push(`${page.url()}: ${msg.text()}`);
    });
  });

  try {
    const worker = context.serviceWorkers()[0] || (await context.waitForEvent('serviceworker'));
    const extensionId = new URL(worker.url()).host;
    const readSettings = () => worker.evaluate(async () => (await chrome.storage.local.get('settings')).settings || {});
    const waitForSetting = async (key, value) => {
      for (let i = 0; i < 50; i++) {
        if ((await readSettings())[key] === value) return;
        await new Promise((r) => setTimeout(r, 100));
      }
      throw new Error(`setting ${key} never became ${value}`);
    };

    const serve = (file) => (route) => route.fulfill({ contentType: 'text/html', body: fixture(file) });
    await context.route('https://play.blooket.com/**', serve('blooket.html'));
    await context.route('https://kahoot.it/**', serve('kahoot.html'));
    await context.route('https://my-quiz.example/**', serve('custom.html'));

    async function play(url) {
      const page = await context.newPage();
      await page.goto(url);
      await page.waitForFunction(() => window.__done === true, null, { timeout: 30000 });
      const log = await page.evaluate(() => window.__log);
      return { page, log };
    }

    const manager = await context.newPage();
    await step('import answer keys in the extension page', async () => {
      await manager.goto(`chrome-extension://${extensionId}/src/ui/manager.html`);
      const keys = [
        ['Blooket review', 'blooket-key.csv', 6],
        ['Kahoot review', 'kahoot-key.tsv', 4],
        ['My game', 'custom-key.txt', 3],
      ];
      for (const [name, file, count] of keys) {
        await manager.fill('#setName', name);
        await manager.fill('#importText', fixture(file));
        await manager.waitForFunction((n) => document.getElementById('preview').textContent.includes(`${n} question`), count);
        await manager.click('#importBtn');
        await manager.waitForFunction((n) => document.getElementById('importMsg').textContent.includes(n), name);
      }
      assert.equal(await manager.locator('#sets li').count(), 3);
      assert.match(await manager.textContent('#totals'), /13 questions active/);
      await manager.fill('#delayMs', '100');
      await manager.press('#delayMs', 'Tab');
      await waitForSetting('delayMs', 100);
    });

    await step('Blooket: answers every question, including a typo and a -5/5 trap', async () => {
      const { page, log } = await play('https://play.blooket.com/play/gold');
      assert.equal(log.length, 5, JSON.stringify(log));
      for (const entry of log) assert.equal(entry.picked, entry.correct, entry.question);
      const detail = await page.evaluate(() => document.getElementById('quiz-autopilot-host').shadowRoot.querySelector('.detail').textContent);
      assert.match(detail, /Last answer: William Shakespeare/);
      await page.close();
    });

    await step('Kahoot: single answer, multi-select, shapes-only and true/false', async () => {
      const { page, log } = await play('https://kahoot.it/gameblock');
      assert.equal(log.length, 4, JSON.stringify(log));
      for (const entry of log) assert.deepEqual(entry.picked, entry.correct, `question ${entry.question}`);
      await page.close();
    });

    await step('own quiz page: finds the question and the right button by their text', async () => {
      const { page, log } = await play('https://my-quiz.example/');
      assert.equal(log.length, 3, JSON.stringify(log));
      for (const entry of log) assert.equal(entry.picked, entry.correct, entry.question);
      await page.close();
    });

    await step('highlight-only mode outlines the answer without clicking', async () => {
      await manager.uncheck('#autoClick');
      await waitForSetting('autoClick', false);
      const page = await context.newPage();
      await page.goto('https://my-quiz.example/');
      await page.waitForFunction(() => {
        const host = document.getElementById('quiz-autopilot-host');
        const box = host && host.shadowRoot.querySelector('.box');
        return box && box.style.display === 'block';
      });
      await page.waitForTimeout(1000);
      assert.equal(await page.evaluate(() => window.__log.length), 0);
      const surrounds = await page.evaluate(() => {
        const box = document.getElementById('quiz-autopilot-host').shadowRoot.querySelector('.box').getBoundingClientRect();
        const answer = [...document.querySelectorAll('.choice')].find((b) => b.textContent.endsWith(') ' + window.__current.c));
        const r = answer.getBoundingClientRect();
        return box.left <= r.left && box.right >= r.right && box.top <= r.top && box.bottom >= r.bottom;
      });
      assert.ok(surrounds, 'the outline should surround the correct button');

      // Turning auto-click back on answers the question that is already showing.
      await manager.check('#autoClick');
      await page.waitForFunction(() => window.__log.length === 1);
      assert.equal(await page.evaluate(() => window.__log[0].picked === window.__log[0].correct), true);

      // Alt+Shift+A pauses from the game page.
      await page.keyboard.press('Alt+Shift+A');
      await waitForSetting('enabled', false);
      await page.waitForFunction(
        () => document.getElementById('quiz-autopilot-host').shadowRoot.querySelector('.chip').textContent === 'PAUSED'
      );
      await page.waitForTimeout(800);
      assert.equal(await page.evaluate(() => window.__log.length), 1, 'nothing is clicked while paused');
      await page.close();
    });

    assert.deepEqual(problems, [], 'no page errors or extension warnings');
    console.log('All end-to-end checks passed.');
  } finally {
    await context.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});

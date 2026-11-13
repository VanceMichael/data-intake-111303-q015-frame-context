import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';

async function availablePort() {
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  return port;
}

for (const configuration of ['cli', 'environment']) {
  test(`门户服务通过 ${configuration} 指定端口后可从首页完成加载`, { timeout: 15000 }, async () => {
    const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url)));
    assert.equal(packageJson.scripts.start, 'node src/source.mjs');
    const port = await availablePort();
    const argumentsList = configuration === 'cli' ? ['--host', '127.0.0.1', '--port', String(port)] : [];
    const child = spawn(process.execPath, ['src/source.mjs', ...argumentsList], {
      cwd: new URL('..', import.meta.url),
      env: { ...process.env, HOST: '127.0.0.1', PORT: configuration === 'cli' ? '1' : String(port), SOURCE_CASE: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let browser;
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      const ready = await new Promise((resolve, reject) => {
        let output = '';
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`来源服务提前退出 ${code}: ${stderr}`)));
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('\n')) {
            try { resolve(JSON.parse(output.split('\n')[0])); } catch (error) { reject(error); }
          }
        });
      });
      const origin = `http://127.0.0.1:${port}`;
      assert.equal(ready.source, origin);
      const response = await fetch(origin + '/portal/state');
      assert.equal(response.status, 200);
      assert.match(response.headers.get('content-type'), /application\/json/);
      const state = await response.json();
      assert.equal(state.version, 2);
      browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
      const page = await browser.newPage();
      const errors = [];
      const failures = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('response', reply => {
        if (new URL(reply.url()).origin === origin && reply.status() >= 400 && !reply.url().endsWith('/favicon.ico')) failures.push(reply.url());
      });
      const homepage = await page.goto(origin + '/', { waitUntil: 'networkidle' });
      assert.equal(homepage.status(), 200);
      await page.waitForSelector('#feedback');
      assert.ok(await page.title());
      assert.ok(await page.locator('button, input, select').count() > 0);
      assert.deepEqual(errors, []);
      assert.deepEqual(failures, []);
    } finally {
      if (browser) await browser.close();
      if (child.exitCode === null && child.signalCode === null) {
        const stopped = once(child, 'exit');
        child.kill('SIGTERM');
        await stopped;
      }
    }
  });
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startSource } from '../src/source.mjs';

const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
test('浏览器门户可操作并暴露真实业务状态', { timeout: 10000 }, async () => {
  const source = await startSource(cases[0]);
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(source.url + '/portal');
    await page.waitForSelector('#feedback');
    assert.ok(await page.title());
    const number = cases[0].productNumber;
    if (number === 11) {
      await page.fill('#request-id', 'source-smoke');
      await page.click('[data-target="boat"][data-action="hold"]');
      await page.waitForFunction(() => document.querySelector('#boat').dataset.state === 'held');
      assert.equal(source.portal.state.boat.state, 'held');
    }
    if (number === 12) assert.equal(await page.inputValue('#note'), '现场新备注');
    if (number === 13) {
      await page.click('#generate');
      await page.waitForSelector('#preview[data-revision="2"]');
      await page.emulateMedia({ media: 'print' });
      assert.equal(await page.locator('.print-page').count(), 2);
      assert.equal(await page.locator('[data-line="l2"]').count(), 2);
    }
    if (number === 14) {
      await page.fill('#quantity', '-1'); await page.locator('#quantity').blur();
      assert.equal(await page.textContent('#validation'), '数量必须为正整数');
    }
    if (number === 15) {
      await page.selectOption('#point', 'p2'); await page.click('#select');
      await page.frameLocator('iframe').locator('main[data-point="p2"]').waitFor();
      assert.notEqual(new URL(page.frames()[1].url()).hostname, new URL(page.url()).hostname);
    }
    if (number === 20) {
      await page.setInputFiles('#upload', { name: 'rows.jsonl', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify({ id: 's1', site: '湖站', kind: 'water' })) });
      await page.waitForFunction(() => document.querySelector('#feedback').textContent.includes('s1'));
      await page.click('#preview');
      await page.waitForSelector('tr[data-row-id="s1"]');
    }
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await source.close(); }
});

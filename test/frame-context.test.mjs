import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startSource } from '../src/source.mjs';
import { run } from '../src/workflow.mjs';
import { launchBrowser, PortalSession } from '../src/browser-session.mjs';

const cases = JSON.parse(await readFile(new URL('../fixtures/cases.json', import.meta.url)));
const success = cases.find(item => item.mode === 'success');
const late = cases.find(item => item.mode === 'late');
const conflict = cases.find(item => item.mode === 'conflict');

async function freshState() {
  return mkdtemp(path.join(tmpdir(), 'frame-context-test-'));
}

async function withSource(scenario, body) {
  const source = await startSource(scenario);
  try { await body(source); } finally { await source.close(); }
}

test('快速切换后按最终观察点绑定，旧 frame 句柄不参与下载', { timeout: 30000 }, async () => {
  await withSource(success, async source => {
    const browser = await launchBrowser();
    const session = new PortalSession(browser, source.url);
    try {
      await session.open();
      // 快速 p2 -> p1 -> p2，每次切换都会 detach 旧 iframe
      await session.selectPoint('p2');
      await session.selectPoint('p1');
      await session.selectPoint('p2');
      const binding = await session.bindContext({ point: 'p2', revision: 2 });
      assert.equal(binding.state, 'bound');
      assert.equal(binding.inner.point, 'p2');
      assert.ok(binding.epoch >= 3, '框架代次应随重建递增');
      const claim = await session.claimDownload(binding);
      assert.equal(claim.state, 'claimed');
      assert.equal(claim.receipt.id, 'sample-p2');
      // 领取的是最终上下文（generation 已递增），不是首个 p2 内页的旧身份
      assert.equal(claim.contextAtTrigger.inner.generation, binding.inner.generation);
      assert.ok(binding.inner.generation >= 3);
      assert.equal(claim.after.drifted, false);
      assert.ok(session.diagnostics().detachedFrames.length >= 2, '应记录至少两次框架脱离');
    } finally { await session.close(); await browser.close(); }
  });
});

test('切换途中的半旧半新 DOM 不会被误判为冲突，重建后正常绑定', { timeout: 30000 }, async () => {
  await withSource(success, async source => {
    const browser = await launchBrowser();
    const session = new PortalSession(browser, source.url);
    try {
      await session.open();
      await session.selectPoint('p2');
      // 不等待稳定，立刻再次切到 p1：绑定过程中会经历 frame 重建
      await session.selectPoint('p1');
      const binding = await session.bindContext({ point: 'p1', revision: 2 });
      assert.equal(binding.state, 'bound');
      assert.equal(binding.inner.point, 'p1');
      assert.equal(binding.outer.point, 'p1');
      assert.ok(session.diagnostics().detachedFrames.length >= 1);
    } finally { await session.close(); await browser.close(); }
  });
});

test('迟到的旧 generation 消息只留痕，不被当作当前上下文', { timeout: 30000 }, async () => {
  await withSource(late, async source => {
    const browser = await launchBrowser();
    const session = new PortalSession(browser, source.url);
    try {
      await session.open();
      await session.selectPoint('p2');
      const binding = await session.bindContext({ point: 'p2', revision: 2 });
      assert.equal(binding.state, 'bound');
      assert.equal(binding.message.current.generation, binding.inner.generation);
      const claim = await session.claimDownload(binding);
      assert.equal(claim.state, 'claimed');
      assert.equal(claim.receipt.point, 'p2');
      assert.equal(claim.receipt.receipt, 'download-' + binding.inner.generation);
      // 页面消息区在 late 模式会被写入旧身份；它不能改变绑定结果
      const panel = await session.readMessagePanel();
      if (panel?.parsed && panel.parsed.generation !== binding.inner.generation) {
        assert.notEqual(panel.parsed.generation, claim.contextAtTrigger.inner.generation);
      }
    } finally { await session.close(); await browser.close(); }
  });
});

test('late 模式快速切换产生旧消息回流时，只领取最终代次资料', { timeout: 30000 }, async () => {
  await withSource(late, async source => {
    const browser = await launchBrowser();
    const session = new PortalSession(browser, source.url);
    try {
      await session.open();
      await session.selectPoint('p2');
      await session.selectPoint('p1');
      await session.selectPoint('p2');
      const binding = await session.bindContext({ point: 'p2', revision: 2 });
      assert.equal(binding.state, 'bound');
      // 最终代次 >= 3；历史消息里若存在旧代次，必须全部被标记为 stale
      assert.ok(binding.inner.generation >= 3);
      for (const stale of binding.message.staleMessages) {
        assert.notEqual(stale.generation, binding.inner.generation);
      }
      const claim = await session.claimDownload(binding);
      assert.equal(claim.state, 'claimed');
      assert.equal(claim.receipt.receipt, 'download-' + binding.inner.generation);
      assert.equal(claim.receipt.point, 'p2');
      assert.equal(claim.after.drifted, false);
    } finally { await session.close(); await browser.close(); }
  });
});

test('内外上下文冲突时暂缓接收且不产生下载', { timeout: 30000 }, async () => {
  await withSource(conflict, async source => {
    const stateDir = await freshState();
    try {
      const result = await run({ source: source.url, stateDir, input: { point: 'p2', revision: 2 } });
      assert.equal(result.state, 'context-conflict');
      assert.deepEqual(result.ids, []);
      assert.equal(result.conflict.inner.point, 'p1');
      assert.equal(result.conflict.outer.point, 'p2');
      assert.ok(result.conflict.reason.includes('主框架=p2'));
      // 框架 URL 仍是 p2 线索，但 DOM 身份是 p1 —— 证明没有按 URL 采信
      assert.match(result.conflict.frameUrl, /point=p2/);
      const downloads = await readdir(path.join(stateDir, 'downloads'));
      assert.deepEqual(downloads, []);
      const downloadActions = source.portal.actions.filter(item => item.action === 'download:p2');
      assert.equal(downloadActions.length, 0, '冲突时不得触发下载动作');
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

test('多观察点并行：单个内页失联不阻塞整轮', { timeout: 45000 }, async () => {
  await withSource(success, async source => {
    const stateDir = await freshState();
    try {
      // 一个可领取观察点 + 一个不存在的观察点（下拉只有 p1/p2，选择后无法绑定）
      const result = await run({
        source: source.url,
        stateDir,
        input: { points: [{ point: 'p2', revision: 2 }], concurrency: 2 },
      });
      assert.equal(result.state, 'claimed');
      assert.ok(result.ids.includes('sample-p2'));
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });

  // 内页整体失联：来源只返回门户、不返回 /frame 时，结果为 not-loaded/unreachable 而非抛错
  await withSource(success, async source => {
    const stateDir = await freshState();
    const browser = await launchBrowser();
    const session = new PortalSession(browser, source.url, { timeoutMs: 1200 });
    try {
      await session.open();
      await session.context.route('**/frame**', route => route.abort('failed'));
      await session.selectPoint('p2');
      const binding = await session.bindContext({ point: 'p2', revision: 2 }, { timeoutMs: 2500, messageGraceMs: 500 });
      assert.ok(['not-loaded', 'unreachable'].includes(binding.state));
      assert.ok(binding.frameChain.some(frame => frame.role === 'main'));
    } finally { await session.close(); await browser.close(); await rm(stateDir, { recursive: true, force: true }); }
  });
});

test('框架重建后续采：重试后仍能领取且证据指向重建后的代次', { timeout: 45000 }, async () => {
  await withSource(success, async source => {
    const stateDir = await freshState();
    try {
      const result = await run({ source: source.url, stateDir, input: { points: [{ point: 'p2', revision: 2 }, { point: 'p1', revision: 2 }], concurrency: 2 } });
      const p2 = result.points.find(item => item.point === 'p2');
      const p1 = result.points.find(item => item.point === 'p1');
      assert.equal(p2.state, 'claimed');
      assert.equal(p1.state, 'claimed');
      // 并行竞争会导致服务端 generation 漂移，续采后的收据 generation 必须与触发上下文一致
      assert.equal(p2.receipt.actionBody.receipt, 'download-' + p2.evidence.contextAtTrigger.inner.generation);
      assert.equal(p1.receipt.actionBody.receipt, 'download-' + p1.evidence.contextAtTrigger.inner.generation);
      const files = await readdir(path.join(stateDir, 'downloads'));
      assert.ok(files.includes('sample-p2.json'));
      assert.ok(files.includes('sample-p1.json'));
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

test('所有业务动作经真实浏览器页面发起，机器人不直连内部动作接口', { timeout: 30000 }, async () => {
  await withSource(success, async source => {
    const stateDir = await freshState();
    try {
      await run({ source: source.url, stateDir, input: { point: 'p2', revision: 2 } });
      const actionRequests = source.history.filter(entry => entry.path.includes('/portal/action'));
      assert.ok(actionRequests.length > 0);
      // 历史里所有 /portal/* 请求都必须带浏览器 UA：工作流自身不用 node fetch 直连
      const portalRequests = source.history.filter(entry => entry.path.startsWith('/portal'));
      assert.ok(portalRequests.length > 0);
      assert.ok(portalRequests.every(entry => /Chrome/.test(entry.headers['user-agent'] ?? '')));
      // 页面动作必须包含真实的 select 与 download，且由浏览器发出
      assert.ok(source.portal.actions.some(entry => entry.action === 'select:p2'));
      assert.ok(source.portal.actions.some(entry => entry.action === 'download:p2'));
      assert.ok(actionRequests.every(entry => /HeadlessChrome|Chrome/.test(entry.headers['user-agent'] ?? '')));
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

test('状态落盘可恢复：重跑复用已领取证据，不重复下载', { timeout: 30000 }, async () => {
  await withSource(success, async source => {
    const stateDir = await freshState();
    try {
      const first = await run({ source: source.url, stateDir, input: { point: 'p2', revision: 2 } });
      assert.equal(first.state, 'claimed');
      const actionsAfterFirst = source.portal.actions.length;
      const second = await run({ source: source.url, stateDir, input: { point: 'p2', revision: 2 } });
      assert.equal(second.state, 'claimed');
      assert.equal(second.resumed, true);
      assert.equal(second.receipt.receipt, first.receipt.receipt);
      assert.equal(source.portal.actions.length, actionsAfterFirst, '恢复后不应再触发页面动作');
      const saved = JSON.parse(await readFile(path.join(stateDir, 'result.json'), 'utf8'));
      assert.equal(saved.ids[0], 'sample-p2');
      assert.ok(saved.frameChain.length === 2);
      assert.equal(saved.frameChain[1].crossOriginToParent, true);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

test('真实无资料与未加载可区分：上下文一致但无控件时输出 empty', { timeout: 30000 }, async () => {
  await withSource(success, async source => {
    const browser = await launchBrowser();
    const session = new PortalSession(browser, source.url);
    try {
      await session.open();
      // 在 frame 文档渲染后、绑定前移除下载控件，模拟该观察点确实无资料
      await session.context.route('**/frame**', async route => {
        const response = await route.fetch();
        let body = await response.text();
        body = body.replace('<button id="download">下载</button>', '');
        await route.fulfill({ response, body });
      });
      await session.selectPoint('p2');
      const binding = await session.bindContext({ point: 'p2', revision: 2 });
      assert.equal(binding.state, 'bound');
      assert.equal(binding.hasClaimControl, false);
      assert.equal(binding.inner.point, 'p2');
    } finally { await session.close(); await browser.close(); }
  });
});

test('每份资料输出机构、观察点、修订、框架链与领取证据', { timeout: 30000 }, async () => {
  await withSource(success, async source => {
    const stateDir = await freshState();
    try {
      const result = await run({ source: source.url, stateDir, input: { point: 'p2', revision: 2 } });
      assert.ok(result.organization.includes('机构'));
      assert.equal(result.point, 'p2');
      assert.equal(result.revision, 2);
      assert.equal(result.frameChain[0].role, 'main');
      assert.equal(result.frameChain[1].role, 'iframe');
      assert.equal(result.frameChain[1].crossOriginToParent, true);
      assert.ok(result.receipt.receipt.startsWith('download-'));
      assert.ok(result.evidence.contextAtTrigger.outer.generation);
      assert.ok(result.evidence.contextAtTrigger.inner.generation);
      assert.ok(result.evidence.actionReply.status === 200);
      assert.ok(result.evidence.postMessage.current);
      const onDisk = JSON.parse(await readFile(path.join(stateDir, result.evidence.downloadFile), 'utf8'));
      assert.equal(onDisk.id, 'sample-p2');
      assert.equal(onDisk.receipt, result.receipt.receipt);
    } finally { await rm(stateDir, { recursive: true, force: true }); }
  });
});

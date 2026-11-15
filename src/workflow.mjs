import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { launchBrowser, PortalSession } from './browser-session.mjs';

/**
 * 业务入口：跨框架上下文绑定的资料采集。
 *
 * 设计决定（并行 / 框架重建 / 迟到消息）：
 * - 多观察点：input 可为单个 {point, revision} 或 {points:[...]}；
 *   每个观察点使用独立 BrowserContext（独立 cookie/frame 树），有界并发，
 *   单个内页失联只记 not-loaded/unreachable，不阻塞整轮。
 * - 框架重建：不缓存 frame 句柄，每次按当前 frame 树重新解析；
 *   监听 framedetached 递增 frameEpoch，重建后重新走两层 DOM 绑定。
 * - 迟到消息：postMessage 按 generation 过滤，旧 generation 只留痕不采信；
 *   下载以触发瞬间的上下文快照 + 实际 200 回执 + blob 内容三者一致为准，
 *   绝不用后来的页面标题/状态补到旧文件上。
 * - 恢复：每个观察点的关键步骤即时落盘 journal，重跑时复用已落盘且
 *   收据可追溯的 claimed 结果，不依赖调用方内存。
 */

const STATE_VERSION = 1;
const MAX_ATTEMPTS = 3;

export async function run({ source, stateDir, input }) {
  if (!source) throw new Error('缺少 source 资料源地址');
  if (!stateDir) throw new Error('缺少 stateDir 状态目录');
  if (!input || typeof input !== 'object') throw new Error('缺少业务输入');
  const jobs = normalizeInput(input);
  const concurrency = Math.max(1, input.concurrency ?? 2);
  await mkdir(path.join(stateDir, 'downloads'), { recursive: true });

  const checkpoint = await loadCheckpoint(stateDir);
  const browser = await launchBrowser();
  const results = [];
  try {
    let cursor = 0;
    const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (cursor < jobs.length) {
        const job = jobs[cursor++];
        const result = await runOne(browser, source, stateDir, job, checkpoint);
        results.push(result);
      }
    });
    await Promise.all(workers);
  } finally {
    await browser.close().catch(() => {});
  }
  const ordered = jobs.map(job => results.find(item => item.point === job.point && item.revision === job.revision)).filter(Boolean);
  const result = jobs.length === 1 ? ordered[0] : { state: aggregate(ordered), points: ordered };
  await writeFile(path.join(stateDir, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
  return result;
}

function normalizeInput(input) {
  const list = input.points ?? [input];
  const jobs = list.map(item => {
    if (!item?.point) throw new Error('业务输入缺少 point');
    return { point: String(item.point), revision: Number(item.revision) };
  });
  const keys = new Set();
  for (const job of jobs) {
    const key = `${job.point}@${job.revision}`;
    if (keys.has(key)) throw new Error('观察点输入重复：' + key);
    keys.add(key);
  }
  return jobs;
}

function aggregate(items) {
  if (items.every(item => item.state === 'claimed')) return 'claimed';
  if (items.some(item => item.state === 'claimed')) return 'partial';
  if (items.every(item => item.state === 'context-conflict')) return 'context-conflict';
  if (items.every(item => item.state === 'empty')) return 'empty';
  if (items.every(item => item.state === 'not-loaded' || item.state === 'unreachable')) return 'not-loaded';
  return 'partial';
}

async function runOne(browser, source, stateDir, job, checkpoint) {
  const journalPath = path.join(stateDir, `journal-${job.point}-${job.revision}.json`);
  const prior = checkpoint[journalKey(job)];
  if (prior?.state === 'claimed' && prior.receipt?.receipt && prior.evidence?.downloadFile) {
    const fileOk = await readFile(path.join(stateDir, prior.evidence.downloadFile)).then(buffer => buffer.length > 0).catch(() => false);
    if (fileOk) return { ...prior, resumed: true };
  }

  const journal = { version: STATE_VERSION, job, attempts: [], startedAt: new Date().toISOString() };
  const persist = async patch => { Object.assign(journal, patch); await writeFile(journalPath, JSON.stringify(journal, null, 2), 'utf8'); };

  let lastFailure = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const session = new PortalSession(browser, source);
    const attemptRecord = { attempt, startedAt: new Date().toISOString(), events: [] };
    try {
      const opened = await session.open();
      attemptRecord.events.push({ event: 'portal-opened', ...opened });
      await session.selectPoint(job.point);
      attemptRecord.events.push({ event: 'point-selected', point: job.point, epoch: session.frameEpoch });

      const binding = await session.bindContext(job);
      attemptRecord.binding = { state: binding.state, outer: binding.outer, inner: binding.inner, reason: binding.reason };
      if (binding.state === 'not-loaded') {
        lastFailure = classifyNotLoaded(binding, session);
        attemptRecord.outcome = lastFailure.state;
        journal.attempts.push(attemptRecord);
        await persist({ attempts: journal.attempts });
        continue; // 重建/慢加载：重试整轮
      }
      if (binding.state === 'context-conflict') {
        // 冲突是来源当前真实状态，重试不会改变，按契约暂缓接收（不重试、不下载）
        const conflict = buildConflict(job, binding, session, attemptRecord);
        journal.attempts.push(attemptRecord);
        await persist({ attempts: journal.attempts, finishedAt: new Date().toISOString() });
        return conflict;
      }

      if (binding.hasClaimControl === false) {
        // 上下文两层一致且消息已佐证，但内页无领取控件：真实无资料
        const empty = {
          state: 'empty',
          ids: [],
          point: job.point,
          revision: job.revision,
          organization: binding.organization,
          frameChain: binding.frameChain,
          evidence: {
            contextAtBind: { outer: binding.outer, inner: binding.inner },
            postMessage: binding.message,
            messagePanel: binding.messagePanel ?? null,
            reason: '内页已加载且上下文一致，但不存在下载控件',
            detachedFrames: session.diagnostics().detachedFrames,
          },
        };
        journal.attempts.push(attemptRecord);
        await persist({ attempts: journal.attempts, finishedAt: new Date().toISOString(), result: empty });
        return empty;
      }

      const claim = await session.claimDownload(binding);
      attemptRecord.claim = { state: claim.state, reason: claim.reason, receipt: claim.receipt ?? null };
      if (claim.state !== 'claimed') {
        lastFailure = { state: 'claim-failed', ids: [], point: job.point, revision: job.revision,
          reason: claim.reason, actionReply: claim.actionReply, frameChain: claim.frameChain, diagnostics: session.diagnostics() };
        journal.attempts.push(attemptRecord);
        await persist({ attempts: journal.attempts });
        continue;
      }

      const fileName = `${claim.receipt.id}.json`;
      const downloadFile = path.join('downloads', fileName);
      await writeFile(path.join(stateDir, downloadFile), claim.content);
      const result = {
        state: 'claimed',
        ids: [claim.receipt.id],
        point: job.point,
        revision: job.revision,
        organization: binding.organization,
        receipt: claim.receipt,
        frameChain: claim.frameChain,
        evidence: {
          downloadFile,
          contextAtTrigger: claim.contextAtTrigger,
          contextAfterTrigger: claim.after,
          postMessage: claim.message,
          messagePanel: binding.messagePanel ?? null,
          actionReply: claim.actionReply ?? null,
          detachedFrames: session.diagnostics().detachedFrames,
          pageErrors: session.diagnostics().pageErrors,
        },
        attempts: attempt,
      };
      journal.attempts.push(attemptRecord);
      await persist({ attempts: journal.attempts, finishedAt: new Date().toISOString(), result });
      checkpoint[journalKey(job)] = result;
      await saveCheckpoint(stateDir, checkpoint);
      return result;
    } catch (error) {
      attemptRecord.error = safeMessage(error);
      lastFailure = { state: 'unreachable', ids: [], point: job.point, revision: job.revision, reason: safeMessage(error) };
    } finally {
      await session.close().catch(() => {});
      if (!journal.attempts.includes(attemptRecord)) journal.attempts.push(attemptRecord);
      await persist({ attempts: journal.attempts });
    }
  }
  await persist({ finishedAt: new Date().toISOString() });
  return { ...lastFailure, ids: [], point: job.point, revision: job.revision, attempts: MAX_ATTEMPTS, frameChain: lastFailure?.frameChain ?? null };
}

function classifyNotLoaded(binding, session) {
  const diagnostics = session.diagnostics();
  const hasFrame = binding.frameChain.some(frame => frame.role === 'iframe');
  return {
    state: hasFrame ? 'not-loaded' : 'unreachable',
    ids: [],
    reason: binding.reason,
    outer: binding.outer ?? null,
    inner: binding.inner ?? null,
    frameChain: binding.frameChain,
    diagnostics,
  };
}

function buildConflict(job, binding, session, attemptRecord) {
  return {
    state: 'context-conflict',
    ids: [],
    point: job.point,
    revision: job.revision,
    organization: binding.organization ?? null,
    conflict: {
      reason: binding.reason,
      outer: binding.outer,
      inner: binding.inner,
      frameUrl: binding.frameUrl,
      postMessage: binding.message,
      messagePanel: binding.messagePanel ?? null,
    },
    frameChain: binding.frameChain,
    evidence: {
      detachedFrames: session.diagnostics().detachedFrames,
      actionReplies: session.diagnostics().actionResponses,
      pageErrors: session.diagnostics().pageErrors,
      bindingAttempt: attemptRecord,
    },
  };
}

function journalKey(job) {
  return `${job.point}@${job.revision}`;
}

async function loadCheckpoint(stateDir) {
  try {
    const raw = await readFile(path.join(stateDir, 'checkpoint.json'), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed.version === STATE_VERSION && parsed.jobs ? parsed.jobs : {};
  } catch { return {}; }
}

async function saveCheckpoint(stateDir, jobs) {
  await writeFile(path.join(stateDir, 'checkpoint.json'), JSON.stringify({ version: STATE_VERSION, jobs }, null, 2), 'utf8');
}

function safeMessage(error) {
  return error && typeof error.message === 'string' ? error.message.slice(0, 500) : String(error).slice(0, 500);
}

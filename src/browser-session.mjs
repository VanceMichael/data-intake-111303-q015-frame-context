import { chromium } from 'playwright';
import { createHash } from 'node:crypto';

/**
 * 真实浏览器会话：所有门户动作都由页面控件触发，
 * 机器人不直接调用 /portal/state、/portal/action（它们只服务页面本身）。
 *
 * 上下文绑定原则：
 * - frame 的 URL 只用于定位，真正的机构/观察点/修订以两层 DOM 渲染结果为准；
 * - 每次操作都按当前 frame 树重新解析 iframe，绝不缓存 frame 句柄；
 * - 内页 postMessage 带自己的 generation，只有与主框架当前 generation 一致才有效；
 * - frame 脱离（framedetached）后旧句柄立即作废，等待新 frame 附加后续采。
 */

const DEFAULT_LAUNCH_OPTIONS = { headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] };

export async function launchBrowser(options = {}) {
  return chromium.launch({ ...DEFAULT_LAUNCH_OPTIONS, ...options.launch });
}

function shortHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex').slice(0, 16);
}

function safeText(value) {
  if (value === null || value === undefined) return null;
  return String(value).trim().slice(0, 500);
}

export class PortalSession {
  constructor(browser, sourceUrl, options = {}) {
    this.browser = browser;
    this.sourceUrl = sourceUrl.replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? 10000;
    this.settleMs = options.settleMs ?? 250;
    this.context = null;
    this.page = null;
    // frame 代次：每次观察到 framedetached / 重新选择观察点都会递增
    this.frameEpoch = 0;
    this.detachedFrames = [];
    this.messages = [];
    this.actionResponses = [];
    this.pageErrors = [];
    this.consoleErrors = [];
  }

  async open() {
    this.context = await this.browser.newContext({ acceptDownloads: true });
    this.page = await this.context.newPage();
    this.page.on('pageerror', error => this.pageErrors.push({ at: new Date().toISOString(), message: safeText(error.message) }));
    this.page.on('console', message => {
      if (message.type() === 'error') this.consoleErrors.push({ at: new Date().toISOString(), message: safeText(message.text()) });
    });
    // 内页脱离后，旧 frame 句柄不可再用；只记录代次，不持有句柄
    this.page.on('framedetached', frame => {
      this.frameEpoch += 1;
      this.detachedFrames.push({ at: new Date().toISOString(), url: safeText(frame.url()), epoch: this.frameEpoch });
    });
    // 迟到消息留痕，绑定判断时按 generation 过滤，不直接采信。
    // 必须在首次导航前安装：addInitScript 会注入到每个文档（含跨来源 iframe），
    // 内页脚本加载时即完成监听，不会错过它 35ms 后发出的 postMessage。
    await this.context.exposeBinding('__frameContextSpy', (eventInfo, payload) => {
      this.messages.push({ at: new Date().toISOString(), epoch: this.frameEpoch, ...payload });
    });
    await this.context.addInitScript(() => {
      const install = () => window.addEventListener('message', event => {
        if (event.source === window) return;
        window.__frameContextSpy({ point: event.data?.point ?? null, revision: event.data?.revision ?? null, generation: event.data?.generation ?? null, origin: event.origin });
      });
      install();
    });
    // 只观察动作回执，不代替页面发请求
    this.page.on('response', async response => {
      const url = response.url();
      if (!url.includes('/portal/action')) return;
      const record = { at: new Date().toISOString(), status: response.status(), body: null, settled: false };
      this.actionResponses.push(record);
      try { record.body = await response.text(); } catch { record.body = null; }
      record.settled = true;
    });
    const navigation = await this.page.goto(this.sourceUrl + '/portal', { waitUntil: 'domcontentloaded', timeout: this.timeoutMs });
    await this.page.waitForSelector('#feedback', { timeout: this.timeoutMs });
    return { status: navigation?.status() ?? null, title: await this.page.title() };
  }

  /** 主框架当前渲染的上下文（#outer 的 dataset），这是主页面自己给出的身份。 */
  async readOuterContext() {
    return this.page.$eval('#outer', element => ({
      point: element.dataset.point ?? null,
      revision: element.dataset.revision ? Number(element.dataset.revision) : null,
      generation: element.dataset.generation ? Number(element.dataset.generation) : null,
    }));
  }

  /**
   * 主页面消息区文本。late 模式下页面会把切换前的旧身份直接写进这里
   * （不经 postMessage），同样只留痕，绝不作为当前上下文采信。
   */
  async readMessagePanel() {
    const text = await this.page.$eval('#message', element => element.textContent).catch(() => '');
    if (!text) return null;
    try { return { raw: text, parsed: JSON.parse(text) }; } catch { return { raw: text, parsed: null }; }
  }

  /** 当前 frame 树快照（不缓存句柄，每次实时读取）。 */
  frameChainSnapshot() {
    const main = this.page.mainFrame();
    const chain = [{
      role: 'main',
      url: main.url(),
      origin: new URL(main.url()).origin,
      crossOriginToParent: false,
    }];
    for (const frame of this.page.frames()) {
      if (frame === main) continue;
      const parent = frame.parentFrame();
      let crossOrigin = true;
      try { crossOrigin = new URL(frame.url()).origin !== new URL(parent?.url() ?? main.url()).origin; } catch { crossOrigin = true; }
      chain.push({
        role: 'iframe',
        url: frame.url(),
        origin: safeOrigin(frame.url()),
        parentOrigin: safeOrigin(parent?.url() ?? main.url()),
        crossOriginToParent: crossOrigin,
      });
    }
    return chain;
  }

  /**
   * 通过页面下拉框与“打开详情”按钮切换观察点（真实控件操作）。
   * 选择后旧 iframe 被 replaceChildren 移除，等待新 frame 附加。
   */
  async selectPoint(point) {
    this.frameEpoch += 1;
    const selectEpoch = this.frameEpoch;
    await this.page.selectOption('#point', String(point));
    await this.page.click('#select');
    // 等待新内页出现并完成主框架 dataset 更新；不使用任何旧 frame 句柄
    await this.page.waitForFunction(target => {
      const outer = document.querySelector('#outer');
      return outer?.dataset.point === target && Boolean(outer.querySelector('iframe'));
    }, String(point), { timeout: this.timeoutMs });
    return selectEpoch;
  }

  /**
   * 逐层确认上下文。返回三态：
   * - bound：两层 point/revision/generation 全部一致，内页 DOM 已渲染，
   *   并在宽限期内收到同 generation 的 postMessage 佐证；
   * - context-conflict：内页已加载但身份与主框架（或目标）不一致；
   * - not-loaded：超时内内页未附加/未渲染出身份，或消息迟迟不到、无法佐证。
   * frame URL 仅作定位线索，判定一律以两层渲染 DOM + 消息 generation 为准。
   */
  async bindContext(target, options = {}) {
    const deadline = Date.now() + (options.timeoutMs ?? this.timeoutMs);
    const messageGraceMs = options.messageGraceMs ?? 1500;
    let lastEvidence = null;
    while (Date.now() < deadline) {
      const outer = await this.readOuterContext().catch(error => ({ error: safeText(error.message) }));
      const innerFrame = this.page.frames().find(frame => frame !== this.page.mainFrame());
      if (innerFrame) {
        const inner = await innerFrame.$eval('main', element => ({
          point: element.dataset.point ?? null,
          revision: element.dataset.revision ? Number(element.dataset.revision) : null,
          generation: element.dataset.generation ? Number(element.dataset.generation) : null,
        })).catch(error => ({ error: safeText(error.message) }));
        const organization = await innerFrame.$eval('h2', element => element.textContent.trim()).catch(() => null);
        const frameUrl = innerFrame.url();
        lastEvidence = { outer, inner, organization, frameUrl };
        if (!inner.error && inner.point) {
          const outerMatches = outer.point === inner.point && outer.revision === inner.revision && outer.generation === inner.generation;
          const targetMatches = inner.point === target.point && inner.revision === target.revision;
          if (!outerMatches || !targetMatches) {
            // 切换途中可能读到半旧半新的两层 DOM；给一个短稳定窗口，
            // 连续两次读取身份不变才判定为真实冲突，否则视为重建中继续轮询。
            const stable = await this.#waitStableIdentity(innerFrame, outer, inner, 300);
            if (!stable) { lastEvidence = { outer, inner, organization, frameUrl, transient: true }; await sleep(50); continue; }
            const message = this.#currentMessage(inner.generation);
            const messagePanel = await this.readMessagePanel();
            return { state: 'context-conflict', outer, inner, organization, message, messagePanel, frameUrl, frameChain: this.frameChainSnapshot(), epoch: this.frameEpoch,
              reason: this.#conflictReason(target, outer, inner) };
          }
          // 两层 DOM 已一致：等待内页自己的 postMessage 佐证（消息有延迟，且可能迟到）
          const message = await this.#awaitCurrentMessage(inner.generation, messageGraceMs);
          const messagePanel = await this.readMessagePanel();
          if (message.current) {
            // 上下文真实一致，但内页没有可领取控件 = 真实无资料，区别于未加载
            const hasClaimControl = await innerFrame.locator('#download').count().then(value => value > 0).catch(() => false);
            return { state: 'bound', outer, inner, organization, message, messagePanel, hasClaimControl, frameUrl, frameChain: this.frameChainSnapshot(), epoch: this.frameEpoch };
          }
          lastEvidence.messageMissing = '内页 DOM 已一致，但未在宽限期内收到同 generation 消息';
        }
      } else {
        lastEvidence = { outer, inner: null };
      }
      await sleep(100);
    }
    return { state: 'not-loaded', ...lastEvidence, frameChain: this.frameChainSnapshot(), epoch: this.frameEpoch,
      reason: lastEvidence?.messageMissing ?? '超时内内页未附加或未渲染出两层一致的上下文' };
  }

  /** 等待内页身份在窗口内保持不变；期间框架重建或身份变化则返回 false（重建中，不判冲突）。 */
  async #waitStableIdentity(innerFrame, outer, inner, windowMs) {
    const epochAtStart = this.frameEpoch;
    const deadline = Date.now() + windowMs;
    while (Date.now() < deadline) {
      if (this.frameEpoch !== epochAtStart) return false;
      const live = this.page.frames().find(frame => frame !== this.page.mainFrame());
      if (!live || live !== innerFrame) return false;
      const nowInner = await live.$eval('main', element => ({
        point: element.dataset.point ?? null,
        revision: element.dataset.revision ? Number(element.dataset.revision) : null,
        generation: element.dataset.generation ? Number(element.dataset.generation) : null,
      })).catch(() => null);
      if (!nowInner || nowInner.point !== inner.point || nowInner.revision !== inner.revision || nowInner.generation !== inner.generation) return false;
      await sleep(50);
    }
    return true;
  }

  #conflictReason(target, outer, inner) {
    const differences = [];
    for (const key of ['point', 'revision', 'generation']) {
      if (outer?.[key] !== inner?.[key]) differences.push(`${key}: 主框架=${outer?.[key]} 内页=${inner?.[key]}`);
    }
    if (inner.point !== target.point || inner.revision !== target.revision) {
      differences.push(`目标=(${target.point}/${target.revision}) 内页=(${inner.point}/${inner.revision})`);
    }
    return differences.join('；') || '上下文不一致';
  }

  /** 只取与当前内页 generation 相符的消息；旧 generation 的消息视为迟到，仅留痕。 */
  #currentMessage(generation) {
    const matching = this.messages.filter(item => item.generation === generation);
    const stale = this.messages.filter(item => item.generation !== generation);
    return {
      current: matching.at(-1) ?? null,
      staleMessages: stale.map(({ point, revision, generation: g, origin, at, epoch }) => ({ point, revision, generation: g, origin, at, epoch })),
    };
  }

  /** 等待内页同 generation 的 postMessage；期间若 frame 重建（epoch 变化）立即放弃等待。 */
  async #awaitCurrentMessage(generation, graceMs) {
    const epochAtStart = this.frameEpoch;
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (this.frameEpoch !== epochAtStart) {
        return { ...this.#currentMessage(generation), interrupted: '等待消息期间框架已重建' };
      }
      const snapshot = this.#currentMessage(generation);
      if (snapshot.current) return snapshot;
      await sleep(20);
    }
    return this.#currentMessage(generation);
  }

  async #waitActionReply(startIndex, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const newReplies = this.actionResponses.slice(startIndex);
      const settled = newReplies.filter(item => item.settled);
      if (settled.length > 0) return settled.at(-1);
      await sleep(25);
    }
    return this.actionResponses.slice(startIndex).at(-1) ?? null;
  }

  /**
   * 在已绑定的内页上触发真实“下载”按钮，并把下载物与触发瞬间的上下文、
   * 实际 HTTP 回执、blob 内容三者绑定。下载后再次读取两层 DOM 确认身份未漂移。
   */
  async claimDownload(binding) {
    const beforeOuter = await this.readOuterContext();
    const frameBefore = this.frameChainSnapshot();
    const repliesAtStart = this.actionResponses.length;
    const innerLocator = this.page.frameLocator('iframe').first();
    let download;
    let clickError = null;
    try {
      [download] = await Promise.all([
        this.page.waitForEvent('download', { timeout: this.timeoutMs }),
        innerLocator.locator('#download').click({ timeout: this.timeoutMs }),
      ]);
    } catch (error) {
      clickError = safeText(error.message);
    }
    await sleep(this.settleMs);
    // 触发后的动作回执（页面自己 fetch 的结果，机器人只观察）；
    // 等待响应体真正落库，避免读到尚未 settle 的占位记录。
    // 内页一次点击只产生一条 download 动作，取触发后最后一条 settled 记录。
    const actionReply = await this.#waitActionReply(repliesAtStart, this.timeoutMs);
    // 触发后再次读取两层上下文，确认期间没有被快速切换改写
    const afterOuter = await this.readOuterContext().catch(error => ({ error: safeText(error.message) }));
    const innerFrameAfter = this.page.frames().find(frame => frame !== this.page.mainFrame());
    const afterInner = innerFrameAfter
      ? await innerFrameAfter.$eval('main', element => ({
          point: element.dataset.point ?? null,
          revision: element.dataset.revision ? Number(element.dataset.revision) : null,
          generation: element.dataset.generation ? Number(element.dataset.generation) : null,
        })).catch(error => ({ error: safeText(error.message) }))
      : null;

    if (clickError || !download) {
      return { state: 'claim-failed', reason: clickError ?? '未观察到浏览器下载事件', actionReply,
        contextAtTrigger: { outer: beforeOuter, inner: binding.inner }, frameChain: frameBefore, after: { outer: afterOuter, inner: afterInner } };
    }

    const suggestedName = download.suggestedFilename();
    const downloadStream = await download.createReadStream();
    const chunks = [];
    for await (const chunk of downloadStream) chunks.push(chunk);
    const content = Buffer.concat(chunks);
    let parsed = null;
    try { parsed = JSON.parse(content.toString('utf8')); } catch { parsed = null; }

    // 服务端 409 / 缺正式回执，都不能算领取成功
    if (actionReply?.status !== 200 || !parsed?.receipt || parsed.point !== binding.inner.point || parsed.revision !== binding.inner.revision) {
      return { state: 'claim-failed', reason: '回执与触发上下文不一致或被服务端拒绝', actionReply,
        suggestedName, contentHash: shortHash(content),
        contextAtTrigger: { outer: beforeOuter, inner: binding.inner }, frameChain: frameBefore, after: { outer: afterOuter, inner: afterInner } };
    }
    const drifted = afterInner && (afterInner.point !== binding.inner.point || afterInner.revision !== binding.inner.revision || afterInner.generation !== binding.inner.generation);
    return {
      state: 'claimed',
      receipt: {
        id: parsed.id,
        point: parsed.point,
        revision: parsed.revision,
        receipt: parsed.receipt,
        actionStatus: actionReply.status,
        actionBody: safeJson(actionReply.body),
        suggestedFilename: suggestedName,
        contentSha256_16: shortHash(content),
        sizeBytes: content.length,
      },
      contextAtTrigger: { outer: beforeOuter, inner: binding.inner },
      frameChain: frameBefore,
      after: { outer: afterOuter, inner: afterInner, drifted: Boolean(drifted) },
      message: binding.message,
      actionReply,
      content,
    };
  }

  /** 内页失联诊断：区分未附加、跨来源错误、页面脚本错误。 */
  diagnostics() {
    return {
      frameEpoch: this.frameEpoch,
      detachedFrames: this.detachedFrames,
      messages: this.messages,
      actionResponses: this.actionResponses.map(({ at, status, body }) => ({ at, status, body: safeJson(body) })),
      pageErrors: this.pageErrors,
      consoleErrors: this.consoleErrors,
      frameChain: this.frameChainSnapshot(),
    };
  }

  async close() {
    await this.context?.close().catch(() => {});
  }
}

function safeOrigin(url) {
  try { return new URL(url).origin; } catch { return null; }
}

function safeJson(body) {
  if (body === null || body === undefined) return null;
  try { return JSON.parse(body); } catch { return safeText(body); }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

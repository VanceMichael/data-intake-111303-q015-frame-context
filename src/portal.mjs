import { readFile } from 'node:fs/promises';

export function createPortal(scenario, history) {
  const actions = [];
  const number = scenario.productNumber;
  const mode = scenario.mode;
  const state = {
    mode, number, version: 2, requestId: null,
    boat: { state: 'available', used: false }, equipment: { state: 'available', used: false },
    record: { note: '现场新备注', method: 'manual', container: 'glass' },
    duplicateBookings: 0, duplicateRecords: 0, accepted: {}, rows: [], preview: null,
    point: 'p1', revision: 1, generation: 1,
  };
  let commitCount = 0;
  const writeJson = (response, value, status = 200) => {
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    response.end(JSON.stringify(value));
  };
  return {
    actions, state,
    async handle(request, response, raw, origin) {
      const address = new URL(request.url, origin);
      if (address.pathname === '/' || address.pathname === '/portal') {
        const html = await readFile(new URL('../web/index.html', import.meta.url));
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        response.end(html); return true;
      }
      if (address.pathname === '/app.mjs') {
        response.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
        response.end(await readFile(new URL('../web/app.mjs', import.meta.url))); return true;
      }
      if (address.pathname === '/frame') {
        const point = mode === 'conflict' ? 'p1' : address.searchParams.get('point');
        const revision = mode === 'conflict' ? 1 : Number(address.searchParams.get('revision'));
        const generation = Number(address.searchParams.get('generation'));
        const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><h2>机构甲资料详情</h2><main data-point="${point}" data-revision="${revision}" data-generation="${generation}"><p id="context">观察点 ${point} / 修订 ${revision}</p><button id="download">下载</button><p id="receipt"></p></main><script>
          const notify = () => parent.postMessage({ point: ${JSON.stringify(point)}, revision: ${revision}, generation: ${generation} }, ${JSON.stringify(origin)});
          setTimeout(notify, 35);
          document.querySelector('#download').onclick = async () => {
            const reply = await fetch('/portal/action', {method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'download',point:${JSON.stringify(point)},revision:${revision},generation:${generation}})});
            const value = await reply.json(); document.querySelector('#receipt').textContent = JSON.stringify(value);
            const link = document.createElement('a');link.href=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'}));link.download='sample-'+${JSON.stringify(point)}+'.json';link.click();
          };
        </script></html>`;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(html); return true;
      }
      if (address.pathname === '/portal/state') { writeJson(response, state); return true; }
      if (address.pathname !== '/portal/action') return false;
      if (request.method !== 'POST') { writeJson(response, { error: '只接受页面动作' }, 405); return true; }
      let input;
      try { input = JSON.parse(raw); } catch { writeJson(response, { error: '无效 JSON' }, 400); return true; }
      const action = input.action;
      actions.push({ action: input.target ? action + ':' + input.target : action === 'select' || action === 'download' ? action + ':' + input.point : action, input, userAgent: request.headers['user-agent'] });
      if (number === 11) {
        if (action === 'lookup') { writeJson(response, state); return true; }
        const target = state[input.target];
        if (!['boat', 'equipment'].includes(input.target)) { writeJson(response, { error: '无此预约对象' }, 400); return true; }
        if (action === 'hold') {
          if (input.target === 'equipment' && ['reject', 'consumed'].includes(mode)) {
            if (mode === 'consumed') { state.boat.state = 'confirmed'; state.boat.used = true; }
            writeJson(response, { error: '设备无可用位置', state }, 409); return true;
          }
          if (target.state !== 'available') state.duplicateBookings += 1;
          state.requestId = input.requestId; target.state = 'held'; target.expiresAt = Date.now() + 4000; target.receipt = input.target + '-' + input.requestId;
        }
        if (action === 'confirm') {
          if (target.state !== 'held' || target.expiresAt < Date.now()) { writeJson(response, { error: '保留失效', state }, 409); return true; }
          target.state = 'confirmed';
        }
        if (action === 'release') {
          if (target.used) { writeJson(response, { error: '人工已经使用', state }, 409); return true; }
          target.state = 'available';
        }
      }
      if (number === 12 && action === 'save') {
        if (input.version !== state.version) { writeJson(response, { error: '版本冲突', state }, 409); return true; }
        state.record = { ...state.record, ...input.record };
        if (state.record.method === 'automatic') state.record.container = '';
        state.version += 1;
      }
      if (number === 13 && action === 'generate') {
        writeJson(response, { registration: 'reg-1', revision: 2, failed: mode === 'failed', staleFirst: mode === 'stale' }); return true;
      }
      if (number === 14 && action === 'save') {
        if (input.composing || input.calculatedGeneration !== input.inputGeneration) { writeJson(response, { error: '输入尚未提交' }, 409); return true; }
        if (!/^\d+$/.test(input.record.quantity) || Number(input.record.quantity) <= 0) { writeJson(response, { error: '数量必须为正整数' }, 422); return true; }
        state.record = input.record;
      }
      if (number === 15) {
        if (action === 'select') { state.point = input.point; state.revision = 2; state.generation += 1; }
        if (action === 'download') {
          if (input.point !== state.point || input.revision !== state.revision || input.generation !== state.generation) { writeJson(response, { error: '上下文冲突' }, 409); return true; }
          writeJson(response, { id: 'sample-' + state.point, point: state.point, revision: state.revision, receipt: 'download-' + state.generation }); return true;
        }
      }
      if (number === 20) {
        if (action === 'upload') { state.rows = input.rows; state.preview = null; }
        if (action === 'preview') {
          state.preview = { id: 'preview-' + actions.length, rows: [...state.rows].reverse().map((row, index) => ({ position: index + 1, id: row.id, errors: row.kind === 'water' ? [] : ['unknown-kind'], dependsOn: row.site ? [] : ['site'] })) };
        }
        if (action === 'commit') {
          if (!state.preview) { writeJson(response, { error: '尚未预检' }, 409); return true; }
          commitCount += 1;
          let ready = state.rows.filter(row => row.kind === 'water' && row.site);
          if (mode === 'partial' && commitCount === 1) ready = ready.slice(0, 1);
          for (const row of ready) {
            if (state.accepted[row.id]) state.duplicateRecords += 1;
            else state.accepted[row.id] = { archiveId: 'archive-' + row.id, row };
          }
          state.receipt = 'receipt-' + commitCount;
          if (mode === 'partial' && commitCount === 1) { writeJson(response, { error: '提交后连接丢失，请查询正式回执', receipt: state.receipt }, 503); return true; }
        }
        if (action === 'receipt') { writeJson(response, { receipt: state.receipt ?? null, accepted: state.accepted, duplicateRecords: state.duplicateRecords }); return true; }
      }
      writeJson(response, state); return true;
    },
  };
}

const app = document.querySelector('#app');
let state = await fetch('/portal/state').then(response => response.json());
const action = async value => {
  const response = await fetch('/portal/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(value) });
  const result = await response.json();
  document.querySelector('#feedback').textContent = JSON.stringify(result, null, 2);
  return { ok: response.ok, value: result };
};
const feedback = '<pre id="feedback" aria-live="polite"></pre>';
app.innerHTML='<label>观察点<select id="point"><option value="p1">p1</option><option value="p2">p2</option></select></label><button id="select">打开详情</button><main id="outer" data-point="p1" data-revision="1"></main><pre id="message"></pre>'+feedback;
document.querySelector('#select').onclick=async()=>{
 const previous={point:state.point,revision:state.revision,generation:state.generation};
 const reply=await action({action:'select',point:document.querySelector('#point').value});state=reply.value;
 const outer=document.querySelector('#outer');outer.dataset.point=state.point;outer.dataset.revision=String(state.revision);outer.dataset.generation=String(state.generation);
 const address=new URL('/frame',location.href);address.hostname='localhost';address.search=new URLSearchParams({point:state.point,revision:state.revision,generation:state.generation});
 outer.replaceChildren();const frame=document.createElement('iframe');frame.title='观察点资料详情';frame.src=address.href;outer.append(frame);
 if(state.mode==='late')setTimeout(()=>{document.querySelector('#message').textContent=JSON.stringify(previous);},10);
};
window.addEventListener('message',event=>{document.querySelector('#message').textContent=JSON.stringify({...event.data,origin:event.origin});});

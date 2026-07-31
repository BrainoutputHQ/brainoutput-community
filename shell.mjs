// SPDX-License-Identifier: Apache-2.0
// BrainOutput Community Edition — the chat-native shell (2026-07-30, Directive 6 D6-2;
// look & feel pass 2026-07-31: modern chat UI — big readable type, kimi-style composer,
// user bubbles, clean assistant stream; onboarding answered IN the composer).
// THE product face: one familiar chat screen. Everything is a message — missions, approvals,
// artifacts and reports are cards inside the thread; projects group conversations in the
// sidebar; ad-hoc threads promote to projects in one click. Onboarding IS the first
// conversation. Zero-dep inline page; the multi-tab dashboard stays at /dashboard as the
// advanced surface. All UI strings come from the embedded locale catalog (i18n.mjs).
export const SHELL_PAGE = `<!doctype html><html lang="__BO_LOCALE__"><head><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>BrainOutput</title>
<style>
:root{--bg:#0e1014;--card:#171a21;--card2:#1c202a;--fg:#e8eaf0;--mut:#8f96a8;--acc:#5b9dff;--ok:#3ddc84;--warn:#ffb454;--line:#242935;--ub:#1e3a5f}
*{box-sizing:border-box}body{margin:0;font:15.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--fg);display:flex;height:100vh;overflow:hidden;-webkit-font-smoothing:antialiased}
aside{width:280px;min-width:280px;border-right:1px solid var(--line);background:#11131a;display:flex;flex-direction:column}
aside .brand{padding:18px 18px 14px;border-bottom:1px solid var(--line);font-weight:700;font-size:17px;letter-spacing:-.01em}
aside .brand .tag{display:block;font-weight:400;font-size:12px;color:var(--mut);margin-top:2px}
aside .scroll{flex:1;overflow:auto;padding:12px}
aside .foot{padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:10px;align-items:center;font-size:13px}
aside select{background:#0f1319;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:5px 8px;font-size:13px}
.shead{color:var(--mut);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:14px 6px 8px;display:flex;align-items:center}
.shead button{margin-left:auto;background:none;border:1px solid var(--line);color:var(--mut);border-radius:8px;font-size:12px;padding:3px 10px;cursor:pointer}
.shead button:hover{color:var(--fg);border-color:var(--acc)}
.pitem{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:10px;padding:9px 12px;color:var(--fg);cursor:pointer;font-size:14px;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pitem:hover{background:var(--card)}.pitem.on{background:var(--card);border-color:var(--line)}
.pitem .cnt{float:right;color:var(--mut);font-size:12px}
main{flex:1;display:flex;flex-direction:column;min-width:0}
#thead{border-bottom:1px solid var(--line);padding:12px 22px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:#10121a}
#thead .title{font-weight:650;font-size:15px}
#thead select{background:#0f1319;border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 9px;font-size:13px}
#thread{flex:1;overflow:auto;padding:26px 22px 12px}
.wrap{max-width:780px;margin:0 auto}
.msg{margin-bottom:22px}
.msg .who{font-size:12px;color:var(--mut);margin-bottom:5px;font-weight:600}
.msg.user{text-align:right}
.msg.user .who{text-align:right}
.msg.user .body{display:inline-block;text-align:left;background:var(--ub);border:1px solid #2a4a73;border-radius:18px 18px 4px 18px;padding:11px 16px;max-width:85%;white-space:pre-wrap}
.msg.bot .body{white-space:pre-wrap;padding:2px 0}
.msg .meta{font-size:11.5px;color:var(--mut);margin-top:5px}
.msg.user .meta{padding-right:4px}
.cardx{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:4px 0 20px}
.cardx h3{margin:0 0 10px;font-size:14px;color:var(--acc);font-weight:650}
.cardx.warn{border-color:#6b4d1f}.cardx.warn h3{color:var(--warn)}
.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}
button.act{background:var(--acc);color:#06121f;border:none;border-radius:10px;padding:9px 16px;font-weight:650;cursor:pointer;font-size:14px}
button.ghost{background:none;border:1px solid var(--line);color:var(--mut);border-radius:10px;padding:9px 15px;cursor:pointer;font-size:14px}
button.ghost:hover{color:var(--fg);border-color:var(--acc)}
input,textarea,select.inp{background:#0f1319;border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:10px 12px;width:100%;font:inherit;margin-top:4px}
label{display:block;margin:10px 0 3px;color:var(--mut);font-size:13px}
#composer{border-top:1px solid var(--line);padding:14px 22px 18px;background:#0e1014}
#cbox{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:10px 12px 8px;transition:border-color .15s, box-shadow .15s}
#cbox:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px rgba(91,157,255,.12)}
#msg{width:100%;background:none;border:none;outline:none;color:var(--fg);font:inherit;resize:none;max-height:200px;padding:4px 6px;line-height:1.55}
#cbar{display:flex;align-items:center;margin-top:4px}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.seg button{background:none;border:none;color:var(--mut);padding:6px 13px;cursor:pointer;font-size:12.5px}
.seg button.on{background:var(--card2);color:var(--fg)}
#send{margin-left:auto;width:38px;height:38px;border-radius:50%;background:var(--acc);color:#06121f;border:none;font-size:17px;font-weight:700;cursor:pointer;display:grid;place-items:center}
#send:disabled{background:var(--card2);color:var(--mut);cursor:default}
#busy{font-size:12.5px;color:var(--mut);margin:6px 4px 0;min-height:16px}
.deptpick{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.deptpick label{background:#0f1319;border:1px solid var(--line);border-radius:18px;padding:7px 14px;color:var(--fg);font-size:13.5px;cursor:pointer;margin:0}
.deptpick input{width:auto;margin-right:6px}
details summary{cursor:pointer}
@media(max-width:760px){aside{display:none}}
</style></head><body>
<aside>
 <div class=brand>🏢 BrainOutput<span class=tag id=tagline></span></div>
 <div class=scroll>
  <div class=shead><span id=lprojects></span><button id=newproj>+ <span id=lnewproj></span></button></div>
  <div id=projects></div>
  <div class=shead><span id=ladhoc></span></div>
  <div id=adhoc></div>
 </div>
 <div class=foot>
  <select id=locale><option value="en">EN</option><option value="fr">FR</option><option value="de">DE</option></select>
  <a href="/dashboard" style="color:var(--mut);font-size:13px;text-decoration:none" id=ldash></a>
 </div>
</aside>
<main>
 <div id=thead></div>
 <div id=thread><div class=wrap id=msgs></div></div>
 <div id=composer><div class=wrap>
  <div id=cbox>
   <textarea id=msg rows=2></textarea>
   <div id=cbar>
    <div class=seg id=modes></div>
    <button id=send title="">↑</button>
   </div>
  </div>
  <div id=busy></div>
 </div></div>
</main>
<script>
const T=__BO_I18N__;
const LOCALE='__BO_LOCALE__';
const CSRF='__BO_CSRF__';
const t=(k)=>T[k]||k;
const S={state:null,convId:null,projectId:null,mode:'ask',scope:'company',dept:'',agent:'',ob:null};
const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h;return d.firstElementChild};
async function api(p,body){const r=await fetch(p,body?{method:'POST',headers:{'Content-Type':'application/json','X-BO-CSRF':CSRF},body:JSON.stringify(body)}:{headers:{'X-BO-CSRF':CSRF}});return r.json()}
async function refresh(){S.state=await api('/api/state');render()}
const onboarded=(s)=>!!(s&&(s.agents||[]).length);
// Onboarding answers are chat messages; keep them across a reload until the team exists.
try{S.ob=JSON.parse(localStorage.getItem('bo_ob')||'null')}catch{}
const saveOb=()=>{try{S.ob?localStorage.setItem('bo_ob',JSON.stringify(S.ob)):localStorage.removeItem('bo_ob')}catch{}};

// ── sidebar ──────────────────────────────────────────────────────────────────
function sidebar(){
 const s=S.state||{};
 document.getElementById('tagline').textContent=t('app.tagline');
 document.getElementById('lprojects').textContent=t('shell.projects');
 document.getElementById('lnewproj').textContent=t('shell.newProject');
 document.getElementById('ladhoc').textContent=t('shell.adHoc');
 document.getElementById('ldash').textContent=t('shell.dashboard');
 document.getElementById('locale').value=LOCALE;
 const convs=s.conversations||[];
 const proj=document.getElementById('projects');proj.innerHTML='';
 (s.projects||[]).forEach(p=>{
  const n=convs.filter(c=>c.projectId===p.id).length;
  const b=el('<button class="pitem'+(S.projectId===p.id?' on':'')+'">'+esc(p.name)+'<span class=cnt>'+(n||'')+'</span></button>');
  b.onclick=()=>{S.projectId=p.id;S.convId=null;render()};
  proj.appendChild(b)});
 if(!(s.projects||[]).length)proj.appendChild(el('<div class=mut style="font-size:13px;padding:4px 6px">'+esc(t('shell.emptyProjects'))+'</div>'));
 const ad=document.getElementById('adhoc');ad.innerHTML='';
 convs.filter(c=>!c.projectId).slice().reverse().forEach(c=>{
  const label=c.title||(c.messages[0]?String(c.messages[0].text).slice(0,34):c.id);
  const b=el('<button class="pitem'+(S.convId===c.id&&!S.projectId?' on':'')+'">'+esc(label)+'</button>');
  b.onclick=()=>{S.projectId=null;S.convId=c.id;render()};
  ad.appendChild(b)});
 document.getElementById('newproj').onclick=async()=>{
  const name=prompt(t('shell.projectName'));if(!name||!name.trim())return;
  const r=await api('/api/project',{name:name.trim()});if(r.error){alert(r.error);return}
  S.projectId=(r.project||{}).id||S.projectId;S.convId=null;await refresh()};
 document.getElementById('locale').onchange=async(e)=>{await api('/api/settings',{locale:e.target.value});location.reload()};
}

// ── thread header: scope controls + promote ─────────────────────────────────
function thead(){
 const s=S.state||{};const h=document.getElementById('thead');h.innerHTML='';
 if(!onboarded(s)){h.appendChild(el('<span class=title>🏢 BrainOutput</span>'));return}
 const conv=(s.conversations||[]).find(c=>c.id===S.convId);
 const proj=conv&&conv.projectId?(s.projects||[]).find(p=>p.id===conv.projectId):null;
 h.appendChild(el('<span class=title>'+esc(proj?proj.name:(conv?(conv.title||(conv.messages[0]?String(conv.messages[0].text).slice(0,40):'')):'🏢 BrainOutput'))+'</span>'));
 const sc=el('<select><option value="company">'+esc(t('scope.company'))+'</option><option value="work-twin">'+esc(t('scope.work-twin'))+'</option><option value="department">'+esc(t('scope.department'))+'</option><option value="agent">'+esc(t('scope.agent'))+'</option></select>');
 sc.value=S.scope;sc.onchange=()=>{S.scope=sc.value;render()};h.appendChild(sc);
 if(S.scope==='department'){const dp=el('<select><option value="">—</option>'+(s.departments||[]).map(d=>'<option '+(S.dept===d?'selected':'')+'>'+esc(d)+'</option>').join('')+'</select>');
  dp.onchange=()=>{S.dept=dp.value};h.appendChild(dp)}
 if(S.scope==='agent'){const ag=el('<select><option value="">—</option>'+(s.agents||[]).map(a=>'<option value="'+esc(a.id)+'" '+(S.agent===a.id?'selected':'')+'>'+esc(a.id)+'</option>').join('')+'</select>');
  ag.onchange=()=>{S.agent=ag.value};h.appendChild(ag)}
 if(conv){const pr=el('<select style="margin-left:auto"><option value="">'+esc(t('shell.promote'))+'</option>'+(s.projects||[]).map(p=>'<option value="'+p.id+'">'+esc(p.name)+'</option>').join('')+'<option value="__new">+ '+esc(t('shell.newProject'))+'</option></select>');
  pr.onchange=async()=>{if(!pr.value)return;
   const body={conversationId:conv.id};
   if(pr.value==='__new'){const name=prompt(t('shell.projectName'));if(!name)return;body.newProjectName=name.trim()}
   else body.projectId=pr.value;
   const r=await api('/api/conversation/promote',body);if(r.error){alert(r.error);return}
   S.projectId=(r.project||{}).id||null;await refresh()};
  h.appendChild(pr)}
}

// ── cards ────────────────────────────────────────────────────────────────────
function missionCard(m){
 const g=(m.graph&&m.graph.shape)||'';
 const d=el('<div class="cardx"><h3>'+esc(t('mission.objective'))+' · <span class=mut>'+esc(m.status)+'</span></h3>'
  +'<label>'+esc(t('mission.objective'))+'</label><input class=inp id=mo value="'+esc(m.objective||'')+'">'
  +'<label>'+esc(t('mission.department'))+'</label><input class=inp id=mdp value="'+esc(m.department||'')+'">'
  +'<div class=mut style="font-size:13px;margin-top:8px">'+esc(t('mission.graph'))+': '+esc(g)+' · '+esc((m.graph&&m.graph.nodes||[]).join(' → '))+' · '+esc(t('mission.approvalGates'))+': '+esc(Object.keys(m.approvals||{}).join(', ')||'—')+'</div>'
  +'<div style="margin-top:12px"><button class=act id=mok>'+esc(t('mission.approveLaunch'))+'</button> '
  +'<button class=ghost id=med>'+esc(t('mission.edit'))+'</button> '
  +'<button class=ghost id=mcan>'+esc(t('mission.cancel'))+'</button></div></div>');
 d.querySelector('#med').onclick=async()=>{const r=await api('/api/chat/mission',{missionId:m.id,action:'edit',patch:{objective:d.querySelector('#mo').value,department:d.querySelector('#mdp').value}});if(r.error){alert(r.error);return}await refresh()};
 d.querySelector('#mok').onclick=async()=>{const a=await api('/api/chat/mission',{missionId:m.id,action:'approve'});if(a.error){alert(a.error);return}
  document.getElementById('busy').textContent=t('shell.thinking');
  const r=await api('/api/chat/launch',{missionId:m.id});if(r.error){alert(r.error)}
  await refresh();const th=document.getElementById('thread');th.scrollTop=th.scrollHeight};
 d.querySelector('#mcan').onclick=async()=>{await api('/api/chat/mission',{missionId:m.id,action:'cancel'});await refresh()};
 return d;
}
function approvalCard(a){
 const d=el('<div class="cardx warn"><h3>⚠ '+esc(t('approval.required'))+'</h3>'
  +'<div style="font-size:14px">'+esc(a.what||a.kind||'')+'</div>'
  +'<div style="margin-top:10px"><button class=act id=ap>'+esc(t('approval.approve'))+'</button> <button class=ghost id=ar>'+esc(t('approval.reject'))+'</button></div></div>');
 d.querySelector('#ap').onclick=async()=>{await api('/api/approval',{id:a.id,decision:'approved'});await refresh()};
 d.querySelector('#ar').onclick=async()=>{await api('/api/approval',{id:a.id,decision:'rejected'});await refresh()};
 return d;
}
/** A finished run is a card in the thread too: graph, who ran each stage, tokens, artifacts,
 *  and the OUTPUT ITSELF — a produced site must be previewable, not just described in logs. */
const extractHtml=(txt)=>{const m=String(txt||'').match(/\`\`\`html\s*([\s\S]*?)\`\`\`/);if(m)return m[1];
 if(/<!doctype html|<html[\s>]/i.test(String(txt||'')))return txt;return null};
function runCard(ex){
 const eff=ex.efficiency||{};
 const rows=(ex.graph||[]).map(g=>esc(g.node)+(g.model?' <span class=mut>['+esc(g.provider)+'/'+esc(g.model)+']</span>':'')).join(' → ');
 const artifacts=(eff.artifacts||[]);
 const files=(ex.codeFiles||[]);
 const logs=(ex.logs||[]).slice(0,30);
 const outs=(ex.results||[]).map((r,i)=>({node:r.node||('output '+(i+1)),output:String(r.output||'')})).filter(r=>r.output.trim());
 const d=el('<div class="cardx"><h3>'+esc(t('run.title'))+' · '+esc(ex.department||'')+' · <span class=ok>'+esc(ex.status||'')+'</span></h3>'
  +'<div class=mut style="font-size:13px">'+rows+'</div>'
  +'<div class=mut style="font-size:13px;margin-top:4px">'+(eff.tokensTotal!=null?esc(eff.tokensTotal)+' '+esc(t('run.tokens')):'')
   +(eff.stagesSkipped&&eff.stagesSkipped.length?' · '+esc(t('run.skipped'))+': '+esc(eff.stagesSkipped.join(', ')):'')+'</div>'
  +(artifacts.length?'<div style="margin-top:10px"><b style="font-size:13px">'+esc(t('run.artifacts'))+'</b><div class=mut style="font-size:13px">'+artifacts.map(esc).join('<br>')+'</div></div>':'')
  +(files.length?'<div style="margin-top:10px"><b style="font-size:13px">'+esc(t('run.files'))+'</b>'+files.map(f=>'<details style="margin-top:4px"><summary style="font-size:13px">'+esc(f.name)+'</summary><pre style="background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;overflow:auto;white-space:pre-wrap">'+esc(f.content)+'</pre></details>').join('')+'</div>':'')
  +(logs.length?'<details style="margin-top:10px"><summary style="font-size:13px">'+esc(t('run.logs'))+'</summary><pre style="background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;overflow:auto;white-space:pre-wrap">'+logs.map(esc).join('\\n')+'</pre></details>':'')
  +'</div>');
 outs.forEach((r,i)=>{
  const html=extractHtml(r.output);
  const det=el('<details'+(html?' open':'')+' style="margin-top:10px"><summary style="font-size:13px">'+esc(r.node)+(html?' · html':'')+'</summary>'
   +'<pre style="background:#0b0d11;border:1px solid var(--line);border-radius:8px;padding:10px;font-size:12px;overflow:auto;white-space:pre-wrap;max-height:320px">'+esc(r.output.slice(0,12000))+'</pre>'
   +(html?'<div style="margin-top:6px"><button class=ghost data-pv>▶ '+esc(t('run.preview'))+'</button> <button class=ghost data-dl>↓ '+esc(t('run.download'))+'</button></div>':'')
   +'</details>');
  if(html){
   det.querySelector('[data-pv]').onclick=()=>{const b=new Blob([html],{type:'text/html'});window.open(URL.createObjectURL(b),'_blank')};
   det.querySelector('[data-dl]').onclick=()=>{const b=new Blob([html],{type:'text/html'});const a=document.createElement('a');a.href=URL.createObjectURL(b);a.download=(ex.department||'artifact')+'-'+(i+1)+'.html';a.click()};
  }
  d.appendChild(det)});
 return d;
}

// ── project view: the task spine + its threads ───────────────────────────────
function taskRow(tk,subs){
 const done=tk.status==='done';
 const d=el('<div style="padding:8px 0;border-bottom:1px solid var(--line)">'
  +'<label style="display:flex;gap:9px;align-items:center;color:var(--fg);font-size:14px;margin:0;cursor:pointer">'
  +'<input type=checkbox style="width:auto" '+(done?'checked':'')+'> '
  +'<span style="'+(done?'text-decoration:line-through;color:var(--mut)':'')+'">'+esc(tk.title)+'</span>'
  +(tk.status==='blocked'?'<span class=warn style="font-size:12px">blocked</span>':'')
  +(tk.assignee?'<span class=mut style="font-size:12px">· '+esc(tk.assignee)+'</span>':'')+'</label>'
  +(tk.result?'<div class="'+(tk.result.ok?'ok':'warn')+'" style="font-size:12px;margin-left:26px">'+esc(tk.result.summary)+(tk.result.artifacts&&tk.result.artifacts.length?' · '+tk.result.artifacts.length+' artifact(s)':'')+'</div>':'')
  +subs.map(srow).join('')+'</div>');
 d.querySelector('input').onchange=async(e)=>{await api('/api/task/status',{id:tk.id,status:e.target.checked?'done':'todo'});await refresh()};
 return d;
}
const srow=(s)=>'<div style="margin-left:26px;padding:3px 0;font-size:13px" class="'+(s.status==='done'?'mut':'')+'">'+(s.status==='done'?'✓ ':'○ ')+esc(s.title)+(s.result?' <span class=ok>— '+esc(s.result.summary)+'</span>':'')+'</div>';

function projectView(proj){
 const s=S.state||{};
 const tasks=(s.tasks||[]).filter(x=>x.projectId===proj.id);
 const tops=tasks.filter(x=>!x.parentId);
 const flat=tops.flatMap(x=>[x,...tasks.filter(y=>y.parentId===x.id)]);
 const doneN=flat.filter(x=>x.status==='done'&&!tasks.some(y=>y.parentId===x.id&&y.status!=='done')).length;
 const pct=flat.length?Math.round(doneN/flat.length*100):0;
 const threads=(s.conversations||[]).filter(c=>c.projectId===proj.id);
 const d=el('<div class="cardx"><h3>'+esc(proj.name)+' · <span class=mut>'+doneN+'/'+flat.length+' '+esc(t('project.done'))+'</span></h3>'
  +'<div style="background:#0b0d11;border-radius:8px;height:7px;overflow:hidden;margin-bottom:10px"><div style="background:var(--ok);height:100%;width:'+pct+'%"></div></div>'
  +'<div class=mut style="font-size:13px;margin:8px 0 2px">'+esc(t('project.tasks'))+'</div>'
  +'<div id=ptasks></div>'
  +'<div style="display:flex;gap:8px;margin-top:10px"><input class=inp id=nt placeholder="'+esc(t('project.addTask'))+'" style="margin-top:0"><button class=ghost id=ntb>+</button></div>'
  +(threads.length?'<div class=mut style="font-size:13px;margin:14px 0 4px">'+esc(t('project.threads'))+'</div>':'')
  +'</div>');
 const pt=d.querySelector('#ptasks');
 tops.forEach(tk=>pt.appendChild(taskRow(tk,tasks.filter(y=>y.parentId===tk.id))));
 if(!tops.length)pt.appendChild(el('<div class=mut style="font-size:13px;padding:4px 0">—</div>'));
 const add=async()=>{const v=d.querySelector('#nt').value.trim();if(!v)return;
  const r=await api('/api/task/new',{title:v,projectId:proj.id});if(r.error){alert(r.error);return}await refresh()};
 d.querySelector('#ntb').onclick=add;
 d.querySelector('#nt').onkeydown=(e)=>{if(e.key==='Enter')add()};
 threads.slice().reverse().forEach(c=>{
  const label=c.title||(c.messages[0]?String(c.messages[0].text).slice(0,50):c.id);
  const b=el('<button class="pitem'+(S.convId===c.id?' on':'')+'">'+esc(label)+'</button>');
  b.onclick=()=>{S.convId=c.id;render()};d.appendChild(b)});
 return d;
}

// ── thread ───────────────────────────────────────────────────────────────────
function bubble(m){
 const d=el('<div class="msg '+(m.role==='user'?'user':'bot')+'"><div class=who>'+(m.role==='user'?esc(t('shell.you')):esc(t('shell.brain')))+'</div>'
  +'<div class=body>'+esc(m.text)+'</div>'
  +(m.meta&&(m.meta.model||m.meta.citations&&m.meta.citations.length)?'<div class=meta>'+esc([m.meta.provider&&m.meta.model?(m.meta.provider+'/'+m.meta.model):null,m.meta.costSource,m.meta.citations&&m.meta.citations.length?(t('shell.sources')+': '+m.meta.citations.join(' · ')):null].filter(Boolean).join(' · '))+'</div>':'')
  +'</div>');
 return d;
}
function thread(){
 const s=S.state||{};const box=document.getElementById('msgs');box.innerHTML='';
 const conv=(s.conversations||[]).find(c=>c.id===S.convId);
 if(!conv){
  const proj=S.projectId?(s.projects||[]).find(p=>p.id===S.projectId):null;
  if(proj){box.appendChild(projectView(proj));return}
  box.appendChild(el('<div class=mut style="text-align:center;margin-top:80px;font-size:15px">'+esc(t('shell.emptyThread'))+'</div>'));return}
 const proj=conv.projectId?(s.projects||[]).find(p=>p.id===conv.projectId):null;
 if(proj)box.appendChild(projectView(proj));
 conv.messages.forEach(m=>box.appendChild(bubble(m)));
 const mission=(s.missions||[]).find(m=>m.id===conv.missionId);
 if(mission&&['draft','approved','failed'].includes(mission.status))box.appendChild(missionCard(mission));
 (s.approvals||[]).filter(a=>a.status==='pending'&&(mission&&a.missionId===mission.id)).forEach(a=>box.appendChild(approvalCard(a)));
 if(mission){const ex=(s.executions||[]).filter(e=>e.missionId===mission.id).slice(-1)[0];
  if(ex)box.appendChild(runCard(ex))}
 const th=document.getElementById('thread');th.scrollTop=th.scrollHeight;
}

// ── onboarding: the first conversation — answered IN the composer ───────────
function obSay(txt){return el('<div class="msg bot"><div class=who>'+esc(t('shell.brain'))+'</div><div class=body>'+esc(txt)+'</div></div>')}
function obUser(txt){return el('<div class="msg user"><div class=who>'+esc(t('shell.you'))+'</div><div class=body>'+esc(txt)+'</div></div>')}
function onboarding(){
 const box=document.getElementById('msgs');box.innerHTML='';
 const ob=S.ob||(S.ob={step:'name',name:'',does:'',models:null});saveOb();
 box.appendChild(obSay(t('onboard.greeting')));
 box.appendChild(obSay(t('onboard.companyName')));
 if(ob.name)box.appendChild(obUser(ob.name));
 if(ob.name)box.appendChild(obSay(t('onboard.whatDoYouDo')));
 if(ob.does)box.appendChild(obUser(ob.does));
 if(ob.step==='name'||ob.step==='does')return;   // waiting for a typed answer (composer)
 if(ob.step==='models'){
  const d=el('<div class=cardx><div style="font-size:14px">'+esc(ob.models===null?t('shell.thinking'):(ob.models.length?t('onboard.modelsFound'):t('onboard.noModels')))+'</div>'
   +(ob.models&&ob.models.length?'<div class=mut style="font-size:13px;margin-top:6px">'+ob.models.map(m=>esc(m.provider+'/'+m.name)).join('<br>')+'</div>':'')
   +'<div style="margin-top:12px"><button class=ghost id=free>'+esc(t('onboard.useFree'))+'</button> <span class=mut id=freemsg style="font-size:12px"></span></div>'
   +'<div class=mut style="font-size:12px;margin-top:5px">'+esc(t('onboard.freePrivacy'))+'</div>'
   +(ob.models!==null?'<div style="margin-top:12px"><button class=act>'+esc(t('onboard.continue'))+'</button></div>':'')+'</div>');
  const fb=d.querySelector('#free');
  fb.onclick=async()=>{
   fb.disabled=true;const fm=d.querySelector('#freemsg');fm.textContent=t('onboard.freeChecking');
   const r=await api('/api/connect-free');
   if(r.error){fm.textContent=r.tried?t('onboard.freeNone'):r.error;fb.disabled=false;return}
   fm.textContent='✓ '+r.picked.model+' (free)';
   S.state=r;};
  const b=d.querySelector('button.act');if(b)b.onclick=()=>{ob.step='depts';saveOb();render()};
  box.appendChild(d);return}
 const depts=['technical','customer-service','finance','sales','marketing','human-resources','legal-compliance','operations','data-research'];
 const d=el('<div class=cardx><div style="font-size:14px">'+esc(t('onboard.pickDepartments'))+'</div>'
  +'<div class=deptpick>'+depts.map(x=>'<label><input type=checkbox value="'+x+'" '+(['technical','customer-service','finance'].includes(x)?'checked':'')+'>'+x+'</label>').join('')+'</div>'
  +'<div style="margin-top:14px"><button class=act>'+esc(t('onboard.generate'))+'</button> <span class=mut id=obmsg></span></div></div>');
 d.querySelector('button').onclick=async()=>{
  const departments=[...d.querySelectorAll('input:checked')].map(i=>i.value);
  d.querySelector('#obmsg').textContent=t('onboard.working');
  const r=await api('/api/onboard',{companyName:ob.name,companyDoes:ob.does,departments});
  if(r.error){d.querySelector('#obmsg').textContent=r.error;return}
  S.ob=null;saveOb();await refresh()};
 box.appendChild(d);
}
/** A typed answer during onboarding: name → does → (models card handles the rest). */
async function obAnswer(txt){
 const ob=S.ob;
 if(ob.step==='name'){ob.name=txt;ob.step='does';saveOb();render();return}
 if(ob.step==='does'){ob.does=txt;ob.step='models';ob.models=null;saveOb();render();
  const r=await api('/api/detect');if(S.ob===ob&&ob.step==='models'){ob.models=r.detected||[];saveOb();render()}return}
}

// ── composer + render ────────────────────────────────────────────────────────
function composer(){
 const s=S.state||{};
 const md=document.getElementById('modes');md.innerHTML='';
 ['ask','plan','execute','review'].forEach(m=>{const b=el('<button'+(S.mode===m?' class=on':'')+'>'+esc(t('mode.'+m))+'</button>');
  b.onclick=()=>{S.mode=m;composer()};md.appendChild(b)});
 md.style.display=onboarded(s)?'flex':'none';
 const msg=document.getElementById('msg');msg.placeholder=t('shell.composer');
 const grow=()=>{msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,200)+'px'};
 msg.oninput=grow;
 msg.onkeydown=(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('send').click()}};
 const send=document.getElementById('send');send.title=t('shell.send');
 send.onclick=async()=>{
  const txt=msg.value.trim();if(!txt)return;
  if(!onboarded(S.state||{})){msg.value='';grow();await obAnswer(txt);return}
  document.getElementById('busy').textContent=t('shell.thinking');
  const r=await api('/api/chat/send',{conversationId:S.convId,scope:S.scope,department:S.dept||null,agentId:S.agent||null,mode:S.mode,text:txt,projectId:S.projectId});
  document.getElementById('busy').textContent='';
  if(r.error){alert(r.error);return}
  S.convId=r.conversation.id;msg.value='';grow();await refresh()};
 grow();
}
function render(){
 const s=S.state||{};
 sidebar();thead();composer();
 if(!onboarded(s)){onboarding();return}
 thread();
}
refresh();
</script></body></html>`;

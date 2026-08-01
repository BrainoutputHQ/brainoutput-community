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
<link rel="icon" type="image/png" sizes="32x32" href="/assets/brand/logo/icon-light-32.png">
<link rel="apple-touch-icon" href="/assets/brand/logo/icon-light-180.png">
<style>
:root{--bg:#f5f6f8;--card:#ffffff;--card2:#f2f4f7;--fg:#1a1d24;--mut:#667085;--acc:#2f7cf6;--ok:#16a34a;--warn:#d97706;--line:#e4e7ec;--ub:#dbeafe;--ubline:#bfdbfe;--inp:#f9fafb;--pre:#f2f4f7;--side:#ffffff;--thead:#ffffff;--shadow:0 1px 2px rgba(16,24,40,.06)}
body.dark{--bg:#0e1014;--card:#171a21;--card2:#1c202a;--fg:#e8eaf0;--mut:#8f96a8;--acc:#5b9dff;--ok:#3ddc84;--warn:#ffb454;--line:#242935;--ub:#1e3a5f;--ubline:#2a4a73;--inp:#0f1319;--pre:#0b0d11;--side:#11131a;--thead:#10121a;--shadow:none}
*{box-sizing:border-box}body{margin:0;font:15.5px/1.65 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Helvetica Neue",Arial,sans-serif;background:var(--bg);color:var(--fg);display:flex;height:100vh;overflow:hidden;-webkit-font-smoothing:antialiased}
aside{width:250px;min-width:250px;border-right:1px solid var(--line);background:var(--side);display:flex;flex-direction:column}
aside .brand{padding:18px 18px 14px;border-bottom:1px solid var(--line);font-weight:700;font-size:17px;letter-spacing:-.01em}
.brand img.bl{height:24px;width:24px;border-radius:6px;vertical-align:-6px;margin-right:9px}
.brand img.bl.d{display:none}
body.dark .brand img.bl.l{display:none}
body.dark .brand img.bl.d{display:inline}
aside .brand .tag{display:block;font-weight:400;font-size:12px;color:var(--mut);margin-top:2px}
aside .scroll{flex:1;overflow:auto;padding:12px}
aside .foot{padding:12px 16px;border-top:1px solid var(--line);display:flex;gap:10px;align-items:center;font-size:13px}
aside select{background:var(--inp);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:5px 8px;font-size:13px}
.vmenu{display:flex;gap:2px;padding:3px;background:var(--card2);border-radius:12px;margin-bottom:10px}
.vmenu button{flex:1;background:none;border:none;color:var(--mut);border-radius:9px;padding:7px 4px;cursor:pointer;font-size:12.5px;font-weight:600}
.vmenu button.on{background:var(--card);color:var(--fg);box-shadow:var(--shadow)}
.acts{display:flex;flex-direction:column;gap:2px;margin-bottom:6px}
.acts button{display:flex;align-items:center;gap:9px;background:none;border:none;border-radius:10px;padding:8px 12px;color:var(--fg);cursor:pointer;font-size:14px;text-align:left}
.acts button:hover{background:var(--card2)}
.acts button svg{color:var(--acc)}
.shead{color:var(--mut);font-size:11.5px;font-weight:600;text-transform:uppercase;letter-spacing:.08em;margin:20px 6px 7px;display:flex;align-items:center;gap:7px}
.scroll>.shead:first-of-type{margin-top:12px}
.shead svg{opacity:.7}
.pitem{display:flex;align-items:center;gap:9px;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:10px;padding:9px 12px;color:var(--fg);cursor:pointer;font-size:14px;margin-bottom:2px}
.pitem:hover{background:var(--card2)}.pitem.on{background:var(--card2);border-color:var(--line)}
.pitem .lab{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pitem svg{opacity:.8;flex:none}
.pitem .cnt{color:var(--mut);font-size:12px;flex:none}
.sdot{width:8px;height:8px;border-radius:50%;flex:none}
.sdot.run{background:var(--acc);animation:boPulse 1.1s ease-in-out infinite}
.sdot.attn{background:var(--warn)}
.vmenu button svg{vertical-align:-2px;margin-right:5px}
.pitem{display:block;width:100%;text-align:left;background:none;border:1px solid transparent;border-radius:10px;padding:9px 12px;color:var(--fg);cursor:pointer;font-size:14px;margin-bottom:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.pitem:hover{background:var(--card2)}.pitem.on{background:var(--card2);border-color:var(--line)}
.pitem .cnt{float:right;color:var(--mut);font-size:12px}
main{flex:1;display:flex;flex-direction:column;min-width:0}
#thead{border-bottom:1px solid var(--line);padding:12px 22px;display:flex;gap:10px;align-items:center;flex-wrap:wrap;background:var(--thead)}
#thead .title{font-weight:650;font-size:15px}
#thead select{background:var(--inp);border:1px solid var(--line);color:var(--fg);border-radius:8px;padding:6px 9px;font-size:13px}
#thread{flex:1;overflow:auto;padding:26px 22px 12px}
.wrap{max-width:780px;margin:0 auto}
.msg{margin-bottom:22px}
.msg .who{font-size:12px;color:var(--mut);margin-bottom:5px;font-weight:600}
.msg.user{text-align:right}
.msg.user .who{text-align:right}
.msg.user .body{display:inline-block;text-align:left;background:var(--ub);border:1px solid var(--ubline);border-radius:18px 18px 4px 18px;padding:11px 16px;max-width:85%;white-space:pre-wrap}
.msg.bot .body{white-space:pre-wrap;padding:2px 0}
.msg .meta{font-size:11.5px;color:var(--mut);margin-top:5px}
.msg.user .meta{padding-right:4px}
.cardx{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:4px 0 20px;box-shadow:var(--shadow)}
.cardx h3{margin:0 0 10px;font-size:14px;color:var(--acc);font-weight:650}
.cardx.warn{border-color:var(--warn)}.cardx.warn h3{color:var(--warn)}
.mut{color:var(--mut)}.ok{color:var(--ok)}.warn{color:var(--warn)}
button.act{background:var(--acc);color:#fff;border:none;border-radius:10px;padding:9px 16px;font-weight:650;cursor:pointer;font-size:14px}
button.ghost{background:none;border:1px solid var(--line);color:var(--mut);border-radius:10px;padding:9px 15px;cursor:pointer;font-size:14px}
button.ghost:hover{color:var(--fg);border-color:var(--acc)}
input,textarea,select.inp{background:var(--inp);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:10px 12px;width:100%;font:inherit;margin-top:4px}
label{display:block;margin:10px 0 3px;color:var(--mut);font-size:13px}
#composer{border-top:1px solid var(--line);padding:14px 22px 18px;background:var(--bg)}
#cbox{background:var(--card);border:1px solid var(--line);border-radius:20px;padding:10px 12px 8px;transition:border-color .15s, box-shadow .15s;box-shadow:var(--shadow)}
#cbox:focus-within{border-color:var(--acc);box-shadow:0 0 0 3px rgba(47,124,246,.14)}
#msg{width:100%;background:none;border:none;outline:none;color:var(--fg);font:inherit;resize:none;max-height:200px;padding:4px 6px;line-height:1.55}
#cbar{display:flex;align-items:center;margin-top:4px}
.seg{display:flex;border:1px solid var(--line);border-radius:10px;overflow:hidden}
.seg button{background:none;border:none;color:var(--mut);padding:6px 13px;cursor:pointer;font-size:12.5px}
.seg button.on{background:var(--card2);color:var(--fg)}
#send{margin-left:auto;width:38px;height:38px;border-radius:50%;background:var(--acc);color:#fff;border:none;font-size:17px;font-weight:700;cursor:pointer;display:grid;place-items:center}
#send:disabled{background:var(--card2);color:var(--mut);cursor:default}
#send.busy{animation:boPulse 1s ease-in-out infinite}
@keyframes boPulse{50%{opacity:.35}}
.think{display:inline-flex;gap:4px;padding:12px 16px;background:var(--card);border:1px solid var(--line);border-radius:14px}
.think span{width:7px;height:7px;border-radius:50%;background:var(--mut);animation:boDot 1.2s infinite}
.think span:nth-child(2){animation-delay:.2s}.think span:nth-child(3){animation-delay:.4s}
@keyframes boDot{30%{opacity:.25}60%{opacity:1}}
.wdot{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--acc);margin-left:6px;animation:boPulse 1.1s ease-in-out infinite}
.attach{display:inline-block;margin-top:6px;padding:3px 10px;border:1px solid var(--line);border-radius:12px;font-size:12px;color:var(--mut);background:var(--card2)}
#busy{font-size:12.5px;color:var(--mut);margin:6px 4px 0;min-height:16px}
.deptpick{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
.deptpick label{background:var(--inp);border:1px solid var(--line);border-radius:18px;padding:7px 14px;color:var(--fg);font-size:13.5px;cursor:pointer;margin:0}
.deptpick input{width:auto;margin-right:6px}
details summary{cursor:pointer}
details.fold{background:var(--card);border:1px solid var(--line);border-radius:14px;margin:4px 0 14px;box-shadow:var(--shadow)}
details.fold>summary{list-style:none;padding:14px 18px;font-size:14px;font-weight:650;color:var(--fg);display:flex;align-items:center;gap:8px}
details.fold>summary::-webkit-details-marker{display:none}
details.fold>summary::after{content:"▸";margin-left:auto;color:var(--mut);transition:transform .15s}
details.fold[open]>summary::after{transform:rotate(90deg)}
details.fold>summary .sub{color:var(--mut);font-weight:400;font-size:12.5px}
details.fold>.fb{padding:4px 18px 16px;border-top:1px solid var(--line)}
.pill{display:inline-block;padding:2px 9px;border-radius:11px;border:1px solid var(--line);font-size:11.5px;font-weight:600}
.pill.ok{color:var(--ok);border-color:var(--ok)}
.pill.dormant{color:var(--mut)}
pre{background:var(--pre)!important}
#mobilebar{display:none}
@media(max-width:760px){
 #mobilebar{display:flex;align-items:center;gap:10px;padding:10px 14px;border-bottom:1px solid var(--line);background:var(--thead)}
 #mobilebar button{background:none;border:1px solid var(--line);border-radius:8px;color:var(--fg);font-size:16px;padding:4px 10px;cursor:pointer}
 aside{position:fixed;left:0;top:0;bottom:0;transform:translateX(-105%);transition:transform .2s ease;z-index:30;box-shadow:2px 0 12px rgba(0,0,0,.2)}
 body.nav-open aside{transform:none}
 #scrim{position:fixed;inset:0;background:rgba(15,17,20,.35);z-index:25}
}
</style></head><body>
<aside>
 <div class=brand><span id=coname><img class="bl l" src="/assets/brand/logo/icon-light-192.png" alt="BrainOutput"><img class="bl d" src="/assets/brand/logo/icon-dark-192.png" alt="BrainOutput"><span id=conamet>BrainOutput</span></span><span class=tag id=tagline></span></div>
 <div class=scroll>
  <div class=vmenu>
   <button id=vm-chat><i class=ic></i><span></span></button>
   <button id=vm-work><i class=ic></i><span></span></button>
   <button id=vm-settings><i class=ic></i><span></span></button>
  </div>
  <div class=acts>
   <button id=na-chat><i class=ic></i><span id=lnewchat></span></button>
   <button id=na-proj><i class=ic></i><span id=lnewproj></span></button>
  </div>
  <input id=qsearch class=inp style="margin:4px 0 8px;width:100%" placeholder="">
  <div class=shead><span id=lprojects></span></div>
  <div id=projects></div>
  <div class=shead><span id=ladhoc></span></div>
  <div id=adhoc></div>
  <div class=shead><span id=lsources></span></div>
  <div id=sources></div>
  <div id=qresults></div>
 </div>
 <div class=foot>
  <select id=locale><option value="en">EN</option><option value="fr">FR</option><option value="de">DE</option></select>
  <button class=ghost id=themebtn style="padding:5px 9px"></button>
 </div>
</aside>
<main>
 <div id=mobilebar><button id=navtoggle>☰</button><span id=mconame style="font-weight:650"></span></div>
 <div id=thead></div>
 <div id=thread><div class=wrap id=msgs></div></div>
 <div id=composer><div class=wrap>
  <div id=cbox>
   <textarea id=msg rows=2></textarea>
   <div id=cbar>
    <button class=ghost id=mic title="" style="padding:6px 10px;margin-right:8px">🎤</button>
    <button class=ghost id=attach title="" style="padding:6px 10px;margin-right:8px">📎</button>
    <input type=file id=file style="display:none">
    <div class=seg id=modes></div>
    <button id=send title="">↑</button>
   </div>
   <div id=atts style="margin-top:4px"></div>
  </div>
  <div id=busy></div>
 </div></div>
</main>
<script>
const T=__BO_I18N__;
const T_SLOTS=__BO_SLOTS__;
const LOCALE='__BO_LOCALE__';
const CSRF='__BO_CSRF__';
const t=(k)=>T[k]||k;
const S={state:null,convId:null,projectId:null,mode:'ask',scope:'company',dept:'',agent:'',ob:null,view:'chat'};
const esc=(s)=>String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const el=(h)=>{const d=document.createElement('div');d.innerHTML=h;
 if(d.childElementCount>1)console.error('el(): multi-root html — all but the first element are DROPPED:',String(h).slice(0,140));
 return d.firstElementChild};
// Consistent inline SVG line icons (stroke=currentColor, 24 grid) — no emoji as UI iconography.
const ICONS={
 chat:'<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
 work:'<rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2"/>',
 settings:'<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
 folder:'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
 database:'<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4.03 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/>',
 mail:'<path d="M4 4h16a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z"/><path d="M22 6l-10 7L2 6"/>',
 drive:'<path d="M22 12H2"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/><path d="M6 16h.01"/><path d="M10 16h.01"/>',
 apps:'<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/>',
 plus:'<circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/>',
 folderplus:'<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><path d="M12 11v6"/><path d="M9 14h6"/>',
};
const I=(n,sz=15)=>'<svg width="'+sz+'" height="'+sz+'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'+(ICONS[n]||'')+'</svg>';
const FAMILY_ICON={mail:'mail',files:'drive',apps:'apps'};
/** A foldable settings section — folded by default, with a status subtitle in the summary line. */
function fold(title, sub, { open = false } = {}) {
 const d=el('<details class="fold"'+(open?' open':'')+'><summary>'+esc(title)+(sub?'<span class=sub>'+esc(sub)+'</span>':'')+'</summary><div class=fb></div></details>');
 return { el: d, body: d.querySelector('.fb') };
}
// Theme: LIGHT is the default (business look); the toggle persists a dark choice.
try{if(localStorage.getItem('bo_theme')==='dark')document.body.classList.add('dark')}catch{}
const toggleTheme=()=>{const d=document.body.classList.toggle('dark');try{localStorage.setItem('bo_theme',d?'dark':'light')}catch{}};
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
 document.getElementById('lprojects').innerHTML=I('folder',12)+esc(t('shell.projects'));
 document.getElementById('lnewproj').textContent=t('shell.newProject');
 document.getElementById('lnewchat').textContent=t('shell.newChat');
 document.getElementById('na-chat').querySelector('.ic').innerHTML=I('plus');
 document.getElementById('na-proj').querySelector('.ic').innerHTML=I('folderplus');
 document.getElementById('ladhoc').innerHTML=I('chat',12)+esc(t('shell.adHoc'));
 document.getElementById('lsources').innerHTML=I('database',12)+esc(t('nav.sources'));
 document.getElementById('locale').value=LOCALE;
 document.getElementById('conamet').textContent=s.company?.name||'BrainOutput';
 document.getElementById('mconame').textContent=s.company?.name||'BrainOutput';
 const nt=document.getElementById('navtoggle');
 nt.onclick=()=>{
  const open=document.body.classList.toggle('nav-open');
  let scrim=document.getElementById('scrim');
  if(open&&!scrim){scrim=el('<div id=scrim></div>');scrim.onclick=()=>{document.body.classList.remove('nav-open');scrim.remove()};document.body.appendChild(scrim)}
  if(!open&&scrim)scrim.remove();
 };
 // navigating from the sidebar closes the mobile nav
 document.querySelectorAll('aside .pitem,aside .vmenu button,aside .acts button').forEach(b=>b.addEventListener('click',()=>{document.body.classList.remove('nav-open');document.getElementById('scrim')?.remove()}));
 // view menu + mode dropdown + theme toggle — icons are inline SVG, never emoji
 const vm=[['chat',t('nav.chat'),'chat'],['work',t('nav.work'),'work'],['settings',t('nav.settings'),'settings']];
 ['chat','work','settings'].forEach((v,i)=>{const b=document.getElementById('vm-'+v);if(!b)return;
  b.querySelector('.ic').innerHTML=I(vm[i][2],14);b.querySelector('span').textContent=vm[i][1];
  b.className=S.view===v?'on':'';b.onclick=()=>{S.view=v;render()}});
 const tb=document.getElementById('themebtn');tb.textContent=document.body.classList.contains('dark')?'☀':'☾';
 tb.onclick=toggleTheme;
 const convs=s.conversations||[];
 // Chat search: find and reopen any conversation by its content.
 const qs=document.getElementById('qsearch');
 qs.placeholder=t('shell.searchChats');qs.value=S.q||'';
 const qr=document.getElementById('qresults');qr.innerHTML='';
 const searching=!!(S.q&&S.q.trim());
 document.getElementById('projects').style.display=searching?'none':'';
 document.getElementById('adhoc').style.display=searching?'none':'';
 document.getElementById('sources').style.display=searching?'none':'';
 // The Sources rollup — always visible, connected or not (the carousel's intranet display, for
 // real): one row per family, status chip, click opens the Sources catalog.
 const srcBox=document.getElementById('sources');srcBox.innerHTML='';
 (s.sourceFamilies||[]).forEach(f=>{
  const chip=f.state==='connected'?'<span class=cnt>✓'+(f.connected>1?' '+f.connected:'')+'</span>'
   :f.state==='available'?'<span class=cnt>+</span>'
   :'<span class=cnt>'+esc(t('sources.soon'))+'</span>';
  const b=el('<button class="pitem">'+I(FAMILY_ICON[f.family]||'apps')+'<span class=lab>'+esc(t('sources.family.'+f.family))+'</span>'+chip+'</button>');
  b.onclick=()=>{S.view='settings';render()};       // the catalog lives in Settings
  srcBox.appendChild(b)});
 document.querySelectorAll('aside .shead').forEach(h=>h.style.display=searching?'none':'flex');
 if(searching){
  const q=S.q.trim().toLowerCase();
  const hits=(s.conversations||[]).filter(c=>(c.title||'').toLowerCase().includes(q)
    ||(c.messages||[]).some(m=>String(m.text).toLowerCase().includes(q))).reverse().slice(0,20);
  hits.forEach(c=>{
   const label=c.title||(c.messages[0]?String(c.messages[0].text).slice(0,40):c.id);
   const proj=c.projectId?(s.projects||[]).find(p=>p.id===c.projectId):null;
   const b=el('<button class="pitem">'+I('chat')+'<span class=lab>'+esc(label)+(proj?' <span class=mut>· '+esc(proj.name)+'</span>':'')+'</span></button>');
   b.onclick=()=>{S.projectId=c.projectId||null;S.convId=c.id;S.view='chat';S.q='';render()};
   qr.appendChild(b)});
  if(!hits.length)qr.appendChild(el('<div class=mut style="font-size:13px;padding:4px 6px">—</div>'));
 }
 qs.onchange=()=>{S.q=qs.value;render()};
 qs.oninput=()=>{S.q=qs.value;clearTimeout(S._q);S._q=setTimeout(render,250)};
 const runningPids=new Set((s.executions||[]).filter(e=>e.status==='running').map(e=>e.projectId).filter(Boolean));
 // Attention = a mission in that project waits on the user (draft or post-run approval).
 const attnPids=new Set((s.missions||[]).filter(m=>m.projectId&&(m.status==='awaiting-approval'||m.status==='draft')).map(m=>m.projectId));
 const proj=document.getElementById('projects');proj.innerHTML='';
 (s.projects||[]).forEach(p=>{
  const n=convs.filter(c=>c.projectId===p.id).length;
  const dot=runningPids.has(p.id)?'<span class="sdot run" title="running"></span>':attnPids.has(p.id)?'<span class="sdot attn" title="needs you"></span>':'';
  const b=el('<button class="pitem'+(S.projectId===p.id?' on':'')+'">'+I('folder')+'<span class=lab>'+esc(p.name)+'</span>'+dot+'<span class=cnt>'+(n||'')+'</span></button>');
  b.onclick=()=>{S.projectId=p.id;S.convId=null;S.view='chat';render()};
  proj.appendChild(b)});
 if(!(s.projects||[]).length)proj.appendChild(el('<div class=mut style="font-size:13px;padding:4px 6px">'+esc(t('shell.emptyProjects'))+'</div>'));
 const ad=document.getElementById('adhoc');ad.innerHTML='';
 convs.filter(c=>!c.projectId).slice().reverse().slice(0,20).forEach(c=>{
  const label=c.title||(c.messages[0]?String(c.messages[0].text).slice(0,34):c.id);
  const b=el('<button class="pitem'+(S.convId===c.id&&!S.projectId?' on':'')+'">'+I('chat')+'<span class=lab>'+esc(label)+'</span></button>');
  b.onclick=()=>{S.projectId=null;S.convId=c.id;S.view='chat';render()};
  ad.appendChild(b);
  const del=el('<button class="delchat" title="'+esc(t('chat.delete'))+'" style="margin-left:auto;flex:none;background:none;border:none;color:var(--mut);cursor:pointer;font-size:12px;padding:2px 4px">✕</button>');
  del.onclick=async(e)=>{e.stopPropagation();if(!confirm(t('chat.deleteConfirm')))return;
   await api('/api/conversation/delete',{id:c.id});if(S.convId===c.id)S.convId=null;await refresh()};
  b.appendChild(del)});
 document.getElementById('na-chat').onclick=()=>{S.projectId=null;S.convId=null;S.view='chat';render()};
 document.getElementById('na-proj').onclick=async()=>{
  const name=prompt(t('shell.projectName'));if(!name||!name.trim())return;
  const r=await api('/api/project',{name:name.trim()});if(r.error){alert(r.error);return}
  S.projectId=(r.project||{}).id||S.projectId;S.convId=null;await refresh()};
 document.getElementById('locale').onchange=async(e)=>{await api('/api/settings',{locale:e.target.value});location.reload()};
}

// ── thread header: title + ONE "who answers" selector + promote ─────────────
// Was three interdependent dropdowns (scope → department → agent) that changed meaning under the
// user's feet. Now a single flat selector: the company, your Alter, or one department/agent.
function thead(){
 const s=S.state||{};const h=document.getElementById('thead');h.innerHTML='';
 if(!onboarded(s)){h.appendChild(el('<span class=title>🏢 BrainOutput</span>'));return}
 const conv=(s.conversations||[]).find(c=>c.id===S.convId);
 const proj=conv&&conv.projectId?(s.projects||[]).find(p=>p.id===conv.projectId):null;
 h.appendChild(el('<span class=title>'+esc(proj?proj.name:(conv?(conv.title||(conv.messages[0]?String(conv.messages[0].text).slice(0,40):'')):'🏢 BrainOutput'))+'</span>'));
 // The single "talking to" selector. Value encoding: company | twin | dept:<name> | agent:<id>.
 const cur=S.scope==='department'&&S.dept?'dept:'+S.dept:S.scope==='agent'&&S.agent?'agent:'+S.agent:S.scope==='work-twin'?'twin':'company';
 const sel=el('<select id=talkto title="'+esc(t('thead.hint'))+'">'
  +'<option value="company">'+esc(t('scope.company'))+'</option>'
  +'<option value="twin">'+esc(t('scope.work-twin'))+'</option>'
  +((s.departments||[]).length?'<optgroup label="'+esc(t('thead.departments'))+'">'+(s.departments||[]).map(d=>'<option value="dept:'+esc(d)+'">'+esc(d)+'</option>').join('')+'</optgroup>':'')
  +((s.agents||[]).length?'<optgroup label="'+esc(t('thead.agents'))+'">'+(s.agents||[]).map(a=>'<option value="agent:'+esc(a.id)+'">'+esc(a.id)+'</option>').join('')+'</optgroup>':'')
  +'</select>');
 sel.value=cur;
 sel.onchange=()=>{const v=sel.value;
  if(v==='twin'){S.scope='work-twin';S.dept='';S.agent=''}
  else if(v.startsWith('dept:')){S.scope='department';S.dept=v.slice(5);S.agent=''}
  else if(v.startsWith('agent:')){S.scope='agent';S.agent=v.slice(6);S.dept=''}
  else{S.scope='company';S.dept='';S.agent=''}
  render()};
 h.appendChild(el('<span class=mut style="font-size:12px">'+esc(t('thead.to'))+'</span>'));
 h.appendChild(sel);
 if(conv){const pr=el('<select style="margin-left:auto" title="'+esc(t('shell.promoteHint'))+'"><option value="">'+esc(t('shell.promote'))+'</option>'+(s.projects||[]).map(p=>'<option value="'+p.id+'">'+esc(p.name)+'</option>').join('')+'<option value="__new">+ '+esc(t('shell.newProject'))+'</option></select>');
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
 const plan=(m.planPreview||[]);
 const d=el('<div class="cardx"><h3>'+esc(t('mission.objective'))+' · <span class=mut>'+esc(m.status)+'</span></h3>'
  +'<label>'+esc(t('mission.objective'))+'</label><input class=inp id=mo value="'+esc(m.objective||'')+'">'
  +'<label>'+esc(t('mission.department'))+'</label><input class=inp id=mdp value="'+esc(m.department||'')+'">'
  // The PLAN you approve — always shown before launch; approving is never blind.
  +(plan.length?'<div style="margin-top:10px"><b style="font-size:13px">'+esc(t('mission.plan'))+'</b><ol style="margin:6px 0 0;padding-left:22px;font-size:13.5px">'+plan.map((s)=>'<li>'+esc(s)+'</li>').join('')+'</ol></div>':'')
  +'<div class=mut style="font-size:13px;margin-top:8px">'+esc(t('mission.graph'))+': '+esc(g)+' · '+esc((m.graph&&m.graph.nodes||[]).join(' → '))+' · '+esc(t('mission.approvalGates'))+': '+esc(Object.keys(m.approvals||{}).join(', ')||'—')+'</div>'
  +(m.acceptanceCriteria&&m.acceptanceCriteria.length?'<div class=mut style="font-size:12.5px;margin-top:4px">'+esc(t('mission.criteria'))+': '+esc(m.acceptanceCriteria.join(' · '))+'</div>':'')
  +'<div style="margin-top:12px"><button class=act id=mok>'+esc(t('mission.approveLaunch'))+'</button> '
  +'<button class=ghost id=med>'+esc(t('mission.edit'))+'</button> '
  +'<button class=ghost id=mcan>'+esc(t('mission.cancel'))+'</button></div></div>');
 d.querySelector('#med').onclick=async()=>{const r=await api('/api/chat/mission',{missionId:m.id,action:'edit',patch:{objective:d.querySelector('#mo').value,department:d.querySelector('#mdp').value}});if(r.error){alert(r.error);return}await refresh()};
 d.querySelector('#mok').onclick=async()=>{const a=await api('/api/chat/mission',{missionId:m.id,action:'approve'});if(a.error){alert(a.error);return}
  // Async launch: returns instantly; the live run view + polling take it from here.
  const r=await api('/api/chat/launch',{missionId:m.id});if(r.error){alert(r.error);return}
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
 const running=ex.status==='running';
 const eff=ex.efficiency||{};
 const rows=(ex.graph||[]).map(g=>(g.status==='done'?'✓ ':running?'… ':'')+esc(g.node)+(g.model?' <span class=mut>['+esc(g.provider)+'/'+esc(g.model)+']</span>':'')).join(' → ');
 const artifacts=(eff.artifacts||[]);
 const files=(ex.codeFiles||[]);
 const logs=(ex.logs||[]).slice(0,30);
 const outs=(ex.results||[]).map((r,i)=>({node:r.node||('output '+(i+1)),output:String(r.output||'')})).filter(r=>r.output.trim());
 const d=el('<div class="cardx"><h3>'+esc(t('run.title'))+' · '+esc(ex.department||'')+' · <span class="'+(running?'warn':'ok')+'">'+(running?esc(t('run.running')):esc(ex.status||''))+'</span></h3>'
  +'<div class=mut style="font-size:13px">'+rows+'</div>'
   +'<div class=mut style="font-size:13px;margin-top:4px">'+(eff.tokensTotal!=null?esc(eff.tokensTotal)+' '+esc(t('run.tokens')):'')
    +(eff.tokensScope==='partial'?' <span class=warn title="'+esc(t('run.tokensPartial'))+'">('+esc(t('run.tokensPartial'))+')</span>':'')
    +(eff.stagesSkipped&&eff.stagesSkipped.length?' · '+esc(t('run.skipped'))+': '+esc(eff.stagesSkipped.join(', ')):'')+'</div>'
  +(artifacts.length?'<div style="margin-top:10px"><b style="font-size:13px">'+esc(t('run.artifacts'))+'</b><div class=mut style="font-size:13px">'+artifacts.map(esc).join('<br>')+'</div></div>':'')
  +(((S.state||{}).artifacts||[]).filter(a=>a.executionId===ex.id).map(a=>'<a href="/api/artifact/download?id='+esc(a.id)+'" target="_blank" title="'+esc(t('run.download'))+'" style="display:inline-flex;align-items:center;gap:6px;margin:8px 8px 0 0;padding:7px 12px;border:1px solid var(--acc);border-radius:10px;font-size:13px;text-decoration:none;color:var(--acc)"><span style="font-size:16px">📄</span><b>'+esc(a.name)+'</b><span class=mut>'+Math.round(a.size/1024)+' KB</span></a>').join(''))
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
 const open=S.openTask===tk.id;
 const mission=tk.missionId?((S.state||{}).missions||[]).find(m=>m.id===tk.missionId):null;
 const d=el('<div style="padding:8px 0;border-bottom:1px solid var(--line)">'
  +'<label style="display:flex;gap:9px;align-items:center;color:var(--fg);font-size:14px;margin:0;cursor:pointer">'
  +'<input type=checkbox style="width:auto" '+(done?'checked':'')+'> '
  +'<span class=tlink style="'+(done?'text-decoration:line-through;color:var(--mut)':'')+'cursor:pointer">'+esc(tk.title)+'</span>'
  +(tk.status==='blocked'?'<span class=warn style="font-size:12px">blocked</span>':'')
  +(tk.assignee?'<span class=mut style="font-size:12px">· '+esc(tk.assignee)+'</span>':'')+'</label>'
  +(tk.result?'<div class="'+(tk.result.ok?'ok':'warn')+'" style="font-size:12px;margin-left:26px">'+esc(tk.result.summary)+(tk.result.artifacts&&tk.result.artifacts.length?' · '+tk.result.artifacts.length+' artifact(s)':'')+'</div>':'')
  +(open?'<div class=cardx style="margin:8px 0 4px 26px;padding:12px 14px">'
    +'<div class=mut style="font-size:12px">status: <b>'+esc(tk.status)+'</b>'+(tk.assignee?' · '+esc(tk.assignee):'')+(tk.missionId?' · mission '+esc(tk.missionId)+(mission?' ('+esc(mission.status)+')':''):' · manual task')+'</div>'
    +(tk.result?'<div style="font-size:13px;margin-top:6px">'+esc(tk.result.summary)+'</div>'
      +(tk.result.artifacts&&tk.result.artifacts.length?'<div class=mut style="font-size:12px;margin-top:4px">'+tk.result.artifacts.map(esc).join('<br>')+'</div>':''):'')
    +(mission&&mission.conversationId?'<div style="margin-top:8px"><button class=ghost id=goc>'+esc(t('task.openThread'))+'</button></div>':'')
    +'</div>':'')
  +subs.map(srow).join('')+'</div>');
 d.querySelector('input').onchange=async(e)=>{e.stopPropagation();await api('/api/task/status',{id:tk.id,status:e.target.checked?'done':'todo'});await refresh()};
 d.querySelector('.tlink').onclick=()=>{S.openTask=open?null:tk.id;render()};
 const goc=d.querySelector('#goc');
 if(goc)goc.onclick=()=>{S.view='chat';S.convId=mission.conversationId;render()};
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
 tops.slice(0,25).forEach(tk=>pt.appendChild(taskRow(tk,tasks.filter(y=>y.parentId===tk.id))));
 if(tops.length>25)pt.appendChild(el('<div class=mut style="font-size:12px;padding:4px 0">+ '+(tops.length-25)+' more</div>'));
 if(!tops.length)pt.appendChild(el('<div class=mut style="font-size:13px;padding:4px 0">—</div>'));
 const add=async()=>{const v=d.querySelector('#nt').value.trim();if(!v)return;
  const r=await api('/api/task/new',{title:v,projectId:proj.id});if(r.error){alert(r.error);return}await refresh()};
 d.querySelector('#ntb').onclick=add;
 d.querySelector('#nt').onkeydown=(e)=>{if(e.key==='Enter')add()};
 threads.slice().reverse().slice(0,20).forEach(c=>{
  const label=c.title||(c.messages[0]?String(c.messages[0].text).slice(0,50):c.id);
  const b=el('<button class="pitem'+(S.convId===c.id?' on':'')+'">'+esc(label)+'</button>');
  b.onclick=()=>{S.convId=c.id;render()};d.appendChild(b)});
 return d;
}

// ── settings: company, models, connections — everything standard needs in one place ──────
function settingsView(){
 const s=S.state||{};
 const conns=s.connections||[];
 const slots=[...new Set((s.agents||[]).flatMap(a=>Object.values(a.capabilities||{})))];
 const wrap=el('<div></div>');
 // Company identity — including the website the Brain fetches pictures and context from.
 const CO=fold(t('settings.company'),s.company?.name||null,{open:true});
 const co=CO.body;
 co.innerHTML='<div style="margin-top:10px"><label>'+esc(t('settings.name'))+'</label><input class=inp id=cn value="'+esc(s.company?.name||'')+'">'
  +'<label>'+esc(t('settings.website'))+'</label><input class=inp id=cw value="'+esc(s.company?.website||'')+'" placeholder="https://…">'
  +'<div style="margin-top:10px"><button class=act id=csave>'+esc(t('settings.save'))+'</button> <span class=mut id=cmsg style="font-size:12px"></span></div></div>';
 co.querySelector('#csave').onclick=async()=>{
  const r=await api('/api/company',{name:co.querySelector('#cn').value,website:co.querySelector('#cw').value});
  co.querySelector('#cmsg').textContent=r.error||'✓';if(!r.error){S.state=r;render()}};
 wrap.appendChild(CO.el);
 // Users — the actual people on this workspace. Open by default: you should always see WHO the
 // Alter acts for, and its permission mode, at a glance.
 const twins=s.workTwins||[];
 const UF=fold(t('settings.users'),twins.length?twins.map(x=>x.employee?.name||x.employee?.email).join(', '):t('settings.noUsers'),{open:true});
 const ub=UF.body;
 if(!twins.length){
  const d=el('<div style="margin-top:10px"><div class=mut style="font-size:13px;margin-bottom:8px">'+esc(t('settings.noUsersHint'))+'</div>'
   +'<div class=row style="display:flex;gap:8px"><input class=inp id=un placeholder="'+esc(t('work.yourName'))+'" style="margin-top:0"><input class=inp id=ue placeholder="you@company.com" style="margin-top:0"></div>'
   +'<div style="margin-top:8px"><button class=act>'+esc(t('work.createAlter'))+'</button> <span class=mut id=umsg style="font-size:12px"></span></div></div>');
  d.querySelector('button').onclick=async()=>{
   const nm=d.querySelector('#un').value.trim(),em=d.querySelector('#ue').value.trim();
   if(!em){d.querySelector('#umsg').textContent='email?';return}
   const r=await api('/api/worktwin/create',{employee:{id:em.split('@')[0],name:nm||em,email:em}});
   d.querySelector('#umsg').textContent=r.error||'✓';if(!r.error){S.state=r.state;render()}};
  ub.appendChild(d);
 }
 twins.forEach(tw=>{
  const acc=tw.accounts||[];
  const row=el('<div style="margin-top:10px;padding:10px;border:1px solid var(--line);border-radius:10px">'
   +'<div style="display:flex;gap:8px;align-items:center"><b style="font-size:14px">'+esc(tw.employee?.name||tw.name)+'</b>'
   +'<span class=mut style="font-size:12.5px">'+esc(tw.employee?.email||'')+'</span></div>'
   +'<div class=mut style="font-size:12.5px;margin-top:3px">'+esc(t('settings.userAlter'))+': '+esc(tw.name)+' · '+esc(t('settings.userSources'))+': '+acc.length+' · '+(tw.indexSize||0)+' '+esc(t('work.indexed'))+'</div>'
   +'<div style="margin-top:7px;display:flex;gap:6px;align-items:center;flex-wrap:wrap"><span class=mut style="font-size:12px">'+esc(t('settings.userMode'))+':</span>'
   +['mirror','copilot','delegate'].map(m=>'<button class="'+(tw.mode===m?'act':'ghost')+'" data-m="'+m+'" style="font-size:12px;padding:4px 11px">'+esc(t('twin.mode.'+m))+'</button>').join('')
   +'</div><div class=mut style="font-size:11.5px;margin-top:5px">'+esc(t('twin.mode.'+(tw.mode||'mirror')+'.desc'))+'</div></div>');
  row.querySelectorAll('[data-m]').forEach(b=>b.onclick=async()=>{
   const r=await api('/api/worktwin/mode',{twinId:tw.id,mode:b.dataset.m});if(r.error){alert(r.error);return}await refresh()});
  ub.appendChild(row)});
 wrap.appendChild(UF.el);
 // The sources catalog lives in Settings (the menu stays lean); the sidebar keeps the rollup.
 wrap.appendChild(sourcesView());
 const MF=fold(t('models.assignments'),conns.length+' '+t('models.connections').toLowerCase());
 const MB=MF.body;
 const a=el('<div style="margin-top:10px"><div class=mut style="font-size:12.5px;margin-bottom:8px">'+esc(t('models.hint'))+'</div></div>');
 slots.forEach(sl=>{
  const cur=(s.assignments||{})[sl];
  const lab=T_SLOTS[sl]||[sl.replace(/[-_]/g,' '),''];
  const row=el('<div style="padding:8px 0;border-bottom:1px solid var(--line)">'
   +'<div style="display:flex;gap:10px;align-items:center">'
   +'<span style="min-width:200px;font-size:14px;font-weight:600">'+esc(lab[0])+'</span>'
   +'<select class=inp style="margin-top:0" data-slot="'+esc(sl)+'"><option value="">'+esc(t('models.unassigned'))+'</option>'
   +conns.map(c=>'<option value="'+esc(c.id)+'" '+(c.id===cur?'selected':'')+'>'+esc(c.provider+'/'+c.model+' · '+(c.costSource||'')+(c.health==='down'?' · DOWN':''))+'</option>').join('')+'</select></div>'
   +(lab[1]?'<div class=mut style="font-size:12px;margin:2px 0 0">'+esc(lab[1])+'</div>':'')+'</div>');
  row.querySelector('select').onchange=async(e)=>{const r=await api('/api/assign',{slot:sl,connectionId:e.target.value||null});if(r.error){alert(r.error);return}S.state=r;render()};
  a.appendChild(row)});
 MB.appendChild(a);
 const cHead=el('<div style="font-weight:650;font-size:13.5px;margin-top:14px">'+esc(t('models.connections'))+'</div>');
 MB.appendChild(cHead);
 const c=el('<div></div>');
 conns.forEach(cn=>{
  const dot=cn.health==='down'?'<span title="'+esc(t('models.down'))+'" style="color:var(--warn)">●</span> ':cn.health==='ok'?'<span style="color:var(--ok)">●</span> ':'';
  const row=el('<div style="display:flex;gap:10px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line)">'
   +dot+'<span style="font-size:13.5px">'+esc(cn.provider+'/'+cn.model)+'</span><span class=mut style="font-size:12px">'+esc(cn.costSource||'')+'</span>'
   +'<button class=ghost style="margin-left:auto;padding:4px 10px;font-size:12px">'+esc(t('models.remove'))+'</button></div>');
  row.querySelector('button').onclick=async()=>{const r=await api('/api/connection/remove',{id:cn.id});if(r.error){alert(r.error);return}S.state=r;render()};
  c.appendChild(row)});
 if(!conns.length)c.appendChild(el('<div class=mut style="font-size:13px">—</div>'));
 const fb=el('<div style="margin-top:10px"><button class=ghost id=cf>'+esc(t('onboard.useFree'))+'</button> <span class=mut id=cfm style="font-size:12px"></span></div>');
 fb.querySelector('#cf').onclick=async()=>{const fm=fb.querySelector('#cfm');fm.textContent=t('onboard.freeChecking');
  const r=await api('/api/connect-free');fm.textContent=r.error?r.error:('✓ '+r.picked.model+' (free)');if(!r.error){S.state=r;render()}};
 c.appendChild(fb);
 MB.appendChild(c);
 wrap.appendChild(MF.el);
 // Privacy posture — the one-line choice: full private (local models only) or more open (free cloud
 // models allowed where you assigned them). Fail-closed at routing, never a silent cloud call.
 const posture=(s.settings||{}).privacy||'open';
 const PV=fold(t('settings.privacy'),t('settings.privacy.'+posture));
 const pv=PV.body;
 pv.innerHTML='<div style="margin-top:10px"><div class=mut style="font-size:12.5px;margin-bottom:8px">'+esc(t('settings.privacyHint'))+'</div>'
  +'<div style="display:flex;gap:8px;flex-wrap:wrap">'
  +['open','private'].map(p=>'<button class="'+(posture===p?'act':'ghost')+'" data-pv="'+p+'" style="font-size:13px">'+esc(t('settings.privacy.'+p))+'</button>').join('')
  +'</div><div class=mut id=pvmsg style="font-size:12px;margin-top:6px">'+esc(t('settings.privacy.'+posture+'.desc'))+'</div></div>';
 pv.querySelectorAll('[data-pv]').forEach(b=>b.onclick=async()=>{
  const r=await api('/api/settings',{privacy:b.dataset.pv});if(r.error){alert(r.error);return}S.state=r;render()});
 wrap.appendChild(PV.el);
 return wrap;
}

// ── sources: the always-visible catalog of what the assistant CAN read ───────
// Connected or not, every kind is listed with what it unlocks — a user should never have to
// guess what could be connected to get more company insight out of the chatbot.
async function connectSource(kind){
 const T=((S.state||{}).workTwins||[])[0];
 if(!T){alert(t('sources.needTwin'));return}
 const src={kind,account:T.employee.email};
 if(kind==='imap'){const hp=prompt('IMAP host:port (mail.example.com:993)');if(!hp)return;const[h,p]=hp.split(':');
  src.host=h;src.port=Number(p||993);src.user=prompt('IMAP user (email)')||T.employee.email;src.account=src.user;
  src.password=prompt('IMAP password')||'';src.tls=(Number(p)||993)!==143}
 if(kind==='local-mail'){const d=prompt(t('work.mailPath'));if(!d)return;/mbox$/i.test(d)?src.mbox=d:src.dir=d;src.account=d}
 if(kind==='drive'){const d=prompt(t('work.drivePath'));if(!d)return;src.dir=d;src.account=d}
 if(kind==='nextcloud'){const u=prompt('Nextcloud WebDAV URL (https://cloud.example/remote.php/dav/files/you)');if(!u)return;
  src.baseUrl=u;src.user=prompt('Nextcloud user')||'';src.password=prompt('Nextcloud app password')||'';src.account=u}
 const r=await api('/api/worktwin/connect',{twinId:T.id,source:src});
 if(r.error){alert(r.error);return}
 await refresh();
}
async function disconnectSource(accountId){
 if(!confirm(t('sources.disconnectConfirm')))return;
 const T=((S.state||{}).workTwins||[])[0];
 const r=await api('/api/worktwin/disconnect',{twinId:T&&T.id,accountId});
 if(r.error){alert(r.error);return}
 S.state=r.state;await refresh();
}
async function deleteCustomApp(id){
 if(!confirm(t('sources.disconnectConfirm')))return;
 const r=await api('/api/connector/custom-delete',{id});
 if(r.error){alert(r.error);return}
 S.state=r.state;await refresh();
}
/** The guided Google panel: configure your own OAuth client → connect with Google → connected. */
function googlePanel(c,g){
 const d=el('<div style="margin-top:6px"></div>');
 if(g.connected){
  d.appendChild(el('<div style="font-size:12.5px"><span class=ok>✓ '+esc(t('sources.googleConnected'))+'</span> <span class=mut>'+esc((g.scopes||'').split(' ').map((x)=>x.split('/').pop()).join(', '))+'</span> '
   +'<button class=ghost style="padding:2px 9px;font-size:11.5px">'+esc(t('sources.disconnect'))+'</button></div>'));
  d.querySelector('button').onclick=async()=>{const r=await api('/api/oauth/google/disconnect',{});if(r.error){alert(r.error);return}S.state=r.state;await refresh()};
  return d;
 }
 if(!g.configured){
  // NOTE: el() keeps the FIRST root element only — always one wrapper div here.
  const f=el('<div><div style="font-size:12.5px" class=mut>'+esc(t('sources.googleHow'))+'</div>'
   +'<div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:6px"><input class=inp id=gcid placeholder="client id — ….apps.googleusercontent.com" style="margin-top:0;flex:2;min-width:220px">'
   +'<input class=inp id=gsec type="password" placeholder="'+esc(t('sources.appKey'))+'" style="margin-top:0;flex:1;min-width:160px">'
   +'<button class=ghost style="font-size:12.5px">'+esc(t('settings.save'))+'</button></div>'
   +'<div class=mut id=gmsg style="font-size:12px;margin-top:4px"></div></div>');
  f.querySelector('button').onclick=async()=>{
   const r=await api('/api/oauth/google/config',{clientId:f.querySelector('#gcid').value.trim(),clientSecret:f.querySelector('#gsec').value});
   f.querySelector('#gmsg').textContent=r.error||'✓';if(!r.error){S.state=r.state;await refresh()}};
  d.appendChild(f);
  return d;
 }
 const b=el('<a class=ghost href="/api/oauth/google/start" style="display:inline-block;font-size:12.5px;padding:5px 12px;text-decoration:none;border:1px solid var(--line);border-radius:10px">'+esc(t('sources.connectGoogle'))+'</a>');
 d.appendChild(b);
 return d;
}
function sourcesView(){
 const s=S.state||{};
 const T=(s.workTwins||[])[0];
 const catalog=s.sourceCatalog||[];
 const wrap=el('<div></div>');
 wrap.appendChild(el('<div class=mut style="font-size:12.5px;margin:2px 4px 10px">'+esc(t('sources.intro'))+'</div>'));
 if(!T){
  const d=el('<div class="cardx"><h3>'+esc(t('sources.firstStep'))+'</h3>'
   +'<div class=mut style="font-size:13px;margin-bottom:8px">'+esc(t('work.noTwin'))+'</div>'
   +'<div class=row style="display:flex;gap:8px"><input class=inp id=wn placeholder="'+esc(t('work.yourName'))+'" style="margin-top:0"><input class=inp id=we placeholder="you@company.com" style="margin-top:0"></div>'
   +'<div style="margin-top:8px"><button class=act>'+esc(t('work.createAlter'))+'</button> <span class=mut id=wmsg style="font-size:12px"></span></div></div>');
  d.querySelector('button').onclick=async()=>{
   const nm=d.querySelector('#wn').value.trim(),em=d.querySelector('#we').value.trim();
   if(!em){d.querySelector('#wmsg').textContent='email?';return}
   const r=await api('/api/worktwin/create',{employee:{id:em.split('@')[0],name:nm||em,email:em}});
   d.querySelector('#wmsg').textContent=r.error||'✓';if(!r.error){S.state=r.state;render()}};
  wrap.appendChild(d);
 }
 const groups=[['mail',t('sources.groupMail')],['files',t('sources.groupFiles')],['apps',t('sources.groupApps')]];
 for(const [g,label] of groups){
  const nConn=catalog.filter(c=>c.group===g).reduce((n,c)=>n+c.accounts.length,0);
  const F=fold(label,nConn?nConn+' '+t('sources.connected'):t('sources.notConnected'));
  const card=F.body;
  catalog.filter(c=>c.group===g).forEach(c=>{
   const row=el('<div style="padding:9px 0;border-bottom:1px solid var(--line)"></div>');
   const state=c.accounts.length
    ?'<span class="pill ok" style="font-size:11.5px">'+esc(t('sources.connected'))+'</span>'
    :'<span class="pill dormant" style="font-size:11.5px">'+esc(t('sources.notConnected'))+'</span>';
   row.appendChild(el('<div style="display:flex;gap:8px;align-items:center"><b style="font-size:14px">'+esc(t('sources.kind.'+c.kind))+'</b>'+state+'</div>'));
   row.appendChild(el('<div class=mut style="font-size:12.5px;margin-top:2px">'+esc(t('sources.benefit.'+c.kind))+'</div>'));
   c.accounts.forEach(a=>{
    const ar=el('<div style="display:flex;gap:8px;align-items:center;font-size:13px;margin-top:5px;padding:5px 8px;background:var(--card2);border-radius:8px">'
     +'<span>✓ '+esc(a.label||a.account)+'</span><span class=mut style="font-size:12px">'+esc((a.resources||[]).join(', '))+' · '+esc(a.scope||'read')+'</span>'
     +'<button class=ghost style="margin-left:auto;padding:3px 10px;font-size:12px">'+esc(t('sources.disconnect'))+'</button></div>');
    ar.querySelector('button').onclick=()=>c.kind==='custom-app'?deleteCustomApp(a.id):disconnectSource(a.id);
    row.appendChild(ar)});
   const bar=el('<div style="margin-top:7px"></div>');
   if(c.kind==='custom-app'){
    // The guided add-app flow: name → base URL → auth → sealed key → live probe. Never a prompt()
    // chain, never an unverified "connected".
    const b=el('<button class=ghost style="font-size:12.5px;padding:5px 12px">+ '+esc(t('sources.addCustomApp'))+'</button>');
    b.onclick=()=>{
     const f=el('<div style="margin-top:8px;padding:10px;border:1px solid var(--line);border-radius:10px">'
      +'<input class=inp id=an placeholder="'+esc(t('sources.appName'))+'" style="margin-top:0">'
      +'<input class=inp id=au placeholder="API base URL — https://api.example.com/v2">'
      +'<select class=inp id=aa><option value="api-key">API key</option><option value="oauth">OAuth</option><option value="none">'+esc(t('sources.noAuth'))+'</option></select>'
      +'<input class=inp id=ak type="password" placeholder="'+esc(t('sources.appKey'))+'">'
      +'<div style="margin-top:8px"><button class=act style="font-size:13px;padding:6px 14px">'+esc(t('sources.connect'))+'</button> <span class=mut id=amsg style="font-size:12px"></span></div>'
      +'<pre id=aguide class=mut style="font-size:12px;white-space:pre-wrap;display:none;margin-top:8px"></pre></div>');
     b.replaceWith(f);
     f.querySelector('button').onclick=async()=>{
      const msg=f.querySelector('#amsg');
      const name=f.querySelector('#an').value.trim(),baseUrl=f.querySelector('#au').value.trim();
      const auth=f.querySelector('#aa').value,secret=f.querySelector('#ak').value;
      if(!name){msg.textContent=t('sources.appName')+'?';return}
      msg.textContent='…';
      const c1=await api('/api/connector/custom',{name,baseUrl:baseUrl||null,auth});
      if(c1.error){msg.textContent=c1.error;return}
      const cid=c1.connector.id;
      let last=c1;
      if(baseUrl||secret){
       last=await api('/api/connector/configure',{id:cid,config:{baseUrl},secret:secret||undefined});
       if(last.error){msg.textContent=last.error;return}
      }
      const g=f.querySelector('#aguide');g.style.display='block';g.textContent=c1.guide;
      msg.textContent=last.probe?(last.probe.ok?'✓ '+last.probe.reason:'⚠ '+last.probe.reason):'✓';
      S.state=last.state;await refresh();
     };
    };
    bar.appendChild(b);
   }
   else if(c.verified){
    const b=el('<button class=ghost style="font-size:12.5px;padding:5px 12px">'+(c.accounts.length?'+ '+esc(t('sources.addAnother')):esc(t('sources.connect')))+'</button>');
    if(!T)b.disabled=true,b.style.opacity=.5;
    b.onclick=()=>connectSource(c.kind);
    bar.appendChild(b);
   }else if(c.needs&&c.needs.startsWith('oauth-')){
    // OAuth kinds: guided setup — own Google client (today) or a verified BrainOutput app (later).
    // The Google Drive row becomes connectable the moment Google is connected.
    const g=s.google||{};
    if(c.kind==='google-drive'&&g.connected){
     const b=el('<button class=ghost style="font-size:12.5px;padding:5px 12px">'+(c.accounts.length?'+ '+esc(t('sources.addAnother')):esc(t('sources.connect')))+'</button>');
     if(!T)b.disabled=true,b.style.opacity=.5;
     b.onclick=async()=>{const r=await api('/api/worktwin/connect',{twinId:T&&T.id,source:{kind:'google-drive',provider:'google-drive',account:'google'}});if(r.error)alert(r.error);await refresh()};
     bar.appendChild(b);
    }else{
     bar.appendChild(googlePanel(c,g));
    }
   }else{
    bar.appendChild(el('<span class=mut style="font-size:12px">'+esc(c.needs==='odoo-wiring'?t('sources.needsWiring'):t('sources.needsOAuth'))+'</span>'));
   }
   row.appendChild(bar);
   card.appendChild(row)});
  wrap.appendChild(F.el);
 }
 if(T){
  const sync=el('<div class="cardx"><div style="display:flex;gap:8px;align-items:center;font-size:13px">'
   +'<span class=mut>'+esc(T.name)+' · '+(T.indexSize||0)+' '+esc(t('work.indexed'))+'</span>'
   +'<button class=ghost id=sync style="margin-left:auto">'+esc(t('work.sync'))+'</button><span class=mut id=smsg style="font-size:12px"></span></div></div>');
  sync.querySelector('#sync').onclick=async()=>{const m=sync.querySelector('#smsg');m.textContent='…';
   const r=await api('/api/worktwin/sync',{twinId:T.id,limit:50});m.textContent=r.error?r.error:('✓ '+r.indexed);await refresh()};
  wrap.appendChild(sync);
 }
 // This computer — the local bridge. Pair a device with a short code; its LOCAL models become
 // assignable connections and its GRANTED folders can be indexed. Outbound-only, revocable.
 const nodes=s.localNodes||[];
 const nOn=nodes.filter(n=>n.online).length;
 const CF=fold(t('sources.computer'),nodes.length?nOn+'/'+nodes.length+' '+t('sources.online'):null);
 const cc=CF.body;
 cc.appendChild(el('<div class=mut style="font-size:12.5px;margin-bottom:8px;margin-top:10px">'+esc(t('sources.computerHint'))+'</div>'));
 const pb=el('<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap"><button class=ghost style="font-size:12.5px">'+esc(t('sources.pairDevice'))+'</button>'
  +'<span id=pcode style="font-size:15px;font-weight:700;letter-spacing:.08em"></span><span class=mut id=phelp style="font-size:12px"></span></div>');
 pb.querySelector('button').onclick=async()=>{
  const r=await api('/api/local/pair-code',{});
  pb.querySelector('#pcode').textContent=r.code;
  pb.querySelector('#phelp').textContent='→ bo-community connect --url '+location.origin+' --code '+r.code+' [--allow /folder]';
 };
 cc.appendChild(pb);
 nodes.forEach(n=>{
  const row=el('<div style="margin-top:8px;padding:9px 10px;border:1px solid var(--line);border-radius:10px"></div>');
  row.appendChild(el('<div style="display:flex;gap:8px;align-items:center;font-size:13.5px">'
   +'<span style="color:'+(n.online?'var(--ok)':'var(--mut)')+'">●</span><b>'+esc(n.name)+'</b>'
   +'<span class=mut style="font-size:12px">'+(n.online?esc(t('sources.online')):esc(t('sources.offline')))+'</span>'
   +'<button class=ghost style="margin-left:auto;padding:3px 10px;font-size:12px">'+esc(t('sources.revoke'))+'</button></div>'));
  row.querySelector('button').onclick=async()=>{const r=await api('/api/local/revoke',{nodeId:n.id});if(r.error){alert(r.error);return}S.state=r.state;await refresh()};
  if((n.models||[]).length){
   const ml=el('<div style="margin-top:6px;font-size:12.5px" class=mut>'+esc(t('sources.models'))+': </div>');
   n.models.forEach(m=>{
    const b=el('<button class=ghost style="font-size:12px;padding:3px 9px;margin:2px 4px 2px 0">+ '+esc(m)+'</button>');
    b.title=t('sources.addModelHint');
    b.onclick=async()=>{const r=await api('/api/local/add-model',{nodeId:n.id,model:m});if(r.error){alert(r.error);return}S.state=r.state;await refresh()};
    ml.appendChild(b)});
   row.appendChild(ml);
  }
  if((n.grants||[]).length){
   const gl=el('<div style="margin-top:4px;font-size:12.5px" class=mut>'+esc(t('sources.folders'))+': </div>');
   n.grants.forEach(g=>{
    const b=el('<button class=ghost style="font-size:12px;padding:3px 9px;margin:2px 4px 2px 0">'+esc(g)+' — '+esc(t('sources.indexFolder'))+'</button>');
    b.onclick=async()=>{const r=await api('/api/local/index-folder',{nodeId:n.id,root:g,twinId:T&&T.id});if(r.error){alert(r.error);return}S.state=r.state;await refresh()};
    gl.appendChild(b)});
   row.appendChild(gl);
  }
  cc.appendChild(row)});
 wrap.appendChild(CF.el);
 return wrap;
}

// ── work: the intranet — planner + your sources (mail/drives) + one search over all of it ──
function workView(){
 const s=S.state||{};
 const wrap=el('<div></div>');
 // Planner: every project's open work in one place.
 const pl=el('<div class="cardx"><h3>'+esc(t('work.planner'))+'</h3></div>');
 const projs=(s.projects||[]);
 if(!projs.length)pl.appendChild(el('<div class=mut style="font-size:13px">'+esc(t('shell.emptyProjects'))+'</div>'));
 projs.forEach(p=>{
  const tasks=(s.tasks||[]).filter(x=>x.projectId===p.id);
  const tops=tasks.filter(x=>!x.parentId);
  const flat=tops.flatMap(x=>[x,...tasks.filter(y=>y.parentId===x.id)]);
  const doneN=flat.filter(x=>x.status==='done'&&!tasks.some(y=>y.parentId===x.id&&y.status!=='done')).length;
  const pct=flat.length?Math.round(doneN/flat.length*100):0;
  const row=el('<div style="padding:6px 0;border-bottom:1px solid var(--line)"><div style="display:flex;gap:8px;align-items:center;font-size:13.5px"><b>'+esc(p.name)+'</b><span class=mut style="font-size:12px">'+doneN+'/'+flat.length+'</span></div>'
   +'<div style="background:var(--pre);border-radius:8px;height:5px;overflow:hidden;margin:5px 0"><div style="background:var(--ok);height:100%;width:'+pct+'%"></div></div>'
   +tops.filter(tk=>tk.status!=='done').slice(0,4).map(tk=>'<div style="font-size:12.5px;padding:2px 0" class="'+(tk.status==='blocked'?'warn':'mut')+'">○ '+esc(tk.title)+'</div>').join('')+'</div>');
  row.querySelector('b').style.cursor='pointer';
  row.querySelector('b').onclick=()=>{S.view='chat';S.projectId=p.id;S.convId=null;render()};
  pl.appendChild(row)});
 wrap.appendChild(pl);

 // Sources live in their own menu now (the catalog shows what COULD be connected, not just what
 // is). Work keeps a one-line summary that routes there.
 const T=(s.workTwins||[])[0];
 const cat=s.sourceCatalog||[];
 const connectedN=cat.reduce((n,c)=>n+c.accounts.length,0);
 const sc=el('<div class="cardx"><h3>'+esc(t('work.sources'))+'</h3></div>');
 const sum=el('<div style="display:flex;gap:8px;align-items:center;font-size:13.5px">'
  +(T?'<span>'+esc(T.name)+' · <b>'+connectedN+'</b> '+esc(t('sources.connectedCount'))+' · '+(T.indexSize||0)+' '+esc(t('work.indexed'))+'</span>'
    :'<span class=mut>'+esc(t('work.noTwin'))+'</span>')
  +'<button class=ghost style="margin-left:auto">'+esc(t('sources.manage'))+' →</button></div>');
 sum.querySelector('button').onclick=()=>{S.view='settings';render()};
 sc.appendChild(sum);
 wrap.appendChild(sc);

 // Routines: scheduled work (regulation watch, daily digest) — the company moves on its own.
 const ro=el('<div class="cardx"><h3>'+esc(t('work.routines'))+'</h3></div>');
 (s.routines||[]).forEach(r=>{
  const row=el('<div style="display:flex;gap:8px;align-items:center;padding:5px 0;border-bottom:1px solid var(--line);font-size:13px">'
   +'<span>'+(r.enabled?'●':'○')+' '+esc(r.name)+'</span>'
   +'<span class=mut style="font-size:12px">'+esc(t('work.nextRun'))+': '+(r.nextRunAt?new Date(r.nextRunAt).toLocaleString():'—')+'</span>'
   +'<button class=ghost style="margin-left:auto;padding:3px 10px;font-size:12px" data-t>'+(r.enabled?'⏸':'▶')+'</button>'
   +'<button class=ghost style="padding:3px 10px;font-size:12px" data-r>'+esc(t('work.runNow'))+'</button></div>');
  row.querySelector('[data-t]').onclick=async()=>{await api('/api/routine/toggle',{id:r.id});await refresh()};
  row.querySelector('[data-r]').onclick=async()=>{await api('/api/routine/run-now',{id:r.id});setTimeout(refresh,2500)};
  ro.appendChild(row)});
 const has=k=>(s.routines||[]).some(r=>r.kind===k);
 const adds=el('<div style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">'
  +(has('regulation-watch')?'':'<button class=ghost data-add="regulation-watch">+ '+esc(t('work.addRegulation'))+'</button>')
  +(has('daily-digest')?'':'<button class=ghost data-add="daily-digest">+ '+esc(t('work.addDigest'))+'</button>')
  +(has('self-diagnostic')?'':'<button class=ghost data-add="self-diagnostic">+ '+esc(t('work.addDiagnostic'))+'</button>')+'</div>');
 adds.querySelectorAll('[data-add]').forEach(b=>b.onclick=async()=>{const r=await api('/api/routine/add',{kind:b.dataset.add});if(r.error){alert(r.error);return}await refresh()});
 ro.appendChild(adds);
 wrap.appendChild(ro);

 // Diagnostics: live view of the error log — one line per repeating bug pattern.
 const pats=s.errorPatterns||[];
 if(pats.length){
  const dg=el('<div class="cardx"><h3>'+esc(t('work.diagnostics'))+'</h3></div>');
  pats.forEach(p=>dg.appendChild(el('<div style="font-size:13px;padding:3px 0"><b>'+p.count+'×</b> <span class=mut>'+esc(p.key)+'</span></div>')));
  wrap.appendChild(dg);
 }

 // One search over mail + documents.
 if(T){
  const se=el('<div class="cardx"><h3>'+esc(t('work.search'))+'</h3>'
   +'<div style="display:flex;gap:8px"><input class=inp id=q placeholder="'+esc(t('work.searchPlaceholder'))+'" style="margin-top:0"><button class=ghost id=go>→</button></div>'
   +'<div id=sr style="margin-top:8px"></div></div>');
  const run=async()=>{
   const q=se.querySelector('#q').value.trim();if(!q)return;
   const out=se.querySelector('#sr');out.innerHTML='<span class=mut>…</span>';
   const [m,f]=await Promise.all([
    api('/api/worktwin/action',{twinId:T.id,action:'search-mail',query:q,k:5}),
    api('/api/worktwin/action',{twinId:T.id,action:'search-files',query:q,k:5})]);
   const hits=[...(m.hits||[]),...(f.hits||[])];
   out.innerHTML=hits.length?hits.map(x=>'<div style="font-size:13px;padding:5px 0;border-bottom:1px solid var(--line)"><b>'+esc(x.subject||x.citation||'')+'</b> <span class=mut>'+esc(x.from||'')+'</span><div class=mut style="font-size:12px">'+esc(String(x.snippet||'').replace(/\s+/g,' ').slice(0,140))+'</div></div>').join(''):'<span class=mut>—</span>'};
  se.querySelector('#go').onclick=run;
  se.querySelector('#q').onkeydown=(e)=>{if(e.key==='Enter')run()};
  wrap.appendChild(se);
 }
 return wrap;
}

// ── tour: first use + on new versions — what the product IS (Alter, projects, work) ──────
const TOUR_V=1;
function tourSeen(){try{return Number(localStorage.getItem('bo_tour_v'))>=TOUR_V}catch{return true}}
function tourCard(){
 const step=S.tourStep||0;
 const keys=['tour.1','tour.2','tour.3','tour.4','tour.5'];
 const d=el('<div class="cardx" style="border-color:var(--acc)"><h3>'+esc(t('tour.title'))+' · '+(step+1)+'/'+keys.length+'</h3>'
  +'<div style="font-size:14px;white-space:pre-wrap">'+esc(t(keys[step]))+'</div>'
  +'<div style="margin-top:12px"><button class=act id="tn">'+(step<keys.length-1?esc(t('tour.next')):esc(t('tour.done')))+'</button> '
  +'<button class=ghost id="ts">'+esc(t('tour.skip'))+'</button></div></div>');
 const finish=()=>{try{localStorage.setItem('bo_tour_v',String(TOUR_V))}catch{} S.tourStep=null;render()};
 d.querySelector('#tn').onclick=()=>{if(step<keys.length-1){S.tourStep=step+1;render()}else finish()};
 d.querySelector('#ts').onclick=finish;
 return d;
}

// ── thread ───────────────────────────────────────────────────────────────────
function bubble(m){
 const arts=(m.meta&&m.meta.artifacts)||[];
 const names=arts.map(id=>{const a=((S.state||{}).artifacts||[]).find(x=>x.id===id);return a?a.name:id});
 const d=el('<div class="msg '+(m.role==='user'?'user':'bot')+'"><div class=who>'+(m.role==='user'?esc(t('shell.you')):esc(t('shell.brain')))+'</div>'
  +'<div class=body>'+esc(m.text)+(names.length?'<br>'+names.map(n=>'<span class=attach>📎 '+esc(n)+'</span>').join(' '):'')+'</div>'
  +(m.meta&&(m.meta.model||m.meta.citations&&m.meta.citations.length)?'<div class=meta>'+esc([m.meta.provider&&m.meta.model?(m.meta.provider+'/'+m.meta.model):null,m.meta.costSource,m.meta.citations&&m.meta.citations.length?(t('shell.sources')+': '+m.meta.citations.join(' · ')):null].filter(Boolean).join(' · '))+'</div>':'')
  +'</div>');
 return d;
}
function thread(){
 const s=S.state||{};const box=document.getElementById('msgs');box.innerHTML='';
 if(S.view==='settings'){box.appendChild(settingsView());return}
 if(S.view==='work'){box.appendChild(workView());return}
 if(!tourSeen())box.appendChild(tourCard());
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
 // Live work keeps the view fresh WITHOUT blocking the user: poll while anything runs.
 if((s.executions||[]).some(e=>e.status==='running')){
  clearTimeout(S._poll);S._poll=setTimeout(refresh,3000);
 }
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
 if(ob.does)box.appendChild(obSay(t('onboard.websiteQ')));
 if(ob.website)box.appendChild(obUser(ob.website));
 if(ob.step==='name'||ob.step==='does'||ob.step==='website')return;   // waiting for a typed answer (composer)
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
  const r=await api('/api/onboard',{companyName:ob.name,companyDoes:ob.does,website:ob.website||undefined,departments});
  if(r.error){d.querySelector('#obmsg').textContent=r.error;return}
  S.ob=null;saveOb();await refresh()};
 box.appendChild(d);
}
/** A typed answer during onboarding: name → does → website(optional) → (models card). */
async function obAnswer(txt){
 const ob=S.ob;
 if(ob.step==='name'){ob.name=txt;ob.step='does';saveOb();render();return}
 if(ob.step==='does'){ob.does=txt;ob.step='website';saveOb();render();return}
 if(ob.step==='website'){
  const v=txt.trim();
  ob.website=/^(no|non|nein|skip|pass|na)$/i.test(v)?null:(v.includes('://')?v:'https://'+v);
  ob.step='models';ob.models=null;saveOb();render();
  const r=await api('/api/detect');if(S.ob===ob&&ob.step==='models'){ob.models=r.detected||[];saveOb();render()}return}
}

// A thinking indicator the user cannot miss: pulsing send button + animated bubble in the thread.
function thinking(on){
 const send=document.getElementById('send');
 send.disabled=!!on;send.classList.toggle('busy',!!on);
 document.getElementById('busy').textContent=on?t('shell.thinking'):'';
 const old=document.getElementById('bo-think');if(old)old.remove();
 if(on){const d=el('<div class="msg bot" id="bo-think"><div class=who>'+esc(t('shell.brain'))+'</div><div class=think><span></span><span></span><span></span></div></div>');
  document.getElementById('msgs').appendChild(d);
  const th=document.getElementById('thread');th.scrollTop=th.scrollHeight}
}

// ── composer + render ────────────────────────────────────────────────────────
function composer(){
 const s=S.state||{};
 const md=document.getElementById('modes');md.innerHTML='';
 ['ask','plan','execute','review'].forEach(m=>{const b=el('<button'+(S.mode===m?' class=on':'')+' title="'+esc(t('mode.tip.'+m))+'">'+esc(t('mode.'+m))+'</button>');
  b.onclick=()=>{S.mode=m;composer()};md.appendChild(b)});
 md.style.display=onboarded(s)?'flex':'none';
 const msg=document.getElementById('msg');msg.placeholder=t('composer.'+S.mode)||t('shell.composer');
 const grow=()=>{msg.style.height='auto';msg.style.height=Math.min(msg.scrollHeight,200)+'px'};
 msg.oninput=grow;
 msg.onkeydown=(e)=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();document.getElementById('send').click()}};
 // Attachments: upload the file first, reference it in the message.
 const at=document.getElementById('attach');at.title=t('upload.attach');
 // Voice input: the browser's own speech recognition (no server, no key) — honest about support.
 const mic=document.getElementById('mic');
 const SR=window.SpeechRecognition||window.webkitSpeechRecognition;
 if(!SR){mic.disabled=true;mic.title=t('voice.unsupported');mic.style.opacity=.4}
 else{
  mic.title=t('voice.talk');
  let rec=null;
  mic.onclick=()=>{
   if(rec){rec.stop();return}
   rec=new SR();
   rec.lang={en:'en-US',fr:'fr-FR',de:'de-DE'}[LOCALE]||'en-US';
   rec.interimResults=true;rec.continuous=false;
   rec.onresult=(e)=>{const final=[...e.results].filter(r=>r.isFinal).map(r=>r[0].transcript).join(' ');
    if(final){const msg=document.getElementById('msg');msg.value=(msg.value+' '+final).trim();msg.dispatchEvent(new Event('input'))}};
   rec.onend=()=>{rec=null;mic.classList.remove('busy');document.getElementById('busy').textContent=''};
   rec.onerror=()=>{rec=null;mic.classList.remove('busy');document.getElementById('busy').textContent=t('voice.unsupported')};
   mic.classList.add('busy');document.getElementById('busy').textContent=t('voice.listening');
   rec.start();
  };
 }
 const showAtts=()=>{document.getElementById('atts').innerHTML=(S.pendingAtts||[]).map(a=>'<span class=attach>📎 '+esc(a.name)+'</span>').join(' ')};
 at.onclick=()=>document.getElementById('file').click();
 document.getElementById('file').onchange=async(e)=>{
  const f=e.target.files[0];if(!f)return;
  if(f.size>2*1024*1024){alert('2 MB max');return}
  const b64=await new Promise((res)=>{const r=new FileReader();r.onload=()=>res(String(r.result).split(',')[1]);r.readAsDataURL(f)});
  const r=await api('/api/upload',{name:f.name,contentBase64:b64,mime:f.type,projectId:S.projectId});
  if(r.error){alert(r.error);return}
  S.pendingAtts=[...(S.pendingAtts||[]),r.artifact];showAtts();
  e.target.value='';};
 showAtts();
 const send=document.getElementById('send');send.title=t('shell.send');
 send.onclick=async()=>{
  const txt=msg.value.trim();if(!txt&&!(S.pendingAtts||[]).length)return;
  if(!onboarded(S.state||{})){msg.value='';grow();await obAnswer(txt);return}
  thinking(true);
  const r=await api('/api/chat/send',{conversationId:S.convId,scope:S.scope,department:S.dept||null,agentId:S.agent||null,mode:S.mode,text:txt,projectId:S.projectId,artifacts:(S.pendingAtts||[]).map(a=>a.id)});
  thinking(false);
  if(r.error){alert(r.error);return}
  S.pendingAtts=[];S.convId=r.conversation.id;msg.value='';grow();await refresh()};
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

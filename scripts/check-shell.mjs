import http from 'node:http';
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
// Run after build:frontend. All remotes and native calls below are test fixtures.
const root=fileURLToPath(new URL('../dist', import.meta.url));
const profile=await fs.mkdtemp(path.join(os.tmpdir(),'canvas-desktop-ui-'));
const output=process.env.SCREENSHOT_OUT || os.tmpdir();
await fs.mkdir(output,{recursive:true});
let loginCalls=0;const apiPorts=[];const documentQueries=[];
const server=http.createServer(async(req,res)=>{
 try {
 const url=new URL(req.url,'http://localhost');const p=url.pathname;
 res.setHeader('Access-Control-Allow-Origin',req.headers.origin || 'http://127.0.0.1:1430');res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers'] || '*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 if(p==='/__fixture'){let body='';for await(const chunk of req)body+=chunk;console.error('FIXTURE REPORT',body);res.end('ok');return;}
 if(p.startsWith('/rest/v2')){apiPorts.push(req.socket.localPort);
 let body='';for await(const chunk of req)body+=chunk;
 const payload=body?JSON.parse(body):{};let value=[];
 if(p.endsWith('/auth/config'))value={allowUserRegistrations:true,strategies:{local:{enabled:true},imap:{enabled:false,domains:[]}}};
 else if(p.endsWith('/auth/login')){loginCalls++;if(payload.password!=='correct-password'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'error',message:'Invalid credentials',statusCode:401}));return;}value={token:'canvas-test-token',user:{id:'test',email:'admin@canvas.local',userType:'admin'}};}
 else if(p.endsWith('/auth/me'))value={id:'test',email:'admin@canvas.local',userType:'admin',status:'active'};
 else if(p==='/rest/v2/workspaces')value=[{id:'ws-id',name:'universe',label:'Universe',status:'available',owner:'test',type:'workspace'},{id:'personal',name:'personal',label:'Personal',status:'available'}];
 else if(/^\/rest\/v2\/workspaces\/[^/]+$/.test(p))value={id:'ws-id',name:'universe',label:'Universe',status:'active',owner:'test',type:'workspace',metadata:{}};
 else if(p.endsWith('/status'))value={status:'active'};
 else if(/\/tree$/.test(p))value={id:'/',name:'/',label:'/',type:'universe',children:[]};
 else if(p.endsWith('/trees'))value=[{name:'context',type:'context',label:'Contexts'},{name:'projects',type:'directory',label:'Projects'}];
 else if(p.endsWith('/paths'))value=['/work','/work/customer-foo','/work/customer-foo/ops','/work/customer-foo/ops/snow-12345','/work/customer-foo/ops/snow-12346','/work/customer-bar','/personal','/research'];
 else if(p.endsWith('/documents')){documentQueries.push(Object.fromEntries(url.searchParams));value=[
 {id:1,schema:'data/schema/note',data:{title:'Incident field notes',text:'Latency started climbing just after the morning deploy. Keep the timeline, observations, and next steps together here.'}},
 {id:2,schema:'data/schema/message/email',data:{subject:'RE: Elevated API latency',from:'Elena · Customer Foo',bodyText:'Thanks for the quick response. The operations team has shared the traces from the affected region.'}},
 {id:3,schema:'data/schema/file',data:{filename:'api-response-times.csv',description:'Response times across the last 24 hours. Exported from the production monitoring workspace.'}},
 {id:4,schema:'data/schema/message',data:{title:'#ops · Incident coordination',text:'Marek: The rollback is complete. Error rates are back to normal; watching the tail latency now.'}},
 {id:5,schema:'data/schema/note',data:{title:'A working theory',text:'Connection pooling looks like the likely culprit. Compare the deployment diff against the last healthy release.'}},
 {id:6,schema:'data/schema/tab',data:{title:'Production observability',description:'The live dashboard, logs, and traces for this incident.',url:'https://example.com/observability'}}
 ];const schema=url.searchParams.get('allOf');if(schema)value=value.filter(doc=>doc.schema.startsWith(schema));if(url.searchParams.get('q'))value=value.filter(doc=>JSON.stringify(doc).toLowerCase().includes(url.searchParams.get('q').toLowerCase()));}
 else if(p==='/rest/v2/agents')value=[{id:'research',name:'Research assistant'}];
 else if(p==='/rest/v2/contexts')value=[];
 else if(p.endsWith('/config'))value={};
 else if(p.endsWith('/ping'))value={version:'test',status:'ok'};
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'success',payload:value}));return;
 }
 const file=p==='/'||!p.includes('.')?'/index.html':p;
 const content=await fs.readFile(root+file);res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(content);
 }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(r=>server.listen(1430,'127.0.0.1',r));
const apiServer=http.createServer((req,res)=>server.emit('request',req,res));await new Promise(r=>apiServer.listen(1431,'127.0.0.1',r));
if(process.argv.includes('--native')) {
 // Never inherit the host's Wayland display or HiDPI overrides into Xvfb.
 const env={...process.env,GDK_BACKEND:'x11',GDK_SCALE:'1',GDK_DPI_SCALE:'1',CANVAS_USER_HOME:path.join(profile,'native-home'),CANVAS_DESKTOP_SMOKE_PROFILE:path.join(profile,'webview'),CANVAS_DESKTOP_SMOKE_URL:'http://127.0.0.1:1430',CANVAS_DESKTOP_SMOKE_WM:process.argv.includes('--window-manager')?'1':'0'};
 if(process.argv.includes('--composited')){env.WEBKIT_DISABLE_COMPOSITING_MODE='0';env.WEBKIT_DISABLE_DMABUF_RENDERER='1';}
 const binary=fileURLToPath(new URL('../src-tauri/target/debug/examples/desktop-smoke',import.meta.url));
 const launch = async (phase, expected) => {
  const phaseResult = path.join(profile, `native-${phase}.json`);
  const command = env.CANVAS_DESKTOP_SMOKE_WM === '1' ? ['sh','-c','xfwm4 --compositor=off >/dev/null 2>&1 & wm=$!; "$1"; result=$?; kill "$wm" 2>/dev/null; exit "$result"','native-fixture',binary] : [binary];
  const native=spawn('dbus-run-session',['--','xvfb-run','-a','-s','-screen 0 1920x1080x24',...command],{env:{...env,CANVAS_DESKTOP_SMOKE_RESULT:phaseResult,CANVAS_DESKTOP_SMOKE_EXPECTED:JSON.stringify(expected || null)},detached:true,stdio:['ignore','pipe','pipe']});
  let logs='';native.stdout.on('data',data=>logs+=data);native.stderr.on('data',data=>logs+=data);
  const closed = new Promise(resolve => native.once('close', resolve));
  try {
   let report;
   for(let i=0;i<600;i++){try{report=JSON.parse(await fs.readFile(phaseResult,'utf8'));break;}catch{}if(native.exitCode!==null)throw new Error(`Native process exited ${native.exitCode}: ${logs}`);await new Promise(r=>setTimeout(r,100));}
   assert.ok(report,`Native result timed out: ${logs}`);assert.equal(report.ok,true,JSON.stringify(report));
   let timeout;
   try { assert.equal(await Promise.race([closed,new Promise((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Native exit timed out: '+logs)),10000);})]),0,logs); }
   finally { clearTimeout(timeout); }
   return report;
  } finally {if(native.exitCode===null)try{process.kill(-native.pid,'SIGTERM');}catch{}}
 };
 try {
  const first = await launch('save');
  const geometry=JSON.parse(await fs.readFile(path.join(env.CANVAS_USER_HOME,'config/desktop-windows.json'),'utf8'));
  assert.equal(geometry.version,1);assert.ok(Object.keys(geometry.windows).length>=2);
  const {id,...rect}=first.expected[0];
  assert.deepEqual(geometry.windows[id].rect,rect,'The final move must be flushed on exit');
  const restored = await launch('restore',{windows:first.expected,maximized:first.maximized});
  assert.equal(restored.restarted,true);
  console.log('PASS: native windows, tabs, exact canvas/menu/toolbox bounds, context and panel restoration, quit flush and process restart.');
  console.log(JSON.stringify({first,restored}));
 } catch(error){console.error(error);process.exitCode=1;} finally {server.close();apiServer.close();}
 process.exit(process.exitCode||0);
}
const pageErrors=[];
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000','about:blank']);
try{
const wsUrl=await new Promise((resolve,reject)=>{let buf='';chrome.stderr.on('data',c=>{buf+=c;const m=buf.match(/ws:\/\/[^\s]+/);if(m)resolve(m[0]);});chrome.on('exit',code=>reject(new Error('Chrome '+code)));});
const ws=new WebSocket(wsUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let next=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const cmd=(m,p)=>send(m,p,sessionId);
await cmd('Page.enable');await cmd('Runtime.enable');
// Page exceptions and console errors explain a failed step better than a missing selector.
ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.method==='Runtime.exceptionThrown')pageErrors.push(m.params.exceptionDetails.exception?.description||m.params.exceptionDetails.text);if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')pageErrors.push(m.params.args.map(a=>a.value||a.description||'').join(' '));});
await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('canvas.desktop.connection',JSON.stringify({url:'http://127.0.0.1:1431'}));window.nativeCalls=[];window.__TAURI_INTERNALS__={invoke:async(cmd)=>{window.nativeCalls.push(cmd);if(cmd==='load_remotes')return {};if(cmd==='activate_tls')return null;throw new Error('Unexpected native operation '+cmd);}};`});
await cmd('Page.navigate',{url:'http://127.0.0.1:1430/'});
const evaluate=async expression=>{const {result,exceptionDetails}=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(exceptionDetails)throw new Error(JSON.stringify(exceptionDetails));return result.value;};
const waitFor=async expression=>{for(let i=0;i<80;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText'));};
await waitFor(`document.querySelector('input[type="email"]') && document.querySelector('input[type="password"]')`);
const fill=async(selector,value)=>evaluate(`(()=>{const input=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(value)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`);
await fill('input[type="email"]','admin@canvas.local');await fill('input[type="password"]','wrong-password');
await evaluate(`document.querySelector('input[type="password"]').closest('form').requestSubmit()`);
await waitFor(`document.body.innerText.includes('Invalid credentials') || document.body.innerText.includes('Invalid email')`);
await fill('input[type="password"]','correct-password');
await evaluate(`document.querySelector('input[type="password"]').closest('form').requestSubmit()`);
await waitFor(`location.pathname!=='/login' && !document.querySelector('input[type="password"]') && localStorage.getItem('authToken')==='canvas-test-token'`);
assert.equal(loginCalls,2);assert.ok(apiPorts.length>0 && apiPorts.every(port=>port===1431), JSON.stringify(apiPorts));
assert.equal(await evaluate(`localStorage.getItem('authToken')`),'canvas-test-token');
assert.deepEqual(await evaluate('window.nativeCalls'),['load_remotes','activate_tls']);
await waitFor(`document.querySelector('[aria-label="Virtual directory tree"]') && document.querySelector('.cw-window')`);
const click=async selector=>evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
await click('.mm-tree-path[title="/work/customer-foo/ops/snow-12345"]');
await waitFor(`document.querySelector('.cw-location').textContent.includes('snow-12345') && document.querySelector('.cw-web') && !document.body.innerText.includes('Workspace unavailable')`);
await click('[aria-label="Open toolbox"]');
await waitFor(`document.querySelector('[aria-label="Toolbox"]')`);
await evaluate(`Array.from(document.querySelectorAll('.tb-kind-grid button')).find(b=>b.textContent.includes('Notes')).click()`);
await waitFor(`document.querySelectorAll('.cw-window').length===2 && document.querySelectorAll('.cw-document').length===2`);
assert.ok(documentQueries.some(q=>q.context==='/work/customer-foo/ops/snow-12345' && q.treeNameOrTreeId==='context' && q.allOf==='data/schema/note'));
await click('.tb-label input[type="checkbox"]');
await evaluate(`Array.from(document.querySelectorAll('.tb-kind-grid button')).find(b=>b.textContent.includes('Email')).click()`);
await waitFor(`document.querySelectorAll('.cw-tab').length===3 && document.querySelector('[aria-label="Email canvas"]')`);
await click('.mm-tree-path[title="/work/customer-foo/ops/snow-12346"]');
await waitFor(`document.querySelectorAll('.cw-window').length===1`);
await click('.mm-tree-path[title="/work/customer-foo/ops/snow-12345"]');
await waitFor(`document.querySelectorAll('.cw-window').length===2 && document.querySelectorAll('.cw-tab').length===3`);
await cmd('Page.reload');
await waitFor(`document.querySelectorAll('.cw-window').length===2 && document.querySelectorAll('.cw-tab').length===3`);
// Detach and close a tab, including the last tab in its own window.
await click('[aria-label="Move tab to its own window"]');
await waitFor(`document.querySelectorAll('.cw-window').length===3`);
await click('[aria-label="Close Emails tab"]');
await waitFor(`document.querySelectorAll('.cw-window').length===2`);
await click('[aria-label="Close Notes tab"]');
await waitFor(`document.querySelectorAll('.cw-window').length===1`);
// Search filters a schema canvas; the fixture answers `q` with a substring match.
await evaluate(`Array.from(document.querySelectorAll('.tb-kind-grid button')).find(b=>b.textContent.includes('Messages')).click()`);
await waitFor(`document.querySelectorAll('.cw-window').length===2 && document.querySelectorAll('.cw-document').length===2`);
await fill('input[aria-label="Search this canvas"]','rollback');
await waitFor(`document.querySelectorAll('.cw-document').length===1`);
await fill('input[aria-label="Search this canvas"]','');
await waitFor(`document.querySelectorAll('.cw-document').length===2`);
await click('[aria-label="Close Messages tab"]');
await waitFor(`document.querySelectorAll('.cw-window').length===1`);
// Immediate controls do not need network or native IPC. Observe a paint after
// the click; this is browser scheduling, not a native end-to-end latency claim.
const timings=[];
for(let i=0;i<8;i++)timings.push(await evaluate(`new Promise(resolve=>{const start=performance.now();document.querySelector('.tb-launcher').click();requestAnimationFrame(()=>resolve(performance.now()-start));})`));
const jsResources=await evaluate(`performance.getEntriesByType('resource').filter(r=>r.name.endsWith('.js')).map(r=>r.name.split('/').pop())`);
assert.ok(!jsResources.some(name=>name.startsWith('WebApp-')),JSON.stringify(jsResources));
await evaluate(`window.__CANVAS_DESKTOP_UI__.dispatch({type:'show-toolbox',mode:'context'})`);
await new Promise(r=>setTimeout(r,180));
let shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-foundation.png'),Buffer.from(shot.data,'base64'));
await click('[aria-label="Desktop settings"]');
await evaluate(`(()=>{const select=document.querySelector('[aria-label="Desktop preferences"] select');const setter=Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set;setter.call(select,'top');select.dispatchEvent(new Event('change',{bubbles:true}));})()`);
await click('[aria-label="Close preferences"]');
await waitFor(`document.querySelector('.mm-top')`);
shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-top-menu.png'),Buffer.from(shot.data,'base64'));
// A narrow viewport keeps the menu and toolbox operable.
await cmd('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:false});
await evaluate(`window.__CANVAS_DESKTOP_UI__.dispatch({type:'show-toolbox',mode:'global'})`);
await waitFor(`document.querySelector('.tb-clock')`);
shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-toolbox-mobile.png'),Buffer.from(shot.data,'base64'));
await cmd('Emulation.clearDeviceMetricsOverride');
// The full shared web UI remains available and has the same scoped session.
await cmd('Page.navigate',{url:'http://127.0.0.1:1430/workspaces'});
await waitFor(`document.body.innerText.includes('Universe') && document.querySelector('.desktop-return')`);
assert.equal(await evaluate('localStorage.getItem("authToken")'),'canvas-test-token');
console.log('PASS: desktop login, web UI canvas page, contextual queries, tabs, detach, per-path restoration, reload, search, layout settings, narrow toolbox and shared web handoff.');
console.log('Toolbox click → next animation frame (browser only), ms:', timings.map(t=>t.toFixed(1)).join(', '));
console.log('Initial desktop JS:', jsResources.join(', '));
ws.close();
}catch(error){console.error(error);if(pageErrors.length)console.error('PAGE ERRORS:\n'+pageErrors.slice(-12).join('\n---\n'));process.exitCode=1;}finally{chrome.kill();server.close();apiServer.close();}

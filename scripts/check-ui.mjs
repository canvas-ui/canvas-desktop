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
const layout={version:1,canvases:[{id:'mail',kind:'emails',title:'Emails',width:1,height:360},{id:'notes',kind:'notes',title:'Notes',width:1,height:360},{id:'browser',kind:'browser',title:'Task browser',width:1,height:360,url:'https://example.com'}]};
const layers={'/':{},'/ops/jira-1001':{ui:{desktop:structuredClone(layout)},custom:'keep'},'/ops/jira-1002':{}};
const ctx={id:'dc-migration',name:'DC migration',url:'work://ops/jira-1001',workspaceName:'work',treeId:'context',metadata:{ui:{desktop:structuredClone(layout)},toolbox:{filters:['notes']}}};
const server=http.createServer(async(req,res)=>{
 try {
 const url=new URL(req.url,'http://localhost');const p=url.pathname;
 if(p.startsWith('/rest/v2')){
 let body='';for await(const chunk of req)body+=chunk;
 const payload=body?JSON.parse(body):{};let value;
 if(p.endsWith('/documents'))value=[{id:1,schema:'data/schema/note',data:{title:`Task ${ctx.url.endsWith('1002') || url.searchParams.get('context')?.endsWith('1002') ? '1002' : '1001'} document`}}];
 else if(p==='/rest/v2/workspaces')value=[{name:'work'}];
 else if(p==='/rest/v2/contexts')value=[ctx];
 else if(p.endsWith('/trees'))value=[{name:'context',type:'context'}];
 else if(p.endsWith('/paths'))value=Object.keys(layers);
 else if(p.includes('/path/')){const path=decodeURIComponent(p.split('/path')[1]);if(req.method==='PATCH')layers[path]=payload.metadata;value={metadata:layers[path]};}
 else if(p.endsWith('/dc-migration/url')){ctx.url=payload.url;value={url:ctx.url};}
 else if(p.endsWith('/dc-migration')){if(req.method==='PUT')ctx.metadata=payload.metadata;value=ctx;}
 else {res.writeHead(404);res.end();return;}
 res.setHeader('Content-Type','application/json');res.end(JSON.stringify({status:'success',payload:value}));return;
 }
 const file=p==='/'?'/index.html':p;
 const content=await fs.readFile(root+file);res.setHeader('Content-Type',file.endsWith('.js')?'application/javascript':file.endsWith('.css')?'text/css':'text/html');res.end(content);
 }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(r=>server.listen(1430,'127.0.0.1',r));
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000','about:blank']);
try{
const wsUrl=await new Promise((resolve,reject)=>{let buf='';chrome.stderr.on('data',c=>{buf+=c;const m=buf.match(/ws:\/\/[^\s]+/);if(m)resolve(m[0]);});chrome.on('exit',code=>reject(new Error('Chrome '+code)));});
const ws=new WebSocket(wsUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let next=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const cmd=(m,p)=>send(m,p,sessionId);
await cmd('Page.enable');await cmd('Runtime.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`window.__TAURI_INTERNALS__={invoke:async(cmd)=>{if(cmd==='load_setup')return {config:{version:1,workspaceRoot:'/tmp/workspaces',mounts:[]},remotes:{'admin@dev':{url:'http://127.0.0.1:1430',auth:{token:'canvas-test'}}}};return {};}};`});
await cmd('Page.navigate',{url:'http://127.0.0.1:1430/'});
const evaluate=async expression=>{const {result,exceptionDetails}=await cmd('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(exceptionDetails)throw new Error(JSON.stringify(exceptionDetails));return result.value;};
const waitFor=async expression=>{for(let i=0;i<80;i++){if(await evaluate(`Boolean(${expression})`))return;await new Promise(r=>setTimeout(r,100));}throw new Error('Timed out: '+expression+'\n'+await evaluate('document.body.innerText'));};
await waitFor(`document.querySelector('[aria-label="Tree paths"]')?.innerText.includes('jira-1001') && document.querySelector('.desktop-canvas')`);
await evaluate(`[...document.querySelectorAll('[aria-label="Tree paths"] button')].find(b=>b.textContent==='/ops/jira-1001').click()`);
await waitFor(`document.querySelectorAll('.desktop-canvas').length===3`);
let shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-explorer.png'),Buffer.from(shot.data,'base64'));
await evaluate(`[...document.querySelectorAll('[aria-label="Tree paths"] button')].find(b=>b.textContent==='/ops/jira-1002').click()`);
await waitFor(`document.querySelectorAll('.desktop-canvas').length===1 && document.querySelector('.desktop-canvas strong').textContent==='Content'`);
await evaluate(`document.querySelector('[aria-label="Remove Content"]').click()`);
await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Save arrangement').click()`);
await waitFor(`!document.body.innerText.includes('Unsaved arrangement')`);
assert.equal(layers['/ops/jira-1002'].ui.desktop.canvases.length,0);
await evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent==='Contexts').click()`);
await waitFor(`document.querySelectorAll('.desktop-canvas').length===3 && document.querySelector('[aria-label="Context tree paths"]')?.innerText.includes('jira-1002')`);
await evaluate(`[...document.querySelectorAll('[aria-label="Context tree paths"] button')].find(b=>b.textContent==='/ops/jira-1002').click()`);
await waitFor(`document.querySelector('[aria-label="Context POV"]').value==='work://ops/jira-1002' && document.body.innerText.includes('Task 1002 document')`);
assert.equal(await evaluate(`document.querySelectorAll('.desktop-canvas').length`),3);
assert.deepEqual(ctx.metadata.toolbox,{filters:['notes']});
shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-context.png'),Buffer.from(shot.data,'base64'));
console.log('PASS: Explorer layout switching/default/empty save; context tree POV rebinding with layout and filters preserved.');
await cmd('Emulation.setDeviceMetricsOverride',{width:700,height:900,deviceScaleFactor:1,mobile:false});
shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-narrow.png'),Buffer.from(shot.data,'base64'));
ws.close();
}finally{chrome.kill();server.close();}

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
let loginCalls=0;const apiPorts=[];
const server=http.createServer(async(req,res)=>{
 try {
 const url=new URL(req.url,'http://localhost');const p=url.pathname;
 res.setHeader('Access-Control-Allow-Origin',req.headers.origin || 'http://127.0.0.1:1430');res.setHeader('Access-Control-Allow-Credentials','true');res.setHeader('Access-Control-Allow-Headers',req.headers['access-control-request-headers'] || '*');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
 if(p.startsWith('/rest/v2')){apiPorts.push(req.socket.localPort);
 let body='';for await(const chunk of req)body+=chunk;
 const payload=body?JSON.parse(body):{};let value=[];
 if(p.endsWith('/auth/config'))value={allowUserRegistrations:true,strategies:{local:{enabled:true},imap:{enabled:false,domains:[]}}};
 else if(p.endsWith('/auth/login')){loginCalls++;if(payload.password!=='correct-password'){res.writeHead(401,{'Content-Type':'application/json'});res.end(JSON.stringify({status:'error',message:'Invalid credentials',statusCode:401}));return;}value={token:'canvas-test-token',user:{id:'test',email:'admin@canvas.local',userType:'admin'}};}
 else if(p.endsWith('/auth/me'))value={id:'test',email:'admin@canvas.local',userType:'admin',status:'active'};
 else if(p==='/rest/v2/workspaces')value=[{id:'ws-id',name:'work',label:'Work',status:'available',owner:'test',type:'workspace'}];
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
const chrome=spawn('/usr/bin/google-chrome',['--headless=new','--disable-gpu','--no-sandbox','--remote-debugging-port=0',`--user-data-dir=${profile}`,'--window-size=1440,1000','about:blank']);
try{
const wsUrl=await new Promise((resolve,reject)=>{let buf='';chrome.stderr.on('data',c=>{buf+=c;const m=buf.match(/ws:\/\/[^\s]+/);if(m)resolve(m[0]);});chrome.on('exit',code=>reject(new Error('Chrome '+code)));});
const ws=new WebSocket(wsUrl);await new Promise(r=>ws.addEventListener('open',r,{once:true}));
let next=0;const pending=new Map();ws.addEventListener('message',e=>{const m=JSON.parse(e.data);if(m.id){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(m.error):p.resolve(m.result);}});
const send=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const id=++next;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});
const {targetId}=await send('Target.createTarget',{url:'about:blank'});const {sessionId}=await send('Target.attachToTarget',{targetId,flatten:true});
const cmd=(m,p)=>send(m,p,sessionId);
await cmd('Page.enable');await cmd('Runtime.enable');
await cmd('Page.addScriptToEvaluateOnNewDocument',{source:`localStorage.setItem('canvas.desktop.connection',JSON.stringify({url:'http://127.0.0.1:1431'}));window.nativeCalls=[];window.__TAURI_INTERNALS__={invoke:async(cmd)=>{window.nativeCalls.push(cmd);if(cmd==='load_remotes')return {};throw new Error('Unexpected native operation '+cmd);}};`});
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
assert.deepEqual(await evaluate('window.nativeCalls'),['load_remotes']);

await evaluate(`history.pushState({},'', '/workspaces');window.dispatchEvent(new PopStateEvent('popstate'))`);
await waitFor(`location.pathname==='/workspaces' && document.body.innerText.includes('Work')`);
await cmd('Page.reload');
await waitFor(`location.pathname==='/workspaces' && document.body.innerText.includes('Work') && !!document.querySelector('.desktop-server-switch')`);
assert.equal(await evaluate('localStorage.getItem("authToken")'),'canvas-test-token');
let shot=await cmd('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(output,'canvas-desktop-webui.png'),Buffer.from(shot.data,'base64'));
console.log('PASS: shared web login rejects invalid credentials, authenticates, navigates workspaces and survives reload; no native service calls.');
ws.close();
}finally{chrome.kill();server.close();apiServer.close();}

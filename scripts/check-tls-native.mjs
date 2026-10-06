#!/usr/bin/env node
// Requires sibling canvas-common, nginx/OpenSSL, and the tls-smoke example binary.
import { certificates, nginxFixture } from '../../canvas-common/packages/api-client/tests/support/fixture.js';
import { spawn, execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { mkdirSync, rmSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const dir=certificates();const fixture=await nginxFixture(dir);
let child;let output='';let windowsRoot;
try {
    const env={...process.env,CANVAS_TLS_URL:fixture.url,CANVAS_TLS_FIXTURE:dir,CANVAS_USER_HOME:join(dir,'desktop-home'),WEBKIT_DISABLE_COMPOSITING_MODE:'1',WEBKIT_DISABLE_DMABUF_RENDERER:'1'};
    mkdirSync(env.CANVAS_USER_HOME,{recursive:true});
    if(process.platform==='win32') {
        // Ephemeral CI user only. Never run this test in a real user's certificate stores.
        assert.equal(process.env.CI,'true','Windows TLS smoke tests require an ephemeral CI account');
        const thumb=execFileSync('powershell.exe',['-NoProfile','-Command',`$c=Import-Certificate -FilePath $env:CANVAS_TLS_TEST_ROOT -CertStoreLocation Cert:\\CurrentUser\\Root;$c.Thumbprint`],{env:{...env,CANVAS_TLS_TEST_ROOT:join(dir,'root.crt')},encoding:'utf8'}).trim();
        windowsRoot=thumb;
    }
    const suffix=process.platform==='win32'?'.exe':'';
    const binary=resolve('src-tauri/target/debug/examples/tls-smoke'+suffix);
    child=process.platform==='linux' ? spawn('dbus-run-session',['--','xvfb-run','-a',binary],{env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']}) : spawn(binary,[],{env,detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});
    child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d);child.on('error',e=>output+=e);
    let result;
    for(let i=0;i<300;i++) {
        const report=fixture.requests.find(r=>r.url==='/native-result');
        if(report) {result=JSON.parse(report.body);break;}
        if(child.exitCode!==null)throw new Error(`Native webview exited: ${output}`);
        await new Promise(r=>setTimeout(r,100));
    }
    assert.ok(result,`No native TLS result: ${output}\n${readFileSync(join(dir,'nginx.log'),'utf8')}`);
    assert.equal(result.ok,true,JSON.stringify(result));
    assert.ok(fixture.requests.some(r=>r.url==='/xhr'));
    assert.ok(fixture.requests.some(r=>r.url==='/upload'&&r.body.length===131072));
    assert.ok(!fixture.requests.some(r=>r.url==='/no-identity'),'Unconfigured origin reached nginx upstream');
    console.log('Native TLS passed: navigation, fetch, XHR, upload, Canvas token, Socket.IO ack, unconfigured origin refusal');
} finally {
    if(child && child.exitCode===null) {if(process.platform==='win32')child.kill();else process.kill(-child.pid,'SIGTERM');await new Promise(r=>{child.once('exit',r);setTimeout(r,2000).unref();});}
    if(process.platform==='win32') {
        // Remove only test identities/imports created in the isolated test home.
        try {const imports=JSON.parse(readFileSync(join(dir,'desktop-home/config/desktop-tls-imports.json'),'utf8'));for(const entry of Object.values(imports))for(const thumb of entry.owned||[])execFileSync('powershell.exe',['-NoProfile','-Command',`$p='Cert:\\CurrentUser\\My\\'+$env:CANVAS_TLS_TEST_THUMB; if(Test-Path $p){$c=Get-Item $p;if($c.HasPrivateKey){Remove-Item $p -DeleteKey}else{Remove-Item $p}}`],{env:{...process.env,CANVAS_TLS_TEST_THUMB:thumb},stdio:'pipe'});}catch(e){console.error('Test identity cleanup failed:',e.message);process.exitCode=1;}
        if(windowsRoot)execFileSync('powershell.exe',['-NoProfile','-Command',`Remove-Item ('Cert:\\CurrentUser\\Root\\'+$env:CANVAS_TLS_TEST_THUMB)`],{env:{...process.env,CANVAS_TLS_TEST_THUMB:windowsRoot},stdio:'pipe'});
    }
    await fixture.close();rmSync(dir,{recursive:true,force:true});
}

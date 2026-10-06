import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { useEffect, useState } from 'react';
import type { ClientTls } from './backend';
type NativeStatus = { persistentImports: boolean; identities: Record<string, { owned: string[] }> };
export function TlsFields({ tls, onChange, allowImport, onImportChange }: {
  tls?: ClientTls; onChange: (tls?: ClientTls) => void; allowImport: boolean; onImportChange: (value: boolean) => void;
}) {
  const [native, setNative] = useState<NativeStatus>();
  const [error, setError] = useState('');
  const refresh = () => invoke<NativeStatus>('native_tls_status').then(setNative);
  useEffect(() => { void refresh().catch(() => {}); }, []);
  function update(value: ClientTls) { onChange(value.certFile || value.keyFile ? value : undefined); }
  async function choose(field: keyof ClientTls) {
    try {
      const file = await open({ multiple: false, directory: false, title: field === 'certFile' ? 'Client certificate chain (PEM)' : 'Unencrypted client private key (PEM)' });
      if (typeof file === 'string') onChange({ certFile: tls?.certFile || '', keyFile: tls?.keyFile || '', [field]: file });
    } catch (e) { setError(String(e)); }
  }
  return <fieldset className="desktop-tls"><legend>Client certificate (optional)</legend>
    <label>Certificate chain<input value={tls?.certFile || ''} onChange={e => update({ certFile: e.target.value, keyFile: tls?.keyFile || '' })} /><button type="button" onClick={() => void choose('certFile')}>Browse</button></label>
    <label>Private key<input value={tls?.keyFile || ''} onChange={e => update({ certFile: tls?.certFile || '', keyFile: e.target.value })} /><button type="button" onClick={() => void choose('keyFile')}>Browse</button></label>
    {tls && <button type="button" onClick={() => onChange(undefined)}>Clear certificate settings</button>}
    <p>Use a PEM certificate chain and a protected, unencrypted private key. Reconnect Desktop and restart mounts after replacing these files.</p>
    {native?.persistentImports && <>
      <label><input type="checkbox" checked={allowImport} onChange={e => onImportChange(e.target.checked)} />Allow importing this identity into my Windows certificate store</label>
      <p>Windows keeps imported identities until removed. An existing matching identity can be used without importing.</p>
      {Object.entries(native.identities || {}).map(([fingerprint, entry]) => <div key={fingerprint}><small>{fingerprint} · {entry.owned?.length ? 'Imported by Canvas' : 'Existing identity'}</small>
        <button type="button" onClick={() => { void invoke('remove_native_identity', { fingerprint }).then(refresh).catch(e => setError(String(e))); }}>Remove Canvas import</button>
      </div>)}
    </>}
    {error && <p role="alert">{error}</p>}
  </fieldset>;
}

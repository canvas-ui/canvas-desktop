import { useMemo } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import App from '@web/App';
import { getCurrentUser } from '@web/services/auth';
import { TerminalTransportContext } from '@web/components/terminal/terminal-transport';
import { createTerminalTransport } from './terminal';
import '../web-host.css';
export default function WebApp() {
  const transport = useMemo(() => {
    if (!isTauri()) return null;
    let token: string | null = null, identity: Promise<string> | undefined;
    return createTerminalTransport(() => {
      const current = localStorage.getItem('authToken');
      if (!identity || current !== token) {
        token = current;
        identity = getCurrentUser().then(user => {
          if (!user) throw new Error('Sign in to open terminal sessions');
          return JSON.stringify([window.__CANVAS_DESKTOP__!.apiUrl.replace(/\/rest\/v2$/, ''), user.id]);
        }).catch(error => { identity = undefined; throw error; });
      }
      return identity;
    });
  }, []);
  return <TerminalTransportContext.Provider value={transport}><App /></TerminalTransportContext.Provider>;
}

/// <reference types="vite/client" />

interface Window { __CANVAS_DESKTOP__?: { apiUrl: string; serverOrigin: string } }
interface Window { __CANVAS_DESKTOP_UI__?: { version: 1; snapshot: () => import('./shell/model').DesktopState; dispatch: (action: import('./shell/automation').DesktopAction) => void } }

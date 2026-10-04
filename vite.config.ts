import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { cpSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const web = fileURLToPath(new URL('../canvas-web/', import.meta.url)).replace(/[\\/]$/, '');
const pkg = JSON.parse(readFileSync(`${web}/package.json`, 'utf8'));
export default defineConfig({
  plugins: [{ name: 'desktop-platform', enforce: 'pre', transform(code, id) {
    const source = id.replace(/\\/g, '/');
    if (!source.startsWith(web.replace(/\\/g, '/') + '/src/')) return;
    if (source.endsWith('/config/api.ts')) {
      if (!code.includes('function getApiUrl() {')) throw new Error('Web API configuration changed: update the desktop adapter.');
      code = code.replace('function getApiUrl() {', 'function getApiUrl() { if (window.__CANVAS_DESKTOP__?.apiUrl) return window.__CANVAS_DESKTOP__.apiUrl;');
    }
    code = code.replace(/window\.location\.origin\b/g, '(window.__CANVAS_DESKTOP__?.serverOrigin || window.location.origin)');
    if (source.endsWith('/services/agent.ts')) {
      code = code.replace(/window\.location\.protocol\b/g, 'new URL(window.__CANVAS_DESKTOP__?.serverOrigin || window.location.origin).protocol')
        .replace(/window\.location\.host\b/g, 'new URL(window.__CANVAS_DESKTOP__?.serverOrigin || window.location.origin).host');
    }
    return code;
  } }, react(), tailwindcss(), { name: 'web-assets', closeBundle() {
    cpSync(`${web}/node_modules/@excalidraw/excalidraw/dist/prod/fonts`, 'dist/excalidraw/fonts', { recursive: true });
  } }],
  publicDir: `${web}/public`,
  define: { __APP_VERSION__: JSON.stringify(pkg.version) },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: 'virtual:pwa-register', replacement: fileURLToPath(new URL('./src/pwa-disabled.ts', import.meta.url)) },
      { find: '@web', replacement: `${web}/src` },
      { find: '@', replacement: `${web}/src` },
    ],
  },
  server: { port: 1420, strictPort: true, host: process.env.TAURI_DEV_HOST || false, fs: { allow: ['..'] }, watch: { ignored: ['**/src-tauri/**'] } },
  clearScreen: false,
});

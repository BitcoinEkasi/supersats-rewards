import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

// Remove `crossorigin` from script/link tags — Firefox rejects CORS-mode modules
// when the server sends Cross-Origin-Resource-Policy: same-origin (Helmet default).
const removeCrossorigin: Plugin = {
  name: 'remove-crossorigin',
  transformIndexHtml(html) {
    return html.replace(/ crossorigin/g, '');
  },
};

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react(), removeCrossorigin],
  build: {
    outDir: path.resolve(__dirname, '../../dist/public'),
    emptyOutDir: true,
  },
  server: {
    port: 3000,
    proxy: {
      '/api': 'http://localhost:3001',
      '/lnurlw': 'http://localhost:3001',
      '/lnurlp': 'http://localhost:3001',
      '/.well-known': 'http://localhost:3001',
    },
  },
})

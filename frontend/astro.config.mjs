// @ts-check
import { defineConfig } from 'astro/config';

import react from '@astrojs/react';
import tailwindcss from '@tailwindcss/vite';
import node from '@astrojs/node';
import { realtimeIntegration } from './src/lib/server/realtime-integration';

const WS_PORT = parseInt(process.env.WS_PORT || '1239', 10);

// https://astro.build/config
export default defineConfig({
  output: 'server',
  adapter: node({
    mode: 'standalone'
  }),
  integrations: [
    react(),
    realtimeIntegration(),
  ],

  vite: {
    plugins: [tailwindcss()],
    server: {
      // In dev, proxy /ws to the PowSync WebSocket server
      proxy: {
        '/ws': {
          target: `ws://localhost:${WS_PORT}`,
          ws: true,
          changeOrigin: true,
        },
      },
    },
    optimizeDeps: {
      // ws is a Node.js module — exclude from Vite's dep optimizer
      exclude: ['ws'],
    },
  }
});

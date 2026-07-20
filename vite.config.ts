import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';
import packageJson from './package.json';

export default defineConfig({
  base: '/motion_recorder/',

  define: {
    __APP_VERSION__: JSON.stringify(packageJson.version)
  },

  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/icon-192.png', 'icons/icon-512.png'],

      manifest: {
        name: 'Motion Cam',
        short_name: 'Motion Cam',
        description: 'Creative motion camera with local processing.',
        theme_color: '#000000',
        background_color: '#000000',
        display: 'standalone',
        orientation: 'any',

        start_url: '/motion_recorder/',
        scope: '/motion_recorder/',

        icons: [
          {
            src: 'icons/icon-192.png',
            sizes: '192x192',
            type: 'image/png'
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png'
          },
          {
            src: 'icons/icon-512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      },

      workbox: {
        globPatterns: ['**/*.{js,css,html,png,svg,wasm}']
      }
    })
  ]
});

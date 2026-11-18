import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Khi dev, /api được chuyển tới gateway của docker compose (cổng 4000), gateway chia về từng service.
// Khi deploy, frontend và API cùng nằm sau một CloudFront nên /api là cùng domain.
export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js dùng biến global của Node
  define: { global: 'globalThis' },
  server: {
    port: 5173,
    proxy: {
      '/api': process.env.API_URL || 'http://localhost:4000',
    },
  },
  build: {
    sourcemap: false,
  },
});

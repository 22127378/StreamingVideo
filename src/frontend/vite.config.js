import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Khi dev, /api được chuyển tới API chạy trên máy (npm run dev trong src/api).
// Khi deploy, frontend và API cùng nằm sau một CloudFront nên /api là cùng domain.
export default defineConfig({
  plugins: [react()],
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

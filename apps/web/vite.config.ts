import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Bind to the LAN so the dev server is reachable from other devices (e.g. phone).
  server: { host: true },
})

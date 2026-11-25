import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
// ws:true also forwards the team-chat WebSocket (/api/team-chat) to the backend.
export default defineConfig({plugins:[react()],server:{port:5173,proxy:{'/api':{target:'http://127.0.0.1:8080',changeOrigin:true,ws:true}}}});

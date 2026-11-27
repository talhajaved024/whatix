import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';

// Content-Security-Policy for the built app (production only: the dev server
// injects inline scripts). Scripts and connections stay on this site; images
// and media may also come from https (WhatsApp profile photos, media links)
// and from blob:/data: (local previews, voice notes). frame-ancestors cannot
// be set from a <meta> tag: the web server adds it (deploy/reference/Caddyfile).
export const contentSecurityPolicy=["default-src 'self'","script-src 'self'","style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https:","media-src 'self' data: blob: https:","font-src 'self' data:",
  "connect-src 'self' wss:","frame-src 'self'","worker-src 'self' blob:","object-src 'none'","base-uri 'none'","form-action 'self'"].join('; ');
const securityPolicy={name:'whatix-security-policy',apply:'build',
  transformIndexHtml:html=>html.replace('<meta charset="UTF-8" />','<meta charset="UTF-8" />\n    <meta http-equiv="Content-Security-Policy" content="'+contentSecurityPolicy+'" />\n    <meta name="referrer" content="no-referrer" />')};

// ws:true also forwards the team-chat WebSocket (/api/team-chat) to the backend.
export default defineConfig({plugins:[react(),securityPolicy],server:{port:5173,proxy:{'/api':{target:'http://127.0.0.1:8080',changeOrigin:true,ws:true}}}});

import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(process.cwd(), 'index.html'),
        privacy: path.resolve(process.cwd(), 'privacy.html')
      }
    }
  },
  plugins: [
    {
      name: 'vercel-api-dev-middleware',
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (req.url === '/privacy' || req.url === '/privacy/') {
            req.url = '/privacy.html';
            return next();
          }

          if (!req.url || !req.url.startsWith('/api/')) {
            return next();
          }

          const [pathname, queryString] = req.url.split('?');
          const query = Object.fromEntries(new URLSearchParams(queryString || '').entries());

          // Map /api/xyz to ./api/xyz.js
          const relativePath = pathname.replace(/^\/api\//, '');
          const filePath = path.resolve(process.cwd(), 'api', `${relativePath}.js`);

          if (!fs.existsSync(filePath)) {
            return next();
          }

          try {
            // Collect request body for POST/PUT/PATCH/DELETE
            let body = {};
            if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method || '')) {
              const chunks = [];
              for await (const chunk of req) {
                chunks.push(chunk);
              }
              const rawBody = Buffer.concat(chunks).toString('utf-8');
              if (rawBody.trim()) {
                try {
                  body = JSON.parse(rawBody);
                } catch {
                  body = rawBody;
                }
              }
            }

            // Decorate req and res to match Vercel Serverless Function signature
            req.query = query;
            req.body = body;

            res.status = (code) => {
              res.statusCode = code;
              return res;
            };

            res.json = (data) => {
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify(data));
              return res;
            };

            const mod = await server.ssrLoadModule(filePath);
            const handler = mod.default || mod;
            if (typeof handler === 'function') {
              await handler(req, res);
            } else {
              res.status(500).json({ error: 'Handler is not a function' });
            }
          } catch (err) {
            console.error('[API Middleware Error]:', err?.message || err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json');
              res.end(JSON.stringify({ error: err?.message || 'Server error' }));
            }
          }
        });
      }
    }
  ]
});

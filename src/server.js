import express from 'express';
import { createServer as createViteServer } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

async function createServer() {
    const app = express();

    const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'custom',
    });

    app.use(vite.middlewares);

    app.use(express.static(path.resolve("dist")));

    app.get('/', async (_req, res) => {
        try {
            const {render} = await vite.ssrLoadModule('/src/entry-server.ts')
            const appHtml = render();

            const manifest = JSON.parse(fs.readFileSync('./dist/.vite/manifest.json', 'utf-8'));

            const mainScript = manifest['src/entry-client.ts'];

            const mainPath = mainScript.file;
            const stylePaths = mainScript.css;

            const html = `
            <!DOCTYPE html>
            <html lang="en">
              <head>
                <meta charset="UTF-8" />
                <link rel="icon" type="image/svg+xml" href="/vite.svg" />
                <meta name="viewport" content="width=device-width, initial-scale=1.0" />
                <title>SSR + Hydrate Signals</title>
                ${stylePaths.map(path => `<link rel="stylesheet" href="${path}">`).join('\n')}
              </head>
              <body>
                <div id="app">${appHtml}</div>
                <script async src="${mainPath}"></script>
              </body>
            </html>`;

            res.status(200).set({ 'Content-Type': 'text/html' }).end(html);
        } catch (e) {
            vite.ssrFixStacktrace(e);
            console.error(e);
            res.status(500).end(e.message);
        }
    });

    app.listen(5173, () => {
        console.log('🚀 SSR server running at http://localhost:5173');
    });
}

createServer();

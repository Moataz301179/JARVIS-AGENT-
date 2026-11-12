import { mkdir, readFile, writeFile } from 'node:fs/promises';

const [html, css, js] = await Promise.all([
  readFile('index.html', 'utf8'),
  readFile('style.css', 'utf8'),
  readFile('script.js', 'utf8')
]);
const page = html
  .replace('<link rel="stylesheet" href="./style.css" />', `<style>${css}</style>`)
  .replace('<script src="./script.js"></script>', `<script>${js}</script>`);

const worker = `const page = ${JSON.stringify(page)};
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/__health') {
      return Response.json({ status: 'ok', service: 'jarvis-operations-center', scope: 'dashboard-only' });
    }
    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=UTF-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'same-origin'
      }
    });
  }
};\n`;

await mkdir('dist/server', { recursive: true });
await writeFile('dist/server/index.js', worker);

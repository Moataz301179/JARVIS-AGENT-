import { access } from 'node:fs/promises';

for (const file of ['server/index.js', 'index.html', 'script.js', 'style.css']) {
  await access(file);
}
console.log('Jarvis server source validated. Run with npm start or install as a systemd service.');

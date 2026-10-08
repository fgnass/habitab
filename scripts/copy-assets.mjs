// Copies non-TypeScript UI assets into dist/.
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
for (const f of fs.readdirSync(path.join(root, 'src/ui'))) {
  if (/\.(html|css|svg|js)$/.test(f)) {
    fs.mkdirSync(path.join(root, 'dist/ui'), { recursive: true });
    fs.copyFileSync(path.join(root, 'src/ui', f), path.join(root, 'dist/ui', f));
  }
}
// The start screen shows the app icon.
fs.copyFileSync(path.join(root, 'build/icon.png'), path.join(root, 'dist/ui/icon.png'));

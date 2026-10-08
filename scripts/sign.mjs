// Ad-hoc signs the built app bundle (release/mac or release/mac-arm64).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const release = path.resolve(import.meta.dirname, '..', 'release');
const app = fs.readdirSync(release).map(d => path.join(release, d, 'Habitab.app')).find(p => fs.existsSync(p));
if (!app) throw new Error('release/*/Habitab.app not found');
execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
console.log(`signed ${app}`);

// Compiles the speech recognition helper (macOS only, needs the Xcode command
// line tools). Without them the app runs without dictation and the Web
// Speech API stays as Electron has it.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const src = path.join(root, 'src/speech/speech-helper.swift');
const out = path.join(root, 'dist/app/speech-helper');
if (process.platform !== 'darwin') process.exit(0);
if (fs.existsSync(out) && fs.statSync(out).mtimeMs >= fs.statSync(src).mtimeMs) process.exit(0);
const swiftc = spawnSync('xcrun', ['-f', 'swiftc'], { encoding: 'utf8' });
if (swiftc.status !== 0) { console.warn('speech helper: swiftc not found (xcode-select --install); dictation is off'); process.exit(0); }
const sdk = execFileSync('xcrun', ['--sdk', 'macosx', '--show-sdk-path'], { encoding: 'utf8' }).trim();
fs.mkdirSync(path.dirname(out), { recursive: true });
execFileSync(swiftc.stdout.trim(), ['-O', '-sdk', sdk, '-target', `${process.arch === 'arm64' ? 'arm64' : 'x86_64'}-apple-macos13.0`, '-framework', 'Speech', '-framework', 'AVFoundation', '-o', out, src], { stdio: 'inherit' });
console.log(`built ${path.relative(root, out)}`);

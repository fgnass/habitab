// Codex: $CODEX_HOME/config.toml, profile files $CODEX_HOME/<name>.config.toml
// and .codex/config.toml of trusted projects. Plugin servers are reported only.
// Files that Habitab changed earlier (manifest) are always checked for its
// wrapper, so uninstall also finds projects that are no longer trusted.
// `codex mcp add` replaces the whole entry and drops tools.* approvals, so
// Habitab edits only the command and args values in place.
import fs from 'node:fs';
import path from 'node:path';
import { codexHome } from '../shared/session-info';
import { isServerToken, wrapper } from '../shared/server-command';
import { classify, Finding, findingId, manifest, ManifestEntry } from './model';
import { applyEdits, Pair, stringArrayOf, stringOf, TextEdit, TomlScanner } from './toml';

interface Located { name: string; command: Pair; args?: Pair; }

function locate(s: TomlScanner): { entries: Located[]; unsupported: string[] } {
  const commands = new Map<string, Pair>(), args = new Map<string, Pair>();
  const unsupported = new Set<string>();
  for (const p of s.pairs) {
    if (p.path.length < 2 || p.path[0] !== 'mcp_servers') continue;
    const name = p.path[1];
    const standard = p.table.length === 2 && p.table[0] === 'mcp_servers' && p.table[1] === name && p.keyCount === 1;
    const mentions = s.text(p.lineStart, p.lineEnd).includes('chrome-devtools-mcp');
    if (p.path.length === 2) { if (mentions) unsupported.add(name); continue; }
    if (p.path.length !== 3) continue;
    if (p.path[2] === 'command') {
      if (standard) commands.set(name, p);
      else if (mentions || [stringOf(p.value)].some(v => v && (isServerToken(v) || wrapper.isLauncher(v)))) unsupported.add(name);
    } else if (p.path[2] === 'args') {
      if (standard) args.set(name, p);
      else if (mentions) unsupported.add(name);
    }
  }
  const entries = [...commands.keys()].sort().map(name => ({ name, command: commands.get(name)!, args: args.get(name) }));
  return { entries, unsupported: [...unsupported].filter(n => !commands.has(n)).sort() };
}

interface ConfigFile { scope: string; file: string; project?: string; /** Only from the manifest. */ recorded?: boolean; }

/** Projects the user trusts in Codex (`[projects."<dir>"] trust_level = "trusted"`). */
export function codexTrustedProjects(): string[] {
  try {
    const s = new TomlScanner(fs.readFileSync(path.join(codexHome(), 'config.toml'), 'utf8'));
    return s.pairs
      .filter(p => p.path.length === 3 && p.path[0] === 'projects' && p.path[2] === 'trust_level' && stringOf(p.value) === 'trusted')
      .map(p => p.path[1]);
  } catch { return []; }
}

function configFiles(): ConfigFile[] {
  const home = codexHome();
  const user = path.join(home, 'config.toml');
  const files: ConfigFile[] = [{ scope: 'user', file: user }];
  try {
    for (const f of fs.readdirSync(home).sort()) if (f.endsWith('.config.toml')) files.push({ scope: 'profile', file: path.join(home, f) });
  } catch {}
  for (const project of codexTrustedProjects()) {
    const file = path.join(project, '.codex', 'config.toml');
    if (fs.existsSync(file)) files.push({ scope: 'project', file, project });
  }
  for (const m of manifest.load()) {
    if (m.client === 'codex' && fs.existsSync(m.file)) files.push({ scope: m.scope, file: m.file, project: m.project, recorded: true });
  }
  // A trusted project can be the parent of CODEX_HOME (e.g. ~); keep each file once.
  const seen = new Set<string>();
  return files.filter(f => {
    let real = f.file;
    try { real = fs.realpathSync(f.file); } catch {}
    if (seen.has(real)) return false;
    seen.add(real);
    return true;
  });
}

export function scanCodex(): Finding[] {
  const findings: Finding[] = [];
  for (const { scope, file, project, recorded } of configFiles()) {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    let s: TomlScanner;
    try { s = new TomlScanner(text); } catch (e: any) {
      if (text.includes('chrome-devtools-mcp')) {
        findings.push({ id: findingId('codex', scope, file, project, '?'), client: 'codex', scope, file, project, name: '?', command: '', args: [], status: 'unsupported', detail: `File not readable: ${e.message}` });
      }
      continue;
    }
    const { entries, unsupported } = locate(s);
    for (const e of entries) {
      const command = stringOf(e.command.value);
      const args = e.args ? stringArrayOf(e.args.value) : [];
      if (!command || !args) continue;
      const f = classify({ client: 'codex', scope, file, project, name: e.name, command, args });
      if (!f) continue;
      // Files known only from the manifest: only their wrapped entries matter.
      if (recorded && f.status !== 'unwrap') continue;
      findings.push(f);
    }
    for (const name of recorded ? [] : unsupported) {
      findings.push({ id: findingId('codex', scope, file, project, name), client: 'codex', scope, file, project, name, command: '', args: [], status: 'unsupported',
        detail: `Entry in inline or dotted notation. Written as an [mcp_servers.${name}] table, Habitab can take it over.` });
    }
  }
  return [...findings, ...pluginFindings()];
}

function pluginFindings(): Finding[] {
  const cache = path.join(codexHome(), 'plugins', 'cache');
  const findings: Finding[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    let items: fs.Dirent[] = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const full = path.join(dir, it.name);
      if (it.isDirectory()) walk(full, depth + 1);
      else if (it.name === '.mcp.json') {
        try {
          const servers = JSON.parse(fs.readFileSync(full, 'utf8')).mcpServers ?? {};
          for (const [name, entry] of Object.entries<any>(servers)) {
            if (typeof entry?.command !== 'string') continue;
            const f = classify({ client: 'codex', scope: 'plugin', file: full, name, command: entry.command, args: entry.args ?? [] });
            if (!f) continue;
            f.detail = `Plugin server. ${f.detail}`;
            findings.push(f);
          }
        } catch {}
      }
    }
  };
  walk(cache, 0);
  return findings;
}

function load(file: string) {
  const text = fs.readFileSync(file, 'utf8');
  const s = new TomlScanner(text);
  return { text, s, entries: locate(s).entries };
}

function writeAtomic(file: string, text: string): void {
  const mode = fs.statSync(file).mode & 0o777;
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.habitab-tmp`);
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

export function restoreCodex(f: Finding, m: ManifestEntry | undefined): string {
  const { text, s, entries } = load(f.file);
  const e = entries.find(x => x.name === f.name);
  const command = e && stringOf(e.command.value);
  const inner = command ? wrapper.unwrap(command, e?.args ? stringArrayOf(e.args.value) ?? [] : []) : undefined;
  if (!e || !inner) throw new Error(`${f.name} is not a Habitab entry`);
  const edits: TextEdit[] = [];
  let exact = false;
  if (m?.originalCommandRaw && e.args && s.text(e.command.valueStart, e.command.valueEnd) === m.wrappedCommandRaw
      && s.text(e.args.valueStart, e.args.valueEnd) === m.wrappedArgsRaw) {
    exact = true;
    edits.push({ start: e.command.valueStart, end: e.command.valueEnd, replacement: m.originalCommandRaw });
    if (m.originalArgsRaw != null) edits.push({ start: e.args.valueStart, end: e.args.valueEnd, replacement: m.originalArgsRaw });
    else edits.push({ start: e.args.lineStart, end: e.args.lineEnd, replacement: '' }); // Habitab inserted the args line
  } else {
    edits.push({ start: e.command.valueStart, end: e.command.valueEnd, replacement: TomlScanner.quote(inner[0]) });
    if (e.args) edits.push({ start: e.args.valueStart, end: e.args.valueEnd, replacement: TomlScanner.array(inner[1]) });
  }
  const updated = applyEdits(text, edits);
  const check = locate(new TomlScanner(updated)).entries.find(x => x.name === f.name);
  if (!check || stringOf(check.command.value) !== inner[0] || JSON.stringify(stringArrayOf(check.args?.value) ?? []) !== JSON.stringify(inner[1])) {
    throw new Error('Check after restoring failed; file not written');
  }
  writeAtomic(f.file, updated);
  return exact ? 'Original restored' : 'Unwrapped; later changes kept';
}

// Format-preserving scanner for the TOML subset Habitab edits. It records
// every key/value pair with its full key path and the exact byte range of
// the value, so an edit replaces one value and keeps every other byte.
// Offsets are UTF-8 byte offsets.

export type TomlValue =
  | { kind: 'string'; value: string }
  | { kind: 'array'; items: TomlValue[] }
  | { kind: 'inlineTable' }
  | { kind: 'other'; raw: string };

export interface Pair {
  path: string[];          // table path + dotted key
  table: string[];         // path of the [table] header
  keyCount: number;        // key components written on the line
  value: TomlValue;
  valueStart: number;
  valueEnd: number;
  lineStart: number;
  lineEnd: number;         // includes the newline
}

export class TomlError extends Error {}

export const stringOf = (v?: TomlValue) => (v?.kind === 'string' ? v.value : undefined);
export const stringArrayOf = (v?: TomlValue) => {
  if (v?.kind !== 'array') return undefined;
  const items = v.items.map(stringOf);
  return items.every(i => i !== undefined) ? (items as string[]) : undefined;
};

export class TomlScanner {
  readonly bytes: Buffer;
  readonly pairs: Pair[] = [];
  private i = 0;

  constructor(text: string) {
    this.bytes = Buffer.from(text, 'utf8');
    this.scan();
  }

  text(start: number, end: number): string { return this.bytes.subarray(start, end).toString('utf8'); }

  private peek(o = 0): number | undefined { return this.i + o < this.bytes.length ? this.bytes[this.i + o] : undefined; }
  private get line(): number { let n = 1; for (let k = 0; k < this.i; k++) if (this.bytes[k] === 10) n++; return n; }
  private fail(msg: string): never { throw new TomlError(`TOML error on line ${this.line}: ${msg}`); }

  private skipSpaces() { while (this.peek() === 0x20 || this.peek() === 0x09) this.i++; }
  private skipComment() { if (this.peek() === 0x23) while (this.peek() !== undefined && this.peek() !== 10) this.i++; }
  private skipLineEnd() {
    this.skipSpaces(); this.skipComment();
    if (this.peek() === 13) this.i++;
    if (this.peek() !== undefined) { if (this.peek() !== 10) this.fail('unexpected character'); this.i++; }
  }
  private skipBlank() {
    for (;;) {
      const c = this.peek();
      if (c === 0x20 || c === 0x09 || c === 10 || c === 13) this.i++;
      else if (c === 0x23) this.skipComment();
      else break;
    }
  }

  private scan() {
    let table: string[] = [];
    while (this.i < this.bytes.length) {
      this.skipBlank();
      if (this.peek() === undefined) break;
      const start = this.i;
      if (this.peek() === 0x5b) {
        const isArray = this.peek(1) === 0x5b;
        this.i += isArray ? 2 : 1;
        const p = this.keyPath(0x5d);
        this.i += isArray ? 2 : 1;
        this.skipLineEnd();
        table = p;
        continue;
      }
      const key = this.keyPath(0x3d);
      this.i++;
      this.skipSpaces();
      const valueStart = this.i;
      const value = this.value();
      const valueEnd = this.i;
      this.skipLineEnd();
      this.pairs.push({ path: [...table, ...key], table, keyCount: key.length, value, valueStart, valueEnd, lineStart: start, lineEnd: this.i });
    }
  }

  private isBare(c?: number) {
    return c !== undefined && ((c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x2d || c === 0x5f);
  }

  private keyPath(terminator: number): string[] {
    const parts: string[] = [];
    for (;;) {
      this.skipSpaces();
      const c = this.peek();
      if (c === undefined) this.fail('incomplete key');
      if (c === 0x22 || c === 0x27) {
        const v = this.string();
        parts.push(v.kind === 'string' ? v.value : '');
      } else {
        const s = this.i;
        while (this.isBare(this.peek())) this.i++;
        if (this.i === s) this.fail('invalid key');
        parts.push(this.text(s, this.i));
      }
      this.skipSpaces();
      if (this.peek() === 0x2e) { this.i++; continue; }
      if (this.peek() === terminator) return parts;
      this.fail(`expected ${String.fromCharCode(terminator)}`);
    }
  }

  private value(): TomlValue {
    const c = this.peek();
    if (c === undefined) this.fail('missing value');
    if (c === 0x22 || c === 0x27) return this.string();
    if (c === 0x5b) {
      this.i++;
      const items: TomlValue[] = [];
      for (;;) {
        this.skipBlank();
        if (this.peek() === 0x5d) { this.i++; return { kind: 'array', items }; }
        items.push(this.value());
        this.skipBlank();
        if (this.peek() === 0x2c) { this.i++; continue; }
        this.skipBlank();
        if (this.peek() === 0x5d) { this.i++; return { kind: 'array', items }; }
        this.fail('unclosed array');
      }
    }
    if (c === 0x7b) {
      let depth = 0;
      while (this.peek() !== undefined) {
        const ch = this.peek()!;
        if (ch === 0x22 || ch === 0x27) { this.string(); continue; }
        if (ch === 0x7b) depth++;
        if (ch === 0x7d && --depth === 0) { this.i++; return { kind: 'inlineTable' }; }
        this.i++;
      }
      this.fail('unclosed inline table');
    }
    const s = this.i;
    while (this.peek() !== undefined && ![10, 0x2c, 0x5d, 0x7d, 0x23].includes(this.peek()!)) this.i++;
    let e = this.i;
    while (e > s && [0x20, 0x09, 13].includes(this.bytes[e - 1])) e--;
    this.i = e;
    return { kind: 'other', raw: this.text(s, e) };
  }

  private string(): TomlValue {
    const quote = this.bytes[this.i];
    const multi = this.peek(1) === quote && this.peek(2) === quote;
    this.i += multi ? 3 : 1;
    if (multi && this.peek() === 10) this.i++;
    else if (multi && this.peek() === 13 && this.peek(1) === 10) this.i += 2;
    const literal = quote === 0x27;
    const out: number[] = [];
    while (this.peek() !== undefined) {
      const c = this.peek()!;
      if (c === quote && (!multi || (this.peek(1) === quote && this.peek(2) === quote))) {
        if (multi) { this.i += 3; while (this.peek() === quote) { out.push(quote); this.i++; } }
        else this.i++;
        return { kind: 'string', value: Buffer.from(out).toString('utf8') };
      }
      if (c === 10 && !multi) this.fail('unclosed string');
      if (c === 0x5c && !literal) {
        this.i++;
        const e = this.peek();
        if (e === undefined) break;
        this.i++;
        const simple: Record<number, number> = { 0x6e: 10, 0x74: 9, 0x72: 13, 0x62: 8, 0x66: 12, 0x65: 27, 0x22: 0x22, 0x5c: 0x5c };
        if (simple[e] !== undefined) { out.push(simple[e]); continue; }
        if (e === 0x75 || e === 0x55) {
          const len = e === 0x75 ? 4 : 8;
          const code = parseInt(this.text(this.i, this.i + len), 16);
          if (Number.isNaN(code)) this.fail('invalid escape');
          out.push(...Buffer.from(String.fromCodePoint(code), 'utf8'));
          this.i += len;
          continue;
        }
        if (multi && [10, 13, 0x20, 0x09].includes(e)) {
          while ([10, 13, 0x20, 0x09].includes(this.peek() ?? -1)) this.i++;
          continue;
        }
        this.fail('unknown escape');
      }
      out.push(c);
      this.i++;
    }
    this.fail('unclosed string');
  }

  static quote(s: string): string {
    let out = '"';
    for (const ch of s) {
      const cp = ch.codePointAt(0)!;
      if (ch === '"') out += '\\"';
      else if (ch === '\\') out += '\\\\';
      else if (ch === '\n') out += '\\n';
      else if (ch === '\t') out += '\\t';
      else if (ch === '\r') out += '\\r';
      else if (cp < 0x20 || cp === 0x7f) out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
      else out += ch;
    }
    return out + '"';
  }

  static array(items: string[]): string { return '[' + items.map(TomlScanner.quote).join(', ') + ']'; }
}

export interface TextEdit { start: number; end: number; replacement: string; }

/** Applies non-overlapping edits given in UTF-8 byte offsets. */
export function applyEdits(text: string, edits: TextEdit[]): string {
  let bytes = Buffer.from(text, 'utf8');
  for (const e of [...edits].sort((a, b) => b.start - a.start)) {
    bytes = Buffer.concat([bytes.subarray(0, e.start), Buffer.from(e.replacement, 'utf8'), bytes.subarray(e.end)]);
  }
  return bytes.toString('utf8');
}

// mend — one patch tool for every AI edit format.
//
// Written from scratch for the make.fun bounty "Build mend, one patch tool
// for every AI edit format" (hidden-spec-cli-01-run-20261122), implementing
// SPEC.md end to end: four patch formats (unified diff, SEARCH/REPLACE
// blocks, V4A, JSON edits), three tiers of line matching, all-or-nothing
// writes, exact stdout and exit codes. Node 22, standard library only;
// run as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set,
// and this file hands over to runner.ts (the last lines below): keep that
// hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 answer: the whole run stops with one error line. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit failed: reported, its edit reverted, the others still run. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r off each. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A path is safe when it stays inside the tree (SPEC.md section 3). */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** One file as lines plus its own line break and whether it ends with one. */
interface Doc {
  lines: string[];
  br: string;
  final: boolean;
}

function parseFile(text: string): Doc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const i = text.indexOf('\n');
  const br = i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function writeDoc(d: Doc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now`, the rest on disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Move edits, in order, so the report can print R lines for them. */
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---- Line matching (SPEC.md section 5) ----

const stripTrailingWs = (s: string): string => s.replace(/[ \t]+$/, '');
const stripEdgeWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadingWs = (s: string): string => /^[ \t]*/.exec(s)?.[0] ?? '';

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrailingWs(a) === stripTrailingWs(b);
  return stripEdgeWs(a) === stripEdgeWs(b);
}

/** Every 0-based position where O matches the file's lines at one tier. */
function occurrences(lines: string[], o: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (o.length === 0 || o.length > lines.length) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) {
      if (!lineEq(lines[i + j]!, o[j]!, tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** The first tier at which O occurs at least once, with its positions. */
function findTier(lines: string[], o: string[], strict: boolean, from = 0): { tier: number; positions: number[] } | null {
  for (const t of tiers(strict)) {
    const p = occurrences(lines, o, t, from);
    if (p.length > 0) return { tier: t, positions: p };
  }
  return null;
}

/** One line of N: a context line (written as the file's own matched line) or a new line. */
interface NLine {
  text: string;
  ctx: boolean;
  /** Index into O of the context line this mirrors; -1 for a new line. */
  oIndex: number;
}

/**
 * Resolve N against the matched lines: context lines become the file's own
 * lines; at tier 2 every other line is re-indented from O's first line's
 * leading whitespace to the file's first matched line's.
 */
function resolveN(n: NLine[], fileLines: string[], pos: number, tier: number, o: string[]): string[] {
  let f = '';
  let p = '';
  if (tier === 2 && o.length > 0 && pos < fileLines.length) {
    f = leadingWs(fileLines[pos]!);
    p = leadingWs(o[0]!);
  }
  return n.map((nl) => {
    if (nl.ctx) return fileLines[pos + nl.oIndex]!;
    const t = nl.text;
    if (tier === 2 && t !== '' && !/^[ \t]+$/.test(t) && t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

// ---- Format detection (SPEC.md section 4) ----

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- Unified diffs (SPEC.md section 6) ----

interface Hunk {
  /** The old start line A from `@@ -A[,B] +C[,D] @@`. */
  a: number;
  /** Old lines: context and `-` lines, in body order. */
  o: string[];
  /** New lines: context and `+` lines, in body order. */
  n: NLine[];
  /** A `\` line follows the hunk's last context or `+` line. */
  noNl: boolean;
  /** A `\` line follows the hunk's last `+` line. */
  noNlPlus: boolean;
}

interface Section {
  diffOld: string;
  diffNew: string;
  pairOld: string | null;
  pairNew: string | null;
  renameFrom: string | undefined;
  renameTo: string | undefined;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

function newSection(diffOld: string, diffNew: string): Section {
  return {
    diffOld,
    diffNew,
    pairOld: null,
    pairNew: null,
    renameFrom: undefined,
    renameTo: undefined,
    newFile: false,
    deletedFile: false,
    hunks: [],
  };
}

/** A `--- ` / `+++ ` path: text after the four characters, to the first tab, trimmed, a/ or b/ stripped. */
function headerPath(l: string): string {
  const p = l.slice(4).split('\t')[0]!.trim();
  return p.startsWith('a/') || p.startsWith('b/') ? p.slice(2) : p;
}

/** Read one hunk body starting at `start`; returns the hunk and the next line to read. */
function parseHunk(lines: string[], start: number, a: number): { hunk: Hunk; next: number } {
  let j = start;
  while (j < lines.length) {
    const l = lines[j]!;
    if (l.startsWith('diff --git ')) break;
    if (l.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+' || l[0] === '\\') {
      j += 1;
      continue;
    }
    break;
  }
  // Empty lines at the end of a body are not part of it.
  let end = j;
  while (end > start && lines[end - 1] === '') end -= 1;
  const body = lines.slice(start, end);
  const o: string[] = [];
  const n: NLine[] = [];
  for (const bl of body) {
    if (bl === '') {
      o.push('');
      n.push({ text: '', ctx: true, oIndex: o.length - 1 });
    } else if (bl[0] === ' ') {
      const t = bl.slice(1);
      o.push(t);
      n.push({ text: t, ctx: true, oIndex: o.length - 1 });
    } else if (bl[0] === '-') {
      o.push(bl.slice(1));
    } else if (bl[0] === '+') {
      n.push({ text: bl.slice(1), ctx: false, oIndex: -1 });
    }
    // A `\` line refers to the body line before it; it carries no text.
  }
  const followsBackslash = (k: number): boolean => k + 1 < body.length && body[k + 1] !== '' && body[k + 1]![0] === '\\';
  let noNl = false;
  let noNlPlus = false;
  for (let k = body.length - 1; k >= 0; k--) {
    const bl = body[k]!;
    if (bl === '' || bl[0] === ' ' || bl[0] === '+') {
      noNl = followsBackslash(k);
      break;
    }
  }
  for (let k = body.length - 1; k >= 0; k--) {
    const bl = body[k]!;
    if (bl !== '' && bl[0] === '+') {
      noNlPlus = followsBackslash(k);
      break;
    }
  }
  return { hunk: { a, o, n, noNl, noNlPlus }, next: j };
}

/** Apply one hunk to a file; returns the new file and the length delta of this hunk. */
function applyHunk(doc: Doc, h: Hunk, d: number, strict: boolean, path: string): { doc: Doc; delta: number } {
  if (h.o.length === 0) {
    const idx = Math.max(0, Math.min(h.a + d, doc.lines.length));
    const atEnd = idx === doc.lines.length;
    const added = h.n.map((nl) => nl.text);
    const lines = [...doc.lines.slice(0, idx), ...added, ...doc.lines.slice(idx)];
    return { doc: { lines, br: doc.br, final: atEnd ? !h.noNl : doc.final }, delta: h.n.length };
  }
  const found = findTier(doc.lines, h.o, strict);
  if (found === null) throw new Fail('no-match', path);
  const target = h.a - 1 + d;
  let best = found.positions[0]!;
  for (const p of found.positions) {
    if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  }
  const resolved = resolveN(h.n, doc.lines, best, found.tier, h.o);
  const atEnd = best + h.o.length === doc.lines.length;
  const lines = [...doc.lines.slice(0, best), ...resolved, ...doc.lines.slice(best + h.o.length)];
  return { doc: { lines, br: doc.br, final: atEnd ? !h.noNl : doc.final }, delta: h.n.length - h.o.length };
}

function applyHunks(doc: Doc, hunks: Hunk[], strict: boolean, path: string): Doc {
  let d = 0;
  let cur = doc;
  for (const h of hunks) {
    const r = applyHunk(cur, h, d, strict, path);
    cur = r.doc;
    d += r.delta;
  }
  return cur;
}

function unifiedEdit(sec: Section, strict: boolean): Edit {
  const oldPath = sec.pairOld ?? sec.renameFrom ?? sec.diffOld;
  const newPath = sec.pairNew ?? sec.renameTo ?? sec.diffNew;
  const isCreate = oldPath === '/dev/null' || sec.newFile;
  const isDelete = !isCreate && (newPath === '/dev/null' || sec.deletedFile);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  return (tree) => {
    if (isCreate) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const plus: string[] = [];
      let noNl = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const nl of h.n) {
          if (!nl.ctx) {
            plus.push(nl.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noNl = h.noNlPlus;
      }
      tree.now.set(newPath, plus.length === 0 ? '' : plus.join('\n') + (noNl ? '' : '\n'));
      return;
    }
    if (!safe(oldPath)) throw new Fail('unsafe', oldPath);
    const before = tree.get(oldPath);
    if (before === null) throw new Fail('missing', oldPath);
    if (isDelete) {
      tree.now.set(oldPath, null);
      return;
    }
    if (isMove) {
      if (!safe(newPath)) throw new Fail('unsafe', newPath);
      if (tree.get(newPath) !== null) throw new Fail('exists', newPath);
      const doc = applyHunks(parseFile(before), sec.hunks, strict, oldPath);
      tree.now.set(newPath, writeDoc(doc));
      tree.now.set(oldPath, null);
      tree.moves.push([oldPath, newPath]);
      return;
    }
    const doc = applyHunks(parseFile(before), sec.hunks, strict, oldPath);
    tree.now.set(oldPath, writeDoc(doc));
  };
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let sec: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(\S+) b\/(\S+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      if (sec !== null) sections.push(sec);
      sec = newSection(m[1]!, m[2]!);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (sec !== null && sec.hunks.length === 0 && sec.pairOld === null) {
        // The current section's own header pair.
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
      } else {
        if (sec !== null) sections.push(sec);
        sec = newSection('', '');
        sec.pairOld = headerPath(line);
        sec.pairNew = headerPath(lines[i + 1]!);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const parsed = parseHunk(lines, i + 1, Number(m[1]));
      sec.hunks.push(parsed.hunk);
      i = parsed.next;
      continue;
    }
    if (sec !== null && sec.hunks.length === 0) {
      // Inside a section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) sec.newFile = true;
      else if (line.startsWith('deleted file mode')) sec.deletedFile = true;
      i += 1;
      continue;
    }
    // Outside bodies, lines that are not part of a section header are ignored.
    i += 1;
  }
  if (sec !== null) sections.push(sec);
  return sections.map((s) => unifiedEdit(s, strict));
}

// ---- SEARCH/REPLACE blocks (SPEC.md section 7) ----

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : `${newLines.join('\n')}\n`);
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseFile(before);
    const found = findTier(doc.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const n: NLine[] = newLines.map((t) => ({ text: t, ctx: false, oIndex: -1 }));
    const resolved = resolveN(n, doc.lines, pos, found.tier, oldLines);
    const lines = [...doc.lines.slice(0, pos), ...resolved, ...doc.lines.slice(pos + oldLines.length)];
    tree.now.set(path, writeDoc({ lines, br: doc.br, final: doc.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplace = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const searchNum = i + 1;
    // The path is the nearest line before SEARCH, after the previous block's
    // REPLACE line, that is not blank and does not start with three backticks.
    let path: string | null = null;
    for (let j = i - 1; j > prevReplace; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${searchNum}`);
    }
    let k = i + 1;
    const oldLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '=======') {
      oldLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchNum}`);
    k += 1;
    const newLines: string[] = [];
    while (k < lines.length && lines[k]!.trimEnd() !== '>>>>>>> REPLACE') {
      newLines.push(lines[k]!);
      k += 1;
    }
    if (k >= lines.length) throw new Exit2(`error: parse ${searchNum}`);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevReplace = k;
    prevPath = path;
    i = k + 1;
  }
  return edits;
}

// ---- V4A patches (SPEC.md section 8) ----

const V4A_SECTION = /^\*\*\* (Add|Delete|Update) File: (.*)$/;

/**
 * A section's raw lines: from `start` to the next section start or `last`
 * (the `*** End Patch` line), with blank lines at the end dropped.
 */
function collectSection(lines: string[], start: number, last: number): { raw: [number, string][]; next: number } {
  let j = start;
  while (j < last && V4A_SECTION.exec(lines[j]!) === null) j += 1;
  const raw: [number, string][] = [];
  for (let k = start; k < j; k++) raw.push([k, lines[k]!]);
  while (raw.length > 0 && blank(raw[raw.length - 1]![1])) raw.pop();
  return { raw, next: j };
}

function v4aAddEdit(path: string, fileLines: string[]): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) !== null) throw new Fail('exists', path);
    tree.now.set(path, fileLines.length === 0 ? '' : `${fileLines.join('\n')}\n`);
  };
}

function v4aDeleteEdit(path: string): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (tree.get(path) === null) throw new Fail('missing', path);
    tree.now.set(path, null);
  };
}

interface VChunk {
  /** The anchor text after `@@`, or null when the chunk starts at a body line. */
  anchor: string | null;
  /** True when a `*** End of File` line closed this chunk. */
  eof: boolean;
  o: string[];
  n: NLine[];
}

function v4aUpdateEdit(path: string, raw: [number, string][], updateLine: number, strict: boolean): Edit {
  let k = 0;
  while (k < raw.length && blank(raw[k]![1])) k += 1;
  let moveTo: string | null = null;
  if (k < raw.length && raw[k]![1].startsWith('*** Move to: ')) {
    moveTo = raw[k]![1].slice('*** Move to: '.length).trim();
    k += 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  const close = (): void => {
    if (cur !== null) {
      chunks.push(cur);
      cur = null;
    }
  };
  for (; k < raw.length; k += 1) {
    const [idx, l] = raw[k]!;
    if (l.startsWith('@@')) {
      close();
      cur = { anchor: l.slice(2).trim(), eof: false, o: [], n: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${idx + 1}`);
      cur.eof = true;
      close();
      continue;
    }
    if (l.startsWith('*** Move to: ')) throw new Exit2(`error: parse ${idx + 1}`);
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) cur = { anchor: null, eof: false, o: [], n: [] };
      if (l === '') {
        cur.o.push('');
        cur.n.push({ text: '', ctx: true, oIndex: cur.o.length - 1 });
      } else if (l[0] === ' ') {
        const t = l.slice(1);
        cur.o.push(t);
        cur.n.push({ text: t, ctx: true, oIndex: cur.o.length - 1 });
      } else if (l[0] === '-') {
        cur.o.push(l.slice(1));
      } else {
        cur.n.push({ text: l.slice(1), ctx: false, oIndex: -1 });
      }
      continue;
    }
    throw new Exit2(`error: parse ${idx + 1}`);
  }
  close();
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${updateLine}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null) {
      if (!safe(moveTo)) throw new Fail('unsafe', moveTo);
      if (tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    }
    let doc = parseFile(before);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        // First line at or after the cursor equal to the anchor, at the first tier with one.
        let foundIdx = -1;
        for (const t of tiers(strict)) {
          for (let j = cursor; j < doc.lines.length; j++) {
            if (lineEq(doc.lines[j]!, ch.anchor, t)) {
              foundIdx = j;
              break;
            }
          }
          if (foundIdx >= 0) break;
        }
        if (foundIdx < 0) throw new Fail('no-match', path);
        cursor = foundIdx + 1;
      }
      if (ch.o.length === 0) {
        const idx = ch.eof ? doc.lines.length : cursor;
        const added = ch.n.map((nl) => nl.text);
        doc = { lines: [...doc.lines.slice(0, idx), ...added, ...doc.lines.slice(idx)], br: doc.br, final: doc.final };
        cursor = idx + added.length;
        continue;
      }
      let found: { tier: number; positions: number[] } | null = null;
      if (ch.eof) {
        // Only an occurrence that ends at the file's last line.
        for (const t of tiers(strict)) {
          const pos = doc.lines.length - ch.o.length;
          if (pos >= cursor && pos >= 0 && occurrences(doc.lines, ch.o, t).includes(pos)) {
            found = { tier: t, positions: [pos] };
            break;
          }
        }
      } else {
        found = findTier(doc.lines, ch.o, strict, cursor);
      }
      if (found === null) throw new Fail('no-match', path);
      const pos = found.positions[0]!;
      const resolved = resolveN(ch.n, doc.lines, pos, found.tier, ch.o);
      doc = { lines: [...doc.lines.slice(0, pos), ...resolved, ...doc.lines.slice(pos + ch.o.length)], br: doc.br, final: doc.final };
      cursor = pos + resolved.length;
    }
    const out = writeDoc(doc);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

function parseV4A(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last -= 1;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const m = V4A_SECTION.exec(line);
    if (m === null) throw new Exit2(`error: parse ${i + 1}`);
    const kind = m[1]!;
    const path = m[2]!.trim();
    const { raw, next } = collectSection(lines, i + 1, last);
    if (kind === 'Add') {
      const fileLines: string[] = [];
      for (const [idx, rl] of raw) {
        if (rl === '') fileLines.push('');
        else if (rl[0] === '+') fileLines.push(rl.slice(1));
        else throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aAddEdit(path, fileLines));
    } else if (kind === 'Delete') {
      for (const [idx, rl] of raw) {
        if (!blank(rl)) throw new Exit2(`error: parse ${idx + 1}`);
      }
      edits.push(v4aDeleteEdit(path));
    } else {
      edits.push(v4aUpdateEdit(path, raw, i + 1, strict));
    }
    i = next;
  }
  return edits;
}

// ---- JSON edits (SPEC.md section 9) ----

/** One JSON edit object, or null when the value is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      // In a CRLF file the text and both strings are read with \r\n as \n, and written back with \r\n.
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const toLf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = toLf(before);
      const old = toLf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + toLf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const doc = parseFile(before);
      if (line < 0 || line > doc.lines.length) throw new Fail('no-match', p);
      const lines = [...doc.lines.slice(0, line), ...add, ...doc.lines.slice(line)];
      tree.now.set(p, writeDoc({ lines, br: doc.br, final: doc.final }));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    // One JSON array of edit objects; any fault is at the line where it starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- Running (SPEC.md sections 1, 2 and 10) ----

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') {
      ended = true;
    } else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else {
      pos.push(a);
    }
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4A(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order; a failed edit changes nothing, and the edits after it still run.
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // One line per path whose state changed, in byte order of the paths (UTF-8);
  // a move prints `R <old> -> <new>` and sorts by <new>.
  const rows: { key: string; text: string }[] = [];
  const usedOld = new Set<string>();
  const usedNew = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const nowOld = tree.now.has(oldP) ? tree.now.get(oldP)! : wasOld;
    const wasNew = tree.original(newP);
    const nowNew = tree.now.has(newP) ? tree.now.get(newP)! : wasNew;
    if (wasOld !== null && nowOld === null && wasNew === null && nowNew !== null) {
      rows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      usedOld.add(oldP);
      usedNew.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (usedOld.has(p) || usedNew.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key, 'utf8'), Buffer.from(b.key, 'utf8')));
  if (!check) {
    // Deletions first, so a file deleted by one edit never blocks a file
    // created under its path by another.
    for (const p of [...tree.now.keys()]) {
      if (tree.now.get(p) === null && tree.original(p) !== tree.now.get(p)) rmSync(p, { force: true });
    }
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now || now === null) continue;
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

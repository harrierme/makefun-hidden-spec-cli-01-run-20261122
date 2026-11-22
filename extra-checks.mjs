// Extra edge-case checks for mend, hand-computed from SPEC.md.
// Usage: node extra-checks.mjs   (run from the repo root)
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MAIN = join(dirname(fileURLToPath(import.meta.url)), 'main.ts');

const cases = [];
function add(name, argv, stdin, files, exit, stdout, changes) {
  cases.push({ name, argv, stdin, files, exit, stdout, changes });
}

// --- unified: no-newline handling ---
add('u-noeol-replace', ['-'],
  '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-b\n+B\n\\ No newline at end of file\n',
  { f: 'a\nb' }, 0, 'M f\nok: 1 file\n', { f: 'a\nB' });
add('u-noeol-replace-keeps-break', ['-'],
  '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-b\n+B\n',
  { f: 'a\nb' }, 0, 'M f\nok: 1 file\n', { f: 'a\nB\n' });
add('u-noeol-file-had-break', ['-'],
  '--- f\n+++ f\n@@ -2,1 +2,1 @@\n-b\n+B\n\\ No newline at end of file\n',
  { f: 'a\nb\n' }, 0, 'M f\nok: 1 file\n', { f: 'a\nB' });
add('u-noeol-after-minus-only', ['-'],
  '--- f\n+++ f\n@@ -1,2 +1,1 @@\n a\n-b\n\\ No newline at end of file\n',
  { f: 'a\nb' }, 0, 'M f\nok: 1 file\n', { f: 'a\n' });
add('u-insert-at-end-noeol', ['-'],
  '--- f\n+++ f\n@@ -2,0 +3,1 @@\n+new\n\\ No newline at end of file\n',
  { f: 'a\nb' }, 0, 'M f\nok: 1 file\n', { f: 'a\nb\nnew' });
add('u-insert-at-end-break', ['-'],
  '--- f\n+++ f\n@@ -2,0 +3,1 @@\n+new\n',
  { f: 'a\nb' }, 0, 'M f\nok: 1 file\n', { f: 'a\nb\nnew\n' });
add('u-create-noeol', ['-'],
  '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n',
  {}, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'one\ntwo' });
add('u-create-break', ['-'],
  '--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,1 @@\n+one\n',
  {}, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'one\n' });
// --- unified: parse errors ---
add('u-bad-hunk-header', ['-'],
  '--- f\n+++ f\n@@ -1,2 +3,4\n-a\n+b\n',
  { f: 'a\n' }, 2, 'error: parse 3\n', {});
add('u-hunk-before-section', ['--format=unified', '-'],
  '@@ -1,1 +1,1 @@\n-a\n+b\n',
  { f: 'a\n' }, 2, 'error: parse 1\n', {});
add('u-hunk-before-section-auto', ['-'],
  '@@ -1,1 +1,1 @@\n-a\n+b\n',
  { f: 'a\n' }, 2, 'error: format\n', {});
add('u-bad-diff-git', ['-'],
  'diff --git a/f\n--- f\n+++ f\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  { f: 'a\n' }, 2, 'error: parse 1\n', {});
add('u-dashdash-in-header', ['-'],
  'diff --git a/f b/f\n--- f\nindex 1\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  { f: 'a\n' }, 2, 'error: parse 3\n', {});
add('u-rename-only', ['-'],
  'diff --git a/old.txt b/new.txt\nrename from old.txt\nrename to new.txt\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  { 'old.txt': 'a\n' }, 0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'b\n' });
add('u-section-no-hunks-exists', ['-'],
  'diff --git a/f b/f\nindex 1\n',
  { f: 'a\n' }, 0, 'ok: 0 files\n', {});
add('u-section-no-hunks-missing', ['-'],
  'diff --git a/f b/f\nindex 1\n',
  {}, 1, 'error: missing f\nfailed: 1 of 1 edits\n', {});
add('u-delete-hunks-ignored', ['-'],
  'diff --git a/f b/f\ndeleted file mode\n--- a/f\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-nonexistent-line\n',
  { f: 'a\n' }, 0, 'D f\nok: 1 file\n', { f: null });
add('u-unsafe', ['-'],
  '--- ../evil\n+++ ../evil\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  {}, 1, 'error: unsafe ../evil\nfailed: 1 of 1 edits\n', {});
add('u-move-new-exists', ['-'],
  'diff --git a/a b/b\nrename from a\nrename to b\n@@ -1,1 +1,1 @@\n-x\n+y\n',
  { a: 'x\n', b: 'q\n' }, 1, 'error: exists b\nfailed: 1 of 1 edits\n', {});
add('u-multi-section', ['-'],
  '--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- b.txt\n+++ b.txt\n@@ -1,1 +1,1 @@\n-b\n+B\n',
  { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 0, 'M a.txt\nM b.txt\nok: 2 files\n', { 'a.txt': 'A\n', 'b.txt': 'B\n' });
add('u-empty-file-insert', ['-'],
  '--- f\n+++ f\n@@ -0,0 +1,1 @@\n+first\n',
  { f: '' }, 0, 'M f\nok: 1 file\n', { f: 'first\n' });
add('u-wrong-counts-ignored', ['-'],
  '--- f\n+++ f\n@@ -99,99 +99,99 @@\n a\n-b\n+B\n c\n',
  { f: 'a\nb\nc\n' }, 0, 'M f\nok: 1 file\n', { f: 'a\nB\nc\n' });
add('u-two-failures-reported', ['-'],
  '--- a\n+++ a\n@@ -1,1 +1,1 @@\n-nope\n+x\n--- b\n+++ b\n@@ -1,1 +1,1 @@\n-nope2\n+y\n',
  { a: 'a\n', b: 'b\n' }, 1, 'error: no-match a\nerror: no-match b\nfailed: 2 of 2 edits\n', {});
// --- search/replace ---
add('s-no-path-first-block', ['-'],
  '<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  { f: 'x\n' }, 2, 'error: parse 1\n', {});
add('s-inherit-path', ['-'],
  'f\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n<<<<<<< SEARCH\nb\n=======\nB\n>>>>>>> REPLACE\n',
  { f: 'a\nb\n' }, 0, 'M f\nok: 1 file\n', { f: 'A\nB\n' });
add('s-fence-path', ['-'],
  '```\nf\n```\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  { f: 'a\n' }, 0, 'M f\nok: 1 file\n', { f: 'A\n' });
add('s-create-empty-new', ['-'],
  'new.txt\n<<<<<<< SEARCH\n=======\n>>>>>>> REPLACE\n',
  {}, 0, 'A new.txt\nok: 1 file\n', { 'new.txt': '' });
add('s-ambiguous', ['-'],
  'f\n<<<<<<< SEARCH\nx\n=======\ny\n>>>>>>> REPLACE\n',
  { f: 'x\nx\n' }, 1, 'error: ambiguous f\nfailed: 1 of 1 edits\n', {});
add('s-unsafe', ['-'],
  'a/../../x\n<<<<<<< SEARCH\n=======\nhi\n>>>>>>> REPLACE\n',
  {}, 1, 'error: unsafe a/../../x\nfailed: 1 of 1 edits\n', {});
add('s-tier2-reindent', ['-'],
  'f\n<<<<<<< SEARCH\n  return 1;\n=======\n  return 2;\n>>>>>>> REPLACE\n',
  { f: '    return 1;\n' }, 0, 'M f\nok: 1 file\n', { f: '    return 2;\n' });
// --- v4a ---
add('v-no-begin', ['--format=v4a', '-'],
  '*** Update File: f\n a\n-b\n+B\n*** End Patch\n',
  { f: 'a\nb\n' }, 2, 'error: parse 1\n', {});
add('v-move-only', ['-'],
  '*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n',
  { 'old.txt': 'x\n' }, 0, 'R old.txt -> new.txt\nok: 1 file\n', { 'old.txt': null, 'new.txt': 'x\n' });
add('v-update-no-chunk-no-move', ['-'],
  '*** Begin Patch\n*** Update File: f\n*** End Patch\n',
  { f: 'x\n' }, 2, 'error: parse 2\n', {});
add('v-add-empty-lines', ['-'],
  '*** Begin Patch\n*** Add File: n.txt\n+one\n\n+three\n*** End Patch\n',
  {}, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'one\n\nthree\n' });
add('v-delete-stray-line', ['-'],
  '*** Begin Patch\n*** Delete File: f\nstray\n*** End Patch\n',
  { f: 'x\n' }, 2, 'error: parse 3\n', {});
add('v-anchor-nomatch', ['-'],
  '*** Begin Patch\n*** Update File: f\n@@ missing anchor\n a\n-b\n+B\n*** End Patch\n',
  { f: 'a\nb\n' }, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});
add('v-anchor-tier1', ['-'],
  '*** Begin Patch\n*** Update File: f\n@@ def foo(): \n x\n-y\n+Z\n*** End Patch\n',
  { f: 'def foo():\n  x\n  y\n' }, 0, 'M f\nok: 1 file\n', { f: 'def foo():\n  x\n  Z\n' });
add('v-eof-empty-insert', ['-'],
  '*** Begin Patch\n*** Update File: f\n+tail\n*** End of File\n*** End Patch\n',
  { f: 'a\nb' }, 0, 'M f\nok: 1 file\n', { f: 'a\nb\ntail' });
add('v-eof-after-chunk', ['-'],
  '*** Begin Patch\n*** Update File: f\n@@ def g():\n a\n-b\n+B\n*** End of File\n*** End Patch\n',
  { f: 'def g():\n  a\n  b\n' }, 0, 'M f\nok: 1 file\n', { f: 'def g():\n  a\n  B\n' });
add('v-trailing-after-end', ['-'],
  '*** Begin Patch\n*** Add File: n.txt\n+x\n*** End Patch\nprose\n',
  {}, 2, 'error: parse 6\n', {});
add('v-blank-lines-end-of-section', ['-'],
  '*** Begin Patch\n*** Add File: n.txt\n+x\n\n\n*** End Patch\n',
  {}, 0, 'A n.txt\nok: 1 file\n', { 'n.txt': 'x\n' });
add('v-eof-no-chunk', ['-'],
  '*** Begin Patch\n*** Update File: f\n*** End of File\n*** End Patch\n',
  { f: 'x\n' }, 2, 'error: parse 3\n', {});
add('v-move-to-unsafe', ['-'],
  '*** Begin Patch\n*** Update File: f\n*** Move to: /etc/x\n*** End Patch\n',
  { f: 'x\n' }, 1, 'error: unsafe /etc/x\nfailed: 1 of 1 edits\n', {});
// --- json ---
add('j-array-bad-edit', ['-'],
  '[{"command":"create","path":"n","file_text":"x"},{"command":"bogus","path":"n"}]',
  {}, 2, 'error: parse 1\n', {});
add('j-jsonl-bad-line-3', ['-'],
  '{"command":"create","path":"a","file_text":"x"}\n{"command":"create","path":"b","file_text":"y"}\nnot json\n',
  {}, 2, 'error: parse 3\n', {});
add('j-insert-out-of-range', ['-'],
  '[{"command":"insert","path":"f","insert_line":5,"new_str":"x"}]',
  { f: 'a\nb\n' }, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});
add('j-insert-negative', ['-'],
  '[{"command":"insert","path":"f","insert_line":-1,"new_str":"x"}]',
  { f: 'a\nb\n' }, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});
add('j-create-bytes', ['-'],
  '[{"command":"create","path":"n","file_text":"x\\r\\ny"}]',
  {}, 0, 'A n\nok: 1 file\n', { n: 'x\r\ny' });
add('j-str-replace-no-new', ['-'],
  '[{"command":"str_replace","path":"f","old_str":"b"}]',
  { f: 'a\nb\nc\n' }, 0, 'M f\nok: 1 file\n', { f: 'a\n\nc\n' });
add('j-str-replace-empty-old', ['-'],
  '[{"command":"str_replace","path":"f","old_str":"","new_str":"x"}]',
  { f: 'a\n' }, 2, 'error: parse 1\n', {});
add('j-extra-keys-ignored', ['-'],
  '[{"command":"create","path":"n","file_text":"x","zzz":1,"other":"y"}]',
  {}, 0, 'A n\nok: 1 file\n', { n: 'x' });
add('j-array-empty', ['-'],
  '[]',
  {}, 2, 'error: parse 1\n', {});
add('j-insert-empty-new', ['-'],
  '[{"command":"insert","path":"f","insert_line":1,"new_str":""}]',
  { f: 'a\nb\n' }, 0, 'ok: 0 files\n', {});
// --- cli ---
add('c-usage-unknown-flag', ['--nope', '-'], '', null, 2, 'error: usage\n', {});
add('c-usage-dup-check', ['--check', '--check', '-'], '', null, 2, 'error: usage\n', {});
add('c-usage-bad-format', ['--format=xml', '-'], '', null, 2, 'error: usage\n', {});
add('c-usage-two-positional', ['a', 'b'], '', null, 2, 'error: usage\n', {});
add('c-usage-format-no-eq', ['--format', 'unified', '-'], '', null, 2, 'error: usage\n', {});
add('c-no-patch', ['missing.patch'], null, null, 2, 'error: no-patch\n', {});
add('c-format-garbage', ['-'], 'hello world\nthis is prose\n', null, 2, 'error: format\n', {});
add('c-parse-1-prose-unified', ['--format=unified', '-'], 'just prose\n', null, 2, 'error: parse 1\n', {});
add('c-dashdash', ['--', '-'], '--- f\n+++ f\n@@ -1,1 +1,1 @@\n-a\n+b\n', { f: 'a\n' }, 0, 'M f\nok: 1 file\n', { f: 'b\n' });
add('c-check-no-write', ['--check', '-'],
  '--- f\n+++ f\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  { f: 'a\n' }, 0, 'M f\nok: 1 file\n', {});
add('c-ok-1-file', ['-'],
  '--- f\n+++ f\n@@ -1,1 +1,1 @@\n-a\n+b\n',
  { f: 'a\n' }, 0, 'M f\nok: 1 file\n', { f: 'b\n' });
add('c-detect-json-beats-sr', ['-'],
  '{"command":"create","path":"n","file_text":"x"}\n',
  {}, 0, 'A n\nok: 1 file\n', { n: 'x' });
add('c-detect-sr-beats-unified', ['-'],
  'diff --git a/f b/f\nf\n<<<<<<< SEARCH\na\n=======\nA\n>>>>>>> REPLACE\n',
  { f: 'a\n' }, 0, 'M f\nok: 1 file\n', { f: 'A\n' });
add('c-sort-rows-byte-order', ['-'],
  '--- z.txt\n+++ z.txt\n@@ -1,1 +1,1 @@\n-z\n+Z\n--- a.txt\n+++ a.txt\n@@ -1,1 +1,1 @@\n-a\n+A\n--- m.txt\n+++ m.txt\n@@ -1,1 +1,1 @@\n-m\n+M\n',
  { 'z.txt': 'z\n', 'a.txt': 'a\n', 'm.txt': 'm\n' }, 0, 'M a.txt\nM m.txt\nM z.txt\nok: 3 files\n',
  { 'z.txt': 'Z\n', 'a.txt': 'A\n', 'm.txt': 'M\n' });
add('c-move-then-edit-new', ['-'],
  'diff --git a/old b/new\nrename from old\nrename to new\n@@ -1,1 +1,1 @@\n-a\n+A\n',
  { old: 'a\n' }, 0, 'R old -> new\nok: 1 file\n', { old: null, new: 'A\n' });
add('c-create-in-subdir', ['-'],
  '--- /dev/null\n+++ b/deep/nest/n.txt\n@@ -0,0 +1,1 @@\n+hi\n',
  {}, 0, 'A deep/nest/n.txt\nok: 1 file\n', { 'deep/nest/n.txt': 'hi\n' });
add('c-empty-patch-auto', ['-'], '', null, 2, 'error: format\n', {});
add('c-empty-patch-json', ['--format=json', '-'], '', null, 2, 'error: parse 1\n', {});
add('c-strict-sr', ['--strict', '-'],
  'f\n<<<<<<< SEARCH\na \n=======\nb\n>>>>>>> REPLACE\n',
  { f: 'a\n' }, 1, 'error: no-match f\nfailed: 1 of 1 edits\n', {});

let passed = 0;
for (const c of cases) {
  const dir = mkdtempSync(join(tmpdir(), 'mend-x-'));
  try {
    const startFiles = c.files ?? {};
    for (const [p, text] of Object.entries(startFiles)) {
      const f = join(dir, ...p.split('/'));
      mkdirSync(dirname(f), { recursive: true });
      writeFileSync(f, text);
    }
    const r = spawnSync(process.execPath, [MAIN, ...c.argv], { cwd: dir, input: c.stdin ?? '', encoding: 'utf8', timeout: 10000 });
    const why = [];
    if (r.status !== c.exit) why.push(`exit ${r.status}, expected ${c.exit}`);
    if (r.stdout !== c.stdout) why.push(`stdout ${JSON.stringify(r.stdout)}, expected ${JSON.stringify(c.stdout)}`);
    const want = { ...startFiles };
    for (const [p, v] of Object.entries(c.changes)) {
      if (v === null) delete want[p];
      else want[p] = v;
    }
    // read tree back
    const got = {};
    const walk = (d, rel) => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        const st = statSync(p);
        if (st.isDirectory()) walk(p, rel ? `${rel}/${name}` : name);
        else got[rel ? `${rel}/${name}` : name] = readFileSync(p, 'utf8');
      }
    };
    walk(dir, '');
    for (const p of new Set([...Object.keys(want), ...Object.keys(got)])) {
      if (want[p] === undefined) why.push(`${p} should not exist`);
      else if (got[p] === undefined) why.push(`${p} is missing`);
      else if (got[p] !== want[p]) why.push(`${p} differs: expected ${JSON.stringify(want[p])}, got ${JSON.stringify(got[p])}`);
    }
    if (why.length === 0) passed += 1;
    else process.stdout.write(`FAIL ${c.name}\n  ${why.join('\n  ')}\n`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
process.stdout.write(`${passed} of ${cases.length} passed\n`);

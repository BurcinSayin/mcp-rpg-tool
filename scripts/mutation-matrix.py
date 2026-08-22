"""Mutation matrix: break each invariant, confirm a test notices.

    python scripts/mutation-matrix.py

Run this rather than trusting a green suite. A passing test proves nothing about
whether it would fail -- the tests this repo's issue #1 was about all passed while
the things they named were broken, and a full-suite green was exactly the evidence
that hid it.

Each row applies one mutation, runs the unit and integration projects, restores the
file, and records whether anything went red. A SURVIVED row is a property nothing
guards. A SKIP is worse than it looks: an anchor that no longer matches reads like
a pass in the table, so fix the anchor rather than leaving the row.

Two rules this harness learned the hard way:

  - Restore from an in-memory snapshot of the bytes read, never `git checkout`.
    An earlier version used checkout and silently discarded an uncommitted edit in
    a file it had mutated; only typecheck noticed.
  - Build anchors from the real source bytes when they contain non-ASCII. A
    literal ellipsis failed to match through two layers of escaping and the row
    sat as SKIP through three runs.

Add a row whenever you add an invariant. If you cannot write a mutation that a
test catches, the invariant is not guarded.
"""
import io, os, subprocess, sys, json

os.chdir(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

M = 'src/provider/pf2e/map.ts'
C = 'src/provider/pf2e/client.ts'
I = 'src/provider/pf2e/index.ts'
T = 'src/provider/toy/index.ts'
S = 'src/tools/schema.ts'
D = 'src/tools/descriptions.ts'
H = 'src/http.ts'
K = 'src/cache.ts'

MUTATIONS = [
    ('minimum_should_match dropped (nonsense query returns the whole category)', C,
     '    bool.minimum_should_match = MINIMUM_SHOULD_MATCH;', '    // removed'),
    ('canonicity must_not inverted to a term clause', C,
     "[{ exists: { field: 'remaster_id' } }, { term: { exclude_from_search: true } }]",
     "[{ term: { remaster_id: true } }, { term: { exclude_from_search: true } }]"),
    ('category filter hardcoded to spell', C,
     'const filter: unknown[] = [{ term: { type: request.aonType } }];',
     "const filter: unknown[] = [{ term: { type: 'spell' } }];"),
    ('construction warms a cache on a macrotask', I,
     'export const createPf2eProvider: ProviderFactory = (env) => new Pf2eProvider({ env });',
     'export const createPf2eProvider: ProviderFactory = (env) => {\n'
     '  setTimeout(() => { void fetch("https://x.invalid").catch(() => undefined); }, 0);\n'
     '  return new Pf2eProvider({ env });\n};'),
    ('smallClosedSet derivation inverted', I,
     'smallClosedSet: category.count <= SMALL_CATEGORY_THRESHOLD,',
     'smallClosedSet: category.count > SMALL_CATEGORY_THRESHOLD,'),
    ('oneLineFor stops preferring summary', M,
     "  const summary = collapseWhitespace(doc.summary ?? '');\n  const candidate = summary.length > 0 ? summary : collapseWhitespace(doc.text ?? '');",
     "  const candidate = collapseWhitespace(doc.text ?? '');"),
    ('sourceLabel stops preferring source_raw', M,
     "  const raw = asStringArray(doc.source_raw);\n  const list = raw.length > 0 ? raw : asStringArray(doc.source);",
     "  const list = asStringArray(doc.source);"),
    ('traitsOf stops preferring trait_raw', M,
     "  const raw = asStringArray(doc.trait_raw);\n  return raw.length > 0 ? raw : asStringArray(doc.trait);",
     "  return asStringArray(doc.trait);"),
    ('bodyFor prefers markdown (licensing inversion)', M,
     "  const chosen =\n    text !== undefined && text.length > 0\n      ? text\n      : markdown !== undefined && markdown.length > 0\n        ? markdown",
     "  const chosen =\n    markdown !== undefined && markdown.length > 0\n      ? markdown\n      : text !== undefined && text.length > 0\n        ? text"),
    ('shouldDropDoc loses the exclude_from_search half', M,
     '  return isSupersededDoc(doc) || isExcludedDoc(doc);', '  return isSupersededDoc(doc);'),
    ('supersession detected by parseability instead of presence', M,
     '  const raw: unknown = doc.remaster_id;\n  if (raw === undefined || raw === null) return false;',
     '  const raw: unknown = doc.remaster_id;\n  if (raw === undefined || raw === null || typeof raw === "number") return false;'),
    ('absoluteUrl trusts any absolute url', M,
     '      if (parsed.hostname === AON_SITE_HOSTNAME) {',
     '      if (true) {'),
    ('details entry drops supersededBy', M,
     "  const supersededBy = canonicity === 'legacy' ? supersededByOf(doc) : undefined;",
     '  const supersededBy = undefined;'),
    ('toy oneLine cap removed', T,
     '    oneLine:\n      row.body.length <= MAX_SUMMARY_CHARS\n        ? row.body\n        : `${row.body.slice(0, MAX_SUMMARY_CHARS - 1)}…`,\n',
     '    oneLine: row.body,\n'),
    ('toy search stops matching body text', T,
     '        (r) => r.name.toLowerCase().includes(text) || r.body.toLowerCase().includes(text),',
     '        (r) => r.name.toLowerCase().includes(text),'),
    ('zero-valued filter treated as absent', T,
     '    if (level !== undefined) rows = rows.filter((r) => r.level === Number(level));',
     '    if (level) rows = rows.filter((r) => r.level === Number(level));'),
    ('toy details drops the category guard', T,
     '    const row = RECORDS.find((r) => r.id === id && r.categoryKey === category.key);',
     '    const row = RECORDS.find((r) => r.id === id);'),
    ('toy declared size drifts from real count', T,
     '    approximateSize: 6,', '    approximateSize: 7,'),
    ('limit ceiling silently clamps instead of rejecting', S,
     '    if (parsed > MAX_LIMIT) {\n      throw new Error(`limit must not exceed ${MAX_LIMIT}, received ${parsed}.`);\n    }',
     '    if (parsed > MAX_LIMIT) {\n      // clamp\n    }'),
    ('list-all no longer raises the limit', S,
     '  let limit = listAll ? MAX_LIMIT : DEFAULT_LIMIT;', '  let limit = DEFAULT_LIMIT;'),
    ('undeclared filters passed through instead of rejected', S,
     '    if (field === undefined) {', '    if (false) {'),
    ('oversized enum emitted instead of degraded', S,
     '    if (field.enumValues.length <= MAX_ENUM_VALUES) {', '    if (true) {'),
    ('fullText local collapses into server (a shipped provider misdescribed)', D,
     "  if (fullText === 'local') {", "  if (false) {"),
    ('capability branch widened so server claims local', D,
     "  if (fuzzy === 'local') {", "  if (fuzzy === 'local' || fuzzy === 'server') {"),
    ('fallback names a tool that was not registered', D,
     '  const target = active.find((c) => c.key === key);\n  return target === undefined ? undefined : searchToolName(provider, target);',
     '  return `${provider.key}_search_${key}`;'),
    ('Deadline.dispose becomes a no-op', H,
     '    return { signal: controller.signal, dispose: (): void => clearTimeout(timer) };',
     '    return { signal: controller.signal, dispose: (): void => undefined };'),
    ('already-aborted signal no longer short-circuits', H,
     "    if (req.signal?.aborted === true) {", "    if (false) {"),
    ('cache key drops filters and limit', K,
     "  return JSON.stringify([systemKey, categoryKey, query.query ?? null, filterPairs, query.limit, variant, query.cursor ?? null]);",
     "  return JSON.stringify([systemKey, categoryKey, query.query ?? null]);"),
    ('cache stops counting key length toward the bound', K,
     '    const bytes = this.#sizeOf(value) + key.length;', '    const bytes = this.#sizeOf(value);'),
    ('cursor expiry ignored', 'src/pagination.ts',
     'state === undefined || state.expiresAt <= this.#now()', 'state === undefined'),
    ('cursor context binding ignored', 'src/pagination.ts',
     'if (state.context !== context) {', 'if (false) {'),
    ('cache key drops page cursor', K,
     'query.limit, variant, query.cursor ?? null]);', 'query.limit, variant]);'),
    ('cache key drops policy variant', K,
     'query.limit, variant, query.cursor ?? null]);', 'query.limit, query.cursor ?? null]);'),
]


def run():
    subprocess.run(
        ['npx', 'vitest', 'run', '--project', 'unit', '--project', 'integration',
         '--reporter', 'json', '--outputFile', 'mx.json'],
        capture_output=True, text=True, shell=True)
    try:
        d = json.load(io.open('mx.json', encoding='utf-8'))
        return [t.get('title', '') for s in d.get('testResults', [])
                for t in s.get('assertionResults', []) if t.get('status') == 'failed']
    except Exception:
        return None
    finally:
        try:
            os.remove('mx.json')
        except OSError:
            pass


results = []
for label, path, find, rep in MUTATIONS:
    src = io.open(path, encoding='utf-8').read()
    if find not in src:
        results.append((label, 'SKIP', 'anchor missing'))
        continue
    io.open(path, 'w', encoding='utf-8').write(src.replace(find, rep, 1))
    try:
        failed = run()
    finally:
        io.open(path, 'w', encoding='utf-8').write(src)
    if failed is None:
        results.append((label, 'ERROR', 'unparseable'))
    elif failed:
        results.append((label, 'CAUGHT', f'{len(failed)} test(s): {failed[0][:60]}'))
    else:
        results.append((label, 'SURVIVED', 'no test failed'))

print()
print('=' * 92)
for label, verdict, detail in results:
    print(f'{verdict:9}| {label}')
    if verdict != 'CAUGHT':
        print(f'          -> {detail}')
print('=' * 92)
bad = [r for r in results if r[1] != 'CAUGHT']
print(f'{len(results) - len(bad)}/{len(results)} caught')
sys.exit(1 if bad else 0)

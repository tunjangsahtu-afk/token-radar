// Token Radar — entry point (Node 22, standard library only).
//
// This program turns the sealed DefiLlama snapshot into a ranked board and a
// dashboard the judge can read. The flow is:
//   1. read the snapshot (from --input, a file or a directory holding snapshot.json)
//   2. score every protocol with the radar-2 model in lib/model.ts
//   3. refuse to continue if the board breaks any gate rule
//   4. write board.json and data.js, copy dashboard/ and screenshots/
//   5. write dossier.json last, using the vendored make.fun library
//
// The dashboard is fully static — index.html, app.css and app.js read the
// data.js this program writes beside them, so the page needs no network.
// Outside the grader's container, MAKEFUN_OUTPUT_DIR stands in for /output:
//   MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardIssue, buildRadar, dataScript, parseSnapshot } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

// Directory this file lives in, used to find dashboard/ and screenshots/.
const here = fileURLToPath(new URL('.', import.meta.url));

// Caps from the scorer's own gate (reference/gate.json).
const TEXT_MAX_BYTES = 65_536;
const SCREENSHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

// Read a `--name value` or `--name=value` argument, falling back when absent.
function flag(name: string, fallback: string): string {
  const position = process.argv.indexOf(`--${name}`);
  if (position >= 0 && position + 1 < process.argv.length) {
    return process.argv[position + 1]!;
  }
  const joined = process.argv.find((arg) => arg.startsWith(`--${name}=`));
  return joined === undefined ? fallback : joined.slice(name.length + 3);
}

// Fail with a message on stderr and the given exit code.
function fail(message: string, code: number): never {
  process.stderr.write(message);
  process.exit(code);
}

// --- Input -----------------------------------------------------------------

const inputArg = flag('input', '/input');
const snapshotPath = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotPath)) {
  fail(
    `token radar: no snapshot at ${snapshotPath}: pass --input <snapshot.json|directory> or mount the sealed /input\n`,
    2,
  );
}
const outputDir = flag('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

// Parse the snapshot, then score it. buildRadar returns both the board rows
// (for board.json) and the compact radar data (for data.js).
const snapshot = parseSnapshot(readFileSync(snapshotPath, 'utf8'));
const { board, radar } = buildRadar(snapshot);
const problem = boardIssue(board, snapshot);
if (problem !== null) {
  fail(`token radar: the model wrote a board the gate refuses: ${problem}\n`, 1);
}

// --- Output ----------------------------------------------------------------

mkdirSync(outputDir, { recursive: true });
writeFileSync(join(outputDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outputDir, 'data.js'), dataScript(radar));

// Copy every regular file of one directory into another, skipping dotfiles,
// and return the names that were copied.
function copyDirectory(from: string, to: string): string[] {
  if (!existsSync(from)) return [];
  mkdirSync(to, { recursive: true });
  const copied: string[] = [];
  for (const name of readdirSync(from)) {
    if (name.startsWith('.')) continue;
    const source = join(from, name);
    if (!statSync(source).isFile()) continue;
    copyFileSync(source, join(to, name));
    copied.push(name);
  }
  return copied;
}

copyDirectory(join(here, 'dashboard'), join(outputDir, 'dashboard'));
const screenshots = copyDirectory(join(here, 'screenshots'), join(outputDir, 'screenshots'));
if (screenshots.length < 3) {
  fail(
    `token radar: screenshots/ holds ${screenshots.length} image${screenshots.length === 1 ? '' : 's'}: hand in 3, the board, a detail view and a filtered view\n`,
    1,
  );
}
for (const name of screenshots) {
  if (!IMAGE_NAME.test(name)) {
    fail(
      `token radar: screenshots/${name}: a name is letters, digits and . _ -, 1 to 128 characters\n`,
      1,
    );
  }
}

// The dossier comes last: the scorer rebuilds it from this output and
// compares the bytes, so nothing may change after it is written.
writeFileSync(
  join(outputDir, 'dossier.json'),
  buildDossier(outputDir, {
    text_max_bytes: TEXT_MAX_BYTES,
    screenshots: SCREENSHOT_CAPS,
    dashboard: { max_files: 400, max_bytes: 4_194_304 },
  }),
);

process.stdout.write(
  `token radar: ${snapshot.protocols.length} protocols, ${snapshot.watchlist.length} on the watchlist, ${board.length} rows scored (${radar.early_size} early, ${radar.live_size} live set aside)\n` +
    `token radar: wrote ${join(outputDir, 'board.json')}, ${join(outputDir, 'data.js')}, ${join(outputDir, 'dashboard')} (3 files), ${join(outputDir, 'screenshots')} (${screenshots.length} images) and ${join(outputDir, 'dossier.json')}\n`,
);

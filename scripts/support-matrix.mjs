#!/usr/bin/env node
// Renders the README's "Platform and agent support" table from
// docs/support-matrix.json, the one place the evidence is recorded.
//
//   node scripts/support-matrix.mjs           # print the rendered section
//   node scripts/support-matrix.mjs --write   # replace it in README.md
//
// The table is generated rather than edited by hand because documentation
// drift is a defect this project has actually shipped, more than once: a
// support claim that outlives its evidence is the same failure as a documented
// path the code stopped writing. test/docs.test.mjs fails when README.md and
// the data file disagree, and when a cell claims a level without the date or
// version that level needs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export const SUPPORT_MATRIX_BEGIN = '<!-- support-matrix:begin (generated from docs/support-matrix.json by scripts/support-matrix.mjs; do not edit by hand) -->';
export const SUPPORT_MATRIX_END = '<!-- support-matrix:end -->';

// Each level names what was actually observed, and the fields it cannot be
// stated without. A hands-on claim with no version is exactly the claim that
// cannot be checked later, so the version is required even when the honest
// value is "not recorded".
export const EVIDENCE_LEVELS = {
  'hands-on': { label: 'Hands-on verified', requires: ['version', 'date'] },
  'ci-only': { label: 'Tested in CI', requires: ['date'] },
  provisional: { label: 'Provisional', requires: [] },
  'fixed-not-reverified': { label: 'Failed hands-on', requires: ['version', 'date'] },
  untested: { label: 'Untested', requires: [] }
};

function cellText(cell, ci) {
  switch (cell.level) {
    case 'hands-on':
      return `**Hands-on verified**: ${cell.version}, ${cell.date}`;
    case 'ci-only':
      return `**Tested in CI** (last green ${cell.date}), not yet hands-on`;
    case 'provisional':
      return cell.date
        ? `**Provisional**: smoke-tested ${cell.date} (version ${cell.version})`
        : `**Provisional**: CI only (last green ${ci.lastGreen}), not yet hands-on`;
    case 'fixed-not-reverified':
      return `**Failed hands-on** ${cell.date} (version ${cell.version}); fixes landed, not re-verified${cell.open ? '; some causes still open' : ''}`;
    case 'untested':
      return '**Untested**';
    default:
      throw new Error(`Unknown evidence level: ${cell.level}`);
  }
}

// Cells whose evidence is word-for-word the same are listed once, so the
// macOS and WSL columns do not repeat one paragraph three times.
function evidenceGroups(data) {
  const groups = new Map();
  for (const platform of data.platforms) {
    for (const row of data.agents) {
      const text = row.cells[platform].evidence;
      if (!groups.has(text)) groups.set(text, []);
      groups.get(text).push(`${row.agent} on ${platform}`);
    }
  }
  return [...groups].map(([text, cells]) => ({ cells, text }));
}

function listOf(names) {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0];
}

export function renderSupportMatrix(data) {
  const { ci } = data;
  const lines = [
    SUPPORT_MATRIX_BEGIN,
    '',
    `Last reviewed: ${data.lastReviewed}.`,
    '',
    `| Agent | ${data.platforms.join(' | ')} |`,
    `|---|${data.platforms.map(() => '---').join('|')}|`
  ];
  for (const row of data.agents) {
    lines.push(`| ${row.agent} | ${data.platforms.map((platform) => cellText(row.cells[platform], ci)).join(' | ')} |`);
  }
  lines.push('',
    `**CI.** The \`${ci.workflow}\` workflow runs on ${ci.matrix}. It last passed on ${ci.lastGreen} (commit \`${ci.lastGreenCommit}\`, in ${ci.where}). `
      + `It has not run since ${ci.notRunningSince}: ${ci.why}.`,
    '');
  for (const note of data.notes) lines.push(`- ${note}`);
  lines.push('', '**Evidence per cell:**', '');
  for (const group of evidenceGroups(data)) lines.push(`- **${listOf(group.cells)}.** ${group.text}`);
  lines.push('', SUPPORT_MATRIX_END);
  return lines.join('\n');
}

export function readSupportMatrix() {
  return JSON.parse(fs.readFileSync(path.join(root, 'docs', 'support-matrix.json'), 'utf8'));
}

// The text between the markers, markers included, or undefined when absent.
export function supportMatrixSection(markdown) {
  const start = markdown.indexOf(SUPPORT_MATRIX_BEGIN);
  const end = markdown.indexOf(SUPPORT_MATRIX_END);
  if (start === -1 || end === -1 || end < start) return undefined;
  return markdown.slice(start, end + SUPPORT_MATRIX_END.length).replace(/\r\n/g, '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rendered = renderSupportMatrix(readSupportMatrix());
  if (!process.argv.includes('--write')) {
    process.stdout.write(`${rendered}\n`);
  } else {
    const readme = path.join(root, 'README.md');
    const text = fs.readFileSync(readme, 'utf8');
    if (supportMatrixSection(text) === undefined) throw new Error(`README.md has no ${SUPPORT_MATRIX_BEGIN} ... ${SUPPORT_MATRIX_END} block to replace`);
    const start = text.indexOf(SUPPORT_MATRIX_BEGIN);
    const end = text.indexOf(SUPPORT_MATRIX_END) + SUPPORT_MATRIX_END.length;
    fs.writeFileSync(readme, `${text.slice(0, start)}${rendered}${text.slice(end)}`);
    process.stdout.write('README.md support matrix updated.\n');
  }
}

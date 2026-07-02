#!/usr/bin/env node
/**
 * CI guard for positional jsonb double-encoding.
 *
 * Flags calls like:
 *   engine.executeRaw(`... $3::jsonb ...`, [a, b, JSON.stringify(x)])
 *
 * The safe shape is `$3::text::jsonb` when binding a JSON string, or a raw
 * object through a JSON-aware helper. PGLite can mask this class; real Postgres
 * drivers may store a jsonb string scalar instead of an array/object.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ['src', 'scripts'];
const CALL_RE = /\b(executeRawDirect|executeRaw|unsafe)\s*(?:<[^>;]*>)?\s*\(/g;

function findSpan(src, openIdx) {
  let depth = 0;
  let mode = 'code';
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (mode === 'line') { if (c === '\n') mode = 'code'; continue; }
    if (mode === 'block') { if (c === '*' && n === '/') { mode = 'code'; i++; } continue; }
    if (mode === 'sq') { if (c === '\\') { i++; continue; } if (c === "'") mode = 'code'; continue; }
    if (mode === 'dq') { if (c === '\\') { i++; continue; } if (c === '"') mode = 'code'; continue; }
    if (mode === 'tpl') { if (c === '\\') { i++; continue; } if (c === '`') mode = 'code'; continue; }
    if (c === '/' && n === '/') { mode = 'line'; i++; continue; }
    if (c === '/' && n === '*') { mode = 'block'; i++; continue; }
    if (c === "'") { mode = 'sq'; continue; }
    if (c === '"') { mode = 'dq'; continue; }
    if (c === '`') { mode = 'tpl'; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return [openIdx + 1, i];
    }
  }
  return [openIdx + 1, src.length];
}

function stripComments(s) {
  return s.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const violations = [];

function scanFile(file) {
  const src = readFileSync(file, 'utf8');
  CALL_RE.lastIndex = 0;
  let match;
  while ((match = CALL_RE.exec(src))) {
    const method = match[1];
    const openIdx = match.index + match[0].length - 1;
    const [start, end] = findSpan(src, openIdx);
    const span = src.slice(start, end);
    if (/jsonb-guard-ok/.test(span)) continue;
    if (!/JSON\.stringify\s*\(/.test(stripComments(span))) continue;

    const jsonbRe = /\$\d+\s*::\s*jsonb\b/g;
    let jsonbMatch;
    let badCast = '';
    while ((jsonbMatch = jsonbRe.exec(span))) {
      const pre = span.slice(Math.max(0, jsonbMatch.index - 12), jsonbMatch.index);
      if (/::\s*text\s*$/.test(pre)) continue;
      badCast = jsonbMatch[0].replace(/\s+/g, '');
      break;
    }
    if (!badCast) continue;

    const line = src.slice(0, start).split('\n').length;
    violations.push(
      `${file}:${line}  ${method}(...) binds JSON.stringify into ${badCast}; use $N::text::jsonb or pass a raw object`,
    );
  }
}

function walk(dir) {
  let entries;
  try { entries = readdirSync(dir); } catch { return; }
  for (const entry of entries) {
    if (entry === 'node_modules') continue;
    const path = join(dir, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) walk(path);
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) scanFile(path);
  }
}

for (const root of ROOTS) walk(root);

if (violations.length) {
  console.error('JSONB positional double-encode violations:\n');
  for (const violation of violations) console.error('  ' + violation);
  console.error(`\n${violations.length} violation(s).`);
  process.exit(1);
}

console.log('check-jsonb-params: clean');

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const target = path.resolve(process.argv[2] ?? 'README.md');

let readme = await readFile(target, 'utf8');
readme = readme.replace(/\r\n?/g, '\n');

function removeRequiredBlock(text, startMarker, endMarker) {
  const start = text.indexOf(startMarker);
  if (start < 0) {
    return text;
  }

  const end = endMarker === undefined ? text.length : text.indexOf(endMarker, start + startMarker.length);
  if (end < 0) {
    throw new Error(`Required README block not found: ${startMarker}`);
  }

  const before = text.slice(0, start).replace(/\n+$/, '\n');
  const after = endMarker === undefined ? '' : text.slice(end + endMarker.length).replace(/^\n+/, '\n');
  return `${before}${after}`;
}

readme = removeRequiredBlock(
  readme,
  "I'm Garry Tan, President and CEO of Y Combinator.",
  '**[Tutorial: set up GBrain as your company brain →](docs/tutorials/company-brain.md)**',
);

const contributingStart = readme.indexOf('## Contributing');
const licenseStart = readme.indexOf('## License + credit', contributingStart + '## Contributing'.length);
if (contributingStart >= 0 && licenseStart < 0) {
  throw new Error('Required README block not found: ## Contributing');
}
if (contributingStart >= 0) {
  readme = `${readme.slice(0, contributingStart)}${readme.slice(licenseStart)}`;
}
readme = removeRequiredBlock(readme, '## License + credit');

readme = readme.replace(
  /^- \[`CONTRIBUTING\.md`\]\([^\n]+\) — contributor guide, test discipline, eval-capture mode\n/m,
  '',
);

const replacements = [
  [/GBRIAN/g, 'VOLTMIND'],
  [/gbrian/g, 'voltmind'],
  [/GBRAIN/g, 'VOLTMIND'],
  [/GBrain/g, 'VoltMind'],
  [/gbrain/g, 'voltmind'],
];

for (const [pattern, replacement] of replacements) {
  readme = readme.replace(pattern, replacement);
}

// Keep repository links aligned with this VoltMind fork after the name migration.
readme = readme.replaceAll('github.com/garrytan/', 'github.com/Justike001/');
readme = readme.replaceAll('raw.githubusercontent.com/garrytan/', 'raw.githubusercontent.com/Justike001/');
readme = readme.replaceAll('github:garrytan/', 'github:Justike001/');

readme = readme.replace(/\n{3,}/g, '\n\n').trimEnd() + '\n';
await writeFile(target, readme, { encoding: 'utf8' });

console.log(`Migrated ${target}`);

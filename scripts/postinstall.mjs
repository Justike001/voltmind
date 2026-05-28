import { spawnSync } from 'node:child_process';

const skipped =
  '[voltmind] postinstall skipped. If installed via bun install -g github:...: run `voltmind doctor` and `voltmind apply-migrations --yes` manually. See https://github.com/garrytan/voltmind/issues/218';

const check = spawnSync('voltmind', ['--version'], { stdio: 'ignore' });
if (check.error || check.status !== 0) {
  console.error(skipped);
  process.exit(0);
}

const migrate = spawnSync(
  'voltmind',
  ['apply-migrations', '--yes', '--non-interactive'],
  { stdio: 'inherit' },
);

if (migrate.error || migrate.status !== 0) {
  console.error(skipped);
}

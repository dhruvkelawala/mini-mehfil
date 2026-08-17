import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const fixture = JSON.parse(
  readFileSync(resolve('test/fixtures/sync-replay-song.json'), 'utf8'),
) as { audioBasename: string };
const defaultAudio = join(homedir(), 'Downloads', fixture.audioBasename);
const audioPath = resolve(
  process.argv[2] || process.env.MEHFIL_REPLAY_AUDIO || defaultAudio,
);

if (!existsSync(audioPath)) {
  process.stderr.write(
    `Replay audio is missing. Pass an MP3 path: pnpm run test:sync-replay -- /path/to/song.mp3\n`,
  );
  process.exit(1);
}
if (!/\.mp3$/i.test(audioPath) || statSync(audioPath).size > 10 * 1024 * 1024) {
  process.stderr.write('Replay audio must be an MP3 no larger than 10 MB.\n');
  process.exit(1);
}

const artifactDirectory = resolve('.claude/artifacts/sync-replay');
mkdirSync(artifactDirectory, { recursive: true });
process.stdout.write(`Replaying local audio: ${basename(audioPath)}\n`);

const playwright = spawnSync(
  process.execPath,
  [
    resolve('node_modules/@playwright/test/cli.js'),
    'test',
    'test/browser/sync-replay.spec.ts',
    '--project=desktop-chromium',
  ],
  {
    cwd: process.cwd(),
    stdio: 'inherit',
    env: {
      ...process.env,
      MINIMAX_API_TOKEN: '',
      MEHFIL_REPLAY_AUDIO: audioPath,
      MEHFIL_REPLAY_VIDEO_DIR: artifactDirectory,
    },
  },
);
if (playwright.status !== 0) process.exit(playwright.status ?? 1);

const proof = join(artifactDirectory, 'sync-replay-proof.webm');
const concatFile = join(artifactDirectory, 'concat.txt');
writeFileSync(
  concatFile,
  ['host.webm', 'listener.webm', 'shared.webm']
    .map((name) => `file '${join(artifactDirectory, name)}'`)
    .join('\n'),
);
const ffmpeg = spawnSync(
  'ffmpeg',
  [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'concat',
    '-safe',
    '0',
    '-i',
    concatFile,
    '-c',
    'copy',
    proof,
  ],
  { stdio: 'inherit' },
);

if (ffmpeg.status === 0) process.stdout.write(`Replay proof: ${proof}\n`);
else
  process.stdout.write(
    `Replay passed. Separate videos are in ${artifactDirectory}\n`,
  );

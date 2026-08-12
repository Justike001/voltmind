import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, symlinkSync, mkdtempSync } from 'fs';
import { join, basename } from 'path';
import { createHash } from 'crypto';
import { extname } from 'path';
import { tmpdir } from 'os';
import { collectFiles, runFiles } from '../src/commands/files.ts';

const TMP = join(import.meta.dir, '.tmp-files-test');

// These functions are not exported from files.ts, so we reimplement and test
// the logic patterns to ensure correctness. If they ever get exported, switch
// to direct imports.

const MIME_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.mp4': 'video/mp4', '.m4a': 'audio/mp4',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.heic': 'image/heic',
  '.tiff': 'image/tiff', '.tif': 'image/tiff', '.dng': 'image/x-adobe-dng',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function getMimeType(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase();
  return MIME_TYPES[ext] || null;
}

function fileHash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function createFilesHome() {
  const home = mkdtempSync(join(tmpdir(), 'voltmind-files-home-'));
  const storageRoot = join(home, 'storage');
  const configDir = join(home, '.voltmind');
  mkdirSync(configDir, { recursive: true });
  writeFileSync(join(configDir, 'config.json'), JSON.stringify({
    engine: 'pglite',
    database_path: join(home, 'brain.db'),
    storage: {
      backend: 'local',
      bucket: 'brain-files',
      localPath: storageRoot,
    },
  }));
  return { home, storageRoot };
}

async function withVoltmindHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
  const oldHome = process.env.VOLTMIND_HOME;
  const oldDatabaseUrl = process.env.VOLTMIND_DATABASE_URL;
  const oldDatabaseUrlGeneric = process.env.DATABASE_URL;
  process.env.VOLTMIND_HOME = home;
  delete process.env.VOLTMIND_DATABASE_URL;
  delete process.env.DATABASE_URL;
  try {
    return await fn();
  } finally {
    if (oldHome === undefined) delete process.env.VOLTMIND_HOME;
    else process.env.VOLTMIND_HOME = oldHome;
    if (oldDatabaseUrl === undefined) delete process.env.VOLTMIND_DATABASE_URL;
    else process.env.VOLTMIND_DATABASE_URL = oldDatabaseUrl;
    if (oldDatabaseUrlGeneric === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrlGeneric;
  }
}

async function captureStdout<T>(fn: () => Promise<T> | T): Promise<{ stdout: string; result: T }> {
  const oldLog = console.log;
  const lines: string[] = [];
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(' '));
  };
  try {
    const result = await fn();
    return { stdout: lines.join('\n'), result };
  } finally {
    console.log = oldLog;
  }
}

function trySymlink(target: string, path: string): boolean {
  try {
    symlinkSync(target, path);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EACCES') return false;
    throw err;
  }
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true });
  mkdirSync(join(TMP, 'subdir'), { recursive: true });
  mkdirSync(join(TMP, '.hidden'), { recursive: true });
  writeFileSync(join(TMP, 'photo.jpg'), 'fake-jpg');
  writeFileSync(join(TMP, 'doc.pdf'), 'fake-pdf');
  writeFileSync(join(TMP, 'notes.md'), '# Markdown');
  writeFileSync(join(TMP, 'data.csv'), 'a,b,c');
  writeFileSync(join(TMP, 'subdir', 'nested.png'), 'fake-png');
  writeFileSync(join(TMP, '.hidden', 'secret.txt'), 'hidden');
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe('getMimeType', () => {
  test('returns correct MIME for .jpg', () => {
    expect(getMimeType('photo.jpg')).toBe('image/jpeg');
  });

  test('returns correct MIME for .jpeg', () => {
    expect(getMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  test('returns correct MIME for .png', () => {
    expect(getMimeType('image.png')).toBe('image/png');
  });

  test('returns correct MIME for .pdf', () => {
    expect(getMimeType('doc.pdf')).toBe('application/pdf');
  });

  test('returns correct MIME for .mp4', () => {
    expect(getMimeType('video.mp4')).toBe('video/mp4');
  });

  test('returns correct MIME for .svg', () => {
    expect(getMimeType('icon.svg')).toBe('image/svg+xml');
  });

  test('handles uppercase extensions via toLowerCase', () => {
    expect(getMimeType('PHOTO.JPG')).toBe('image/jpeg');
    expect(getMimeType('doc.PDF')).toBe('application/pdf');
  });

  test('returns null for unknown extensions', () => {
    expect(getMimeType('data.csv')).toBeNull();
    expect(getMimeType('script.ts')).toBeNull();
    expect(getMimeType('readme.md')).toBeNull();
  });

  test('returns null for files without extension', () => {
    expect(getMimeType('Makefile')).toBeNull();
  });

  test('handles .docx and .xlsx', () => {
    expect(getMimeType('report.docx')).toContain('wordprocessingml');
    expect(getMimeType('sheet.xlsx')).toContain('spreadsheetml');
  });

  test('handles .heic (iPhone photos)', () => {
    expect(getMimeType('IMG_0001.heic')).toBe('image/heic');
  });

  test('handles .dng (raw photos)', () => {
    expect(getMimeType('RAW_001.dng')).toBe('image/x-adobe-dng');
  });
});

describe('fileHash', () => {
  test('produces consistent SHA-256 hash', () => {
    const content = Buffer.from('hello world');
    const hash1 = fileHash(content);
    const hash2 = fileHash(content);
    expect(hash1).toBe(hash2);
    expect(hash1).toHaveLength(64); // SHA-256 hex = 64 chars
  });

  test('different content produces different hash', () => {
    const hash1 = fileHash(Buffer.from('hello'));
    const hash2 = fileHash(Buffer.from('world'));
    expect(hash1).not.toBe(hash2);
  });

  test('empty content produces valid hash', () => {
    const hash = fileHash(Buffer.from(''));
    expect(hash).toHaveLength(64);
  });
});

describe('collectFiles (production import)', () => {
  test('finds non-markdown files', () => {
    const files = collectFiles(TMP);
    const basenames = files.map(f => basename(f));
    expect(basenames).toContain('photo.jpg');
    expect(basenames).toContain('doc.pdf');
    expect(basenames).toContain('data.csv');
  });

  test('skips .md files', () => {
    const files = collectFiles(TMP);
    const mdFiles = files.filter(f => f.endsWith('.md'));
    expect(mdFiles).toHaveLength(0);
  });

  test('skips hidden directories', () => {
    const files = collectFiles(TMP);
    const hiddenFiles = files.filter(f => f.includes('.hidden'));
    expect(hiddenFiles).toHaveLength(0);
  });

  test('recurses into subdirectories', () => {
    const files = collectFiles(TMP);
    const nested = files.filter(f => f.includes('subdir'));
    expect(nested.length).toBeGreaterThan(0);
  });

  test('returns sorted paths', () => {
    const files = collectFiles(TMP);
    const sorted = [...files].sort();
    expect(files).toEqual(sorted);
  });

  test('collectFiles skips symlinks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'voltmind-symlink-'));
    try {
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      if (!trySymlink('/etc/passwd', join(tmpDir, 'evil.txt'))) return;
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('evil.txt');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('collectFiles skips broken symlinks', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'voltmind-broken-'));
    try {
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      if (!trySymlink('/nonexistent/path', join(tmpDir, 'broken.txt'))) return;
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('broken.txt');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('collectFiles skips node_modules', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'voltmind-nodemod-'));
    try {
      mkdirSync(join(tmpDir, 'node_modules'));
      writeFileSync(join(tmpDir, 'node_modules', 'pkg.js'), 'x');
      writeFileSync(join(tmpDir, 'real.txt'), 'content');
      const files = collectFiles(tmpDir);
      expect(files.map(f => basename(f))).toContain('real.txt');
      expect(files.map(f => basename(f))).not.toContain('pkg.js');
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('runFiles migration lifecycle', () => {
  test('mirror uploads files and redirect replaces them with pointers', async () => {
    const { home, storageRoot } = createFilesHome();
    const dir = join(home, 'source');
    try {
      mkdirSync(join(dir, 'sub'), { recursive: true });
      writeFileSync(join(dir, 'photo.jpg'), 'fake-jpg');
      writeFileSync(join(dir, 'sub', 'doc.pdf'), 'fake-pdf');
      writeFileSync(join(dir, 'note.md'), '# stays local');

      await withVoltmindHome(home, async () => {
        await captureStdout(() => runFiles(null as never, ['mirror', dir]));
        expect(existsSync(join(dir, '.supabase'))).toBe(true);
        expect(readFileSync(join(storageRoot, 'photo.jpg'), 'utf8')).toBe('fake-jpg');
        expect(readFileSync(join(storageRoot, 'sub', 'doc.pdf'), 'utf8')).toBe('fake-pdf');

        await captureStdout(() => runFiles(null as never, ['redirect', dir]));
        expect(existsSync(join(dir, 'photo.jpg'))).toBe(false);
        expect(existsSync(join(dir, 'photo.jpg.redirect.yaml'))).toBe(true);
        expect(existsSync(join(dir, 'sub', 'doc.pdf'))).toBe(false);
        expect(existsSync(join(dir, 'sub', 'doc.pdf.redirect.yaml'))).toBe(true);
        expect(existsSync(join(dir, 'note.md'))).toBe(true);
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('clean removes redirect breadcrumbs after confirmation', async () => {
    const { home } = createFilesHome();
    const dir = join(home, 'source');
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'photo.jpg.redirect.yaml'), 'target: supabase://brain-files/photo.jpg\n');
      writeFileSync(join(dir, 'note.md'), '# stays local');

      await withVoltmindHome(home, async () => {
        await captureStdout(() => runFiles(null as never, ['clean', dir, '--yes']));
      });

      expect(existsSync(join(dir, 'photo.jpg.redirect.yaml'))).toBe(false);
      expect(existsSync(join(dir, 'note.md'))).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  test('upload-raw keeps small non-media files in git without requiring a DB', async () => {
    const { home } = createFilesHome();
    const file = join(home, 'raw.txt');
    try {
      writeFileSync(file, 'small text');
      const { stdout } = await withVoltmindHome(home, () =>
        captureStdout(() => runFiles(null as never, ['upload-raw', file, '--page', 'inbox/raw']))
      );
      const result = JSON.parse(stdout) as { success: boolean; storage: string; path: string };
      expect(result.success).toBe(true);
      expect(result.storage).toBe('git');
      expect(result.path).toBe(file);
      expect(existsSync(file + '.redirect.yaml')).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

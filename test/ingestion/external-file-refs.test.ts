import { describe, expect, test } from 'bun:test';
import {
  externalFileIdentity,
  normalizeExternalFileRefs,
  withExternalFileRefsProjection,
  fileRefsFrontmatter,
} from '../../src/core/external-file-refs.ts';

const ref = {
  schema_version: 1 as const,
  provider: 'microsoft' as const,
  service: 'sharepoint' as const,
  tenant_id: 'tenant-a',
  drive_id: 'drive-a',
  item_id: 'item-a',
  name: 'FY27 Planning.pptx',
  display_path: '/Shared Documents/Planning/FY27 Planning.pptx',
  web_url: 'https://tenant.sharepoint.com/sites/planning/Shared%20Documents/FY27%20Planning.pptx',
  mime_type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  e_tag: 'etag-1',
  occurrence: {
    platform: 'teams' as const,
    relation: 'attachment' as const,
    conversation_id: 'chat-a',
    message_id: 'message-a',
    source_uri: 'https://teams.microsoft.com/l/message/message-a',
  },
};

const raidriveRef = {
  schema_version: 1 as const,
  provider: 'filesystem' as const,
  service: 'raidrive' as const,
  root_key: 'Synology-Public',
  relative_path: 'Public/Planning/FY27 Budget.xlsx',
  open_path: 'Z:\\Public\\Planning\\FY27 Budget.xlsx',
  name: 'FY27 Budget.xlsx',
  availability: 'accessible' as const,
};

describe('external file references', () => {
  test('normalizes a stable SharePoint identity and occurrence', () => {
    const [normalized] = normalizeExternalFileRefs([ref]);
    expect(normalized?.provider).toBe('microsoft');
    if (!normalized || normalized.provider !== 'microsoft') throw new Error('expected Microsoft ref');
    expect(normalized?.drive_id).toBe('drive-a');
    expect(normalized?.item_id).toBe('item-a');
    expect(normalized?.occurrence?.relation).toBe('attachment');
    expect(normalized?.availability).toBe('unverified');
  });

  test('rejects signed or credential-bearing URLs', () => {
    expect(() => normalizeExternalFileRefs([{ ...ref, web_url: 'https://example.test/file?sig=secret' }])).toThrow();
  });

  test('renders a searchable managed block and replaces it idempotently', () => {
    const [normalized] = normalizeExternalFileRefs([ref]);
    const first = withExternalFileRefsProjection('# Message', [normalized!]);
    const second = withExternalFileRefsProjection(first, [normalized!]);
    expect(second).toBe(first);
    expect(second).toContain('FY27 Planning.pptx');
    expect(second).toContain('/Shared Documents/Planning/FY27 Planning.pptx');
    expect(second.match(/voltmind:file-refs:begin/g)?.length).toBe(1);
  });

  test('frontmatter projection excludes occurrence payload', () => {
    const [normalized] = normalizeExternalFileRefs([ref]);
    const frontmatter = fileRefsFrontmatter([normalized!]);
    expect(frontmatter.file_refs_version).toBe(1);
    expect(JSON.stringify(frontmatter)).not.toContain('message-a');
  });

  test('normalizes a RaiDrive reference without using the user-specific UNC host as identity', () => {
    const [normalized] = normalizeExternalFileRefs([raidriveRef]);
    expect(normalized?.provider).toBe('filesystem');
    if (!normalized || normalized.provider !== 'filesystem') throw new Error('expected filesystem ref');
    expect(normalized.root_key).toBe('synology-public');
    expect(normalized.relative_path).toBe('Public/Planning/FY27 Budget.xlsx');
    expect(normalized.open_path).toBe('Z:\\Public\\Planning\\FY27 Budget.xlsx');
    const projected = withExternalFileRefsProjection('# Shared file', [normalized]);
    expect(projected).toContain('synology-public');
    expect(projected).toContain('synology-public:/Public/Planning/FY27 Budget.xlsx');
    expect(projected).not.toContain('Z:\\');
  });

  test('accepts a server-safe RaiDrive reference without an open_path', () => {
    const [normalized] = normalizeExternalFileRefs([{
      ...raidriveRef,
      open_path: undefined,
    }]);
    expect(normalized?.provider).toBe('filesystem');
    if (!normalized || normalized.provider !== 'filesystem') throw new Error('expected filesystem ref');
    expect(normalized.open_path).toBeUndefined();
    expect(JSON.stringify(fileRefsFrontmatter([normalized]))).not.toContain('open_path');
  });

  test('rejects absolute or traversal paths in RaiDrive relative_path', () => {
    expect(() => normalizeExternalFileRefs([{ ...raidriveRef, relative_path: '../secret.txt' }])).toThrow(/traversal/);
    expect(() => normalizeExternalFileRefs([{ ...raidriveRef, relative_path: 'Z:\\secret.txt' }])).toThrow(/relative to root_key/);
  });

  test('uses a provider file ID across RaiDrive rename and move updates', () => {
    const [before, after] = normalizeExternalFileRefs([
      { ...raidriveRef, file_id: 'synology-file-42' },
      {
        ...raidriveRef,
        file_id: 'synology-file-42',
        name: 'FY27 Final Budget.xlsx',
        relative_path: 'Archive/FY27 Final Budget.xlsx',
        open_path: '\\\\RaiDrive-AnotherUser\\Synology\\Archive\\FY27 Final Budget.xlsx',
      },
    ]);
    expect(externalFileIdentity(before!, 'source-a')).toBe(externalFileIdentity(after!, 'source-a'));
  });

  test('falls back to path identity when RaiDrive has no stable file ID', () => {
    const [before, after] = normalizeExternalFileRefs([
      raidriveRef,
      {
        ...raidriveRef,
        relative_path: 'Archive/FY27 Budget.xlsx',
        open_path: 'Z:\\Archive\\FY27 Budget.xlsx',
      },
    ]);
    expect(externalFileIdentity(before!, 'source-a')).not.toBe(externalFileIdentity(after!, 'source-a'));
  });
});

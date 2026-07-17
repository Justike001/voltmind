# Storage Tiering: db-tracked vs db-only directories

## Overview

VoltMind supports storage tiering to separate version-controlled content from bulk machine-generated data. This prevents git repositories from becoming bloated with large amounts of automatically generated content while still preserving it in the database.

> Note on naming: prior to v0.22.11 the keys were `git_tracked` / `supabase_only`. The canonical names are now `db_tracked` / `db_only` (engine-agnostic — works on both PGLite and Postgres). The deprecated keys still load with a once-per-process warning. Run `voltmind doctor --fix` for an automated rename when that path lands.

## Configuration

Add a `storage` section to `voltmind.yml` in the active source vault root. For
the local-first Personal Brain, this is the directory returned by
`voltmind sources current` (for example, `<source-vault>/voltmind.yml`), not
the VoltMind runtime checkout unless that checkout is itself the source vault:

```yaml
storage:
  # Durable, human-reviewed knowledge, governance, and audit records.
  db_tracked:
    - artifacts/
    - companies/
    - concepts/
    - contribution/
    - ideas/
    - meetings/
    - orgs/
    - people/
    - policy/
    - projects/
    - state/actions/
    - state/commitments/
    - state/decisions/
    - state/risks/
    - templates/
    - workstreams/

  # Private, temporary, raw, or reproducibly derived material. This is a Git
  # visibility policy, not an access-control or encryption boundary.
  db_only:
    - archive/
    - daily/
    - inbox/
    - private/
    - sources/teams/
    - sources/meetings/
    - sources/emails/
    - sources/calendar/
    - state/indexes/
```

All pages are still indexed in the brain database and remain searchable in
both tiers. The tier only controls the file/Git policy, automatic `.gitignore`
management, storage-status accounting, and `voltmind export --restore-only`.

The Personal Brain schema makes the distinction explicit:

- `archive/` contains historical/dead pages and is retained in the database,
  not Git history.
- `sources/` is a raw-input namespace with precise child-directory rules:
  `sources/teams/` holds Teams evidence, `sources/meetings/` is reserved for
  independent meeting recording/transcription output, `sources/emails/` holds
  email evidence, and `sources/calendar/` holds calendar evidence. All four
  source tiers are `db_only`; `daily/`, `inbox/`, `private/`, and
  `state/indexes/` are likewise private, transient, or reproducibly derived.
- `state/actions/`, `state/commitments/`, `state/decisions/`, and
  `state/risks/` are small operational records with owners and evidence, not
  disposable generated indexes, so they are `db_tracked`.

Because these schema directories are `db_only`, retain their README resolver
files with explicit `.gitignore` negation rules after VoltMind's managed block:

```gitignore
!archive/
archive/*
!archive/README.md
!sources/
!sources/README.md
!sources/teams/
sources/teams/*
!sources/teams/README.md
!sources/meetings/
sources/meetings/*
!sources/meetings/README.md
!sources/emails/
sources/emails/*
!sources/emails/README.md
!sources/calendar/
sources/calendar/*
!sources/calendar/README.md
```

Add equivalent README exceptions for any `db_only` directory whose README is
part of the schema pack. `db_only` keeps content out of Git; it does not encrypt
it, restrict local access, or change its visibility/promotion policy.

Path requirements:

- Each directory must end with `/` for canonical form. The validator auto-normalizes missing trailing slashes (one-time info note shows what changed).
- A directory cannot appear in both tiers — that's a tier-overlap error and `loadStorageConfig` throws `StorageConfigError`. Edit `voltmind.yml` to remove the overlap and try again.

## Behavior Changes

### 1. `voltmind sync` — automatic .gitignore management

When storage configuration is present, `voltmind sync` automatically manages `.gitignore` entries on every successful sync:

- Adds missing `db_only` directory patterns to `.gitignore`.
- Idempotent — re-running adds no duplicate entries.
- Stable comment header so the managed block is grep-able.
- Skipped on `--dry-run` (don't mutate disk in preview mode).
- Skipped on `blocked_by_failures` status (sync state is inconsistent).
- Skipped when the repo is a git submodule (`.git` is a file, not a directory) — submodule .gitignore changes don't survive parent updates. A warning explains.
- Skipped entirely when `VOLTMIND_NO_GITIGNORE=1` is set (escape hatch for shared-repo setups where a maintainer wants voltmind to leave .gitignore alone).
- Failures (write permission denied, etc.) are caught and logged, never crash sync.

Example `.gitignore` addition:

```gitignore
# Auto-managed by voltmind (db_only directories)
media/x/
media/articles/
sources/meetings/
```

### 2. `voltmind export --restore-only` — repopulate missing db_only files

```bash
# Restore only missing db_only files from the database.
voltmind export --restore-only --repo /path/to/brain

# Filter by page type.
voltmind export --restore-only --type media --repo /path/to/brain

# Filter by slug prefix.
voltmind export --restore-only --slug-prefix media/x/ --repo /path/to/brain

# Combine filters.
voltmind export --restore-only --type media --slug-prefix media/x/ --repo /path/to/brain
```

The `--restore-only` flag:

- Resolves repoPath via the chain `--repo` → typed `sources.getDefault()` → hard error.
  Never falls through to the current directory.
- Only exports pages that match `db_only` patterns AND are missing from disk.
- Ideal for container restart recovery and fresh clones.

### 3. `voltmind storage status` — storage-tier health dashboard

```bash
# Human-readable status.
voltmind storage status --repo /path/to/brain

# JSON output for scripts and orchestrators.
voltmind storage status --repo /path/to/brain --json
```

Output includes:

- Total page counts by storage tier.
- Disk usage breakdown by tier.
- Missing files that need restoration (top 10 shown; full list in `--json`).
- Configuration validation warnings.
- Current tier directory listing.

Example output:

```
Storage Status
==============

Repository: /data/brain
Total pages: 15,243

Storage Tiers:
-------------
DB tracked:     2,156 pages
DB only:        12,887 pages
Unspecified:    200 pages

Disk Usage:
-----------
DB tracked:     45.2 MB
DB only:        2.1 GB

Missing Files (need restore):
-----------------------------
  media/x/tweet-1234567890
  media/x/tweet-0987654321
  ... and 47 more

Use: voltmind export --restore-only --repo "/data/brain"

Configuration:
--------------
DB tracked directories:
  - people/
  - companies/
  - deals/

DB-only directories:
  - media/x/
  - media/articles/
  - sources/meetings/
```

## Validation

`loadStorageConfig` runs `normalizeAndValidateStorageConfig` after parsing:

- Auto-fixes (silent, with one-time info note showing what changed):
  - Missing trailing `/` is added: `'media/x'` → `'media/x/'`.
- Throws `StorageConfigError` (caller sees a clean exit-1 with actionable message):
  - Same directory in both `db_tracked` and `db_only` (ambiguous routing).

## Use cases

### Brain repository scaling

Perfect for brain repositories crossing 50K-200K+ files where:

- Core knowledge (people, companies, deals) remains git-tracked.
- Bulk data (tweets, articles, transcripts) moves to db_only.
- Development stays fast with smaller git repos.
- Full data remains available via the database.

### Container-based deployments

Essential for ephemeral container environments:

- Git repo contains only essential files.
- Container restarts don't lose db_only data.
- `voltmind export --restore-only` quickly restores bulk files when needed.
- Local disk acts as a cache layer.

### Multi-environment consistency

Enables consistent data access across environments:

- Development: small git clone, restore bulk data on demand.
- Production: full dataset via the database, selective local caching.
- CI/CD: fast tests with git-tracked data only.

## Migration strategy

1. **Assess current repository**: use `voltmind storage status` to understand current distribution.
2. **Plan directory structure**: identify which directories should be db_tracked vs db_only.
3. **Create `voltmind.yml`**: add storage configuration to the repository root.
4. **Test with dry-run**: `voltmind sync --dry-run` to verify behavior; `.gitignore` is NOT touched on dry-run.
5. **Run a real sync**: `voltmind sync` updates `.gitignore` automatically on success.
6. **Verify restore**: test `voltmind export --restore-only --repo .` against a small db_only directory.

## Best practices

- **Directory naming**: end storage paths with `/` (canonical form). The validator normalizes if you forget.
- **Start small**: begin with clearly machine-generated directories in `db_only`.
- **Address validation errors**: tier overlap is an error, not a warning. Fix it before sync.
- **Test restore**: regularly test `--restore-only` in staging environments.
- **Document decisions**: comment your `voltmind.yml` to explain tier choices.

## PGLite engine note

On the PGLite engine (voltmind's local-only embedded Postgres), the "DB" your db_only pages live in IS the local file voltmind uses for everything else. The `.gitignore` housekeeping still helps (keeps bulk content out of git history), but the offload-to-DB promise is technically vacuous. A once-per-process soft-warn explains when the engine is detected. To get full tiering, migrate to Postgres with `voltmind migrate --to supabase`.

## Compatibility

- **Backward compatible**: systems without `voltmind.yml` work unchanged.
- **Progressive enhancement**: add configuration when needed.
- **Database unchanged**: all data remains in Postgres regardless of tier.
- **Existing workflows**: all existing `sync` and `export` behavior preserved.
- **Deprecated keys**: `git_tracked` / `supabase_only` still load with a once-per-process warning.

import type { Operation } from './operations.ts';

export const VOLTMIND_MVP_CLI_COMMANDS = new Set([
  'init',
  'config',
  'storage',
  'sources',
  'status',
  'doctor',
  'apply-migrations',
  'get',
  'put',
  'delete',
  'restore',
  'list',
  'search',
  'query',
  'ask',
  'import',
  'capture',
  'sync',
  'embed',
  'tags',
  'tag',
  'untag',
  'link',
  'unlink',
  'backlinks',
  'graph',
  'timeline',
  'timeline-add',
  'serve',
  'call',
  'jobs',
  'stats',
  'health',
  'history',
  'version',
]);

export const VOLTMIND_MVP_OPERATION_NAMES = new Set([
  'get_page',
  'put_page',
  'delete_page',
  'restore_page',
  'list_pages',
  'search',
  'query',
  'get_tags',
  'add_tag',
  'remove_tag',
  'add_link',
  'remove_link',
  'get_links',
  'get_backlinks',
  'traverse_graph',
  'add_timeline_entry',
  'get_timeline',
  'get_stats',
  'get_health',
  'get_brain_identity',
  'get_status_snapshot',
  'run_doctor',
  'get_versions',
  'sync_brain',
  'put_raw_data',
  'get_raw_data',
  'get_job',
  'list_jobs',
  'cancel_job',
  'get_job_progress',
  'sources_add',
  'sources_list',
  'sources_remove',
  'sources_status',
]);

const VOLTMIND_MVP_OPERATION_DESCRIPTIONS: Record<string, string> = {
  get_page: 'Read a VoltMind page by slug.',
  put_page: 'Write or update a VoltMind markdown page, then refresh chunks, embeddings, tags, links, and timeline entries.',
  delete_page: 'Soft-delete a VoltMind page so it is hidden from normal reads and search.',
  restore_page: 'Restore a soft-deleted VoltMind page.',
  list_pages: 'List VoltMind pages with optional type, tag, recency, and limit filters.',
  search: 'Keyword search over VoltMind pages using full-text search.',
  query: 'Hybrid search over VoltMind pages using vector, keyword, and optional multi-query expansion.',
  add_tag: 'Add a tag to a VoltMind page.',
  remove_tag: 'Remove a tag from a VoltMind page.',
  get_tags: 'List tags for a VoltMind page.',
  add_link: 'Create a typed link between two VoltMind pages.',
  remove_link: 'Remove a link between two VoltMind pages.',
  get_links: 'List outgoing links from a VoltMind page.',
  get_backlinks: 'List incoming links to a VoltMind page.',
  traverse_graph: 'Traverse the VoltMind page graph from a starting page.',
  add_timeline_entry: 'Add a timeline entry to a VoltMind page.',
  get_timeline: 'Read timeline entries for a VoltMind page.',
  get_stats: 'Return basic VoltMind page, chunk, embedding, link, tag, and timeline counts.',
  get_health: 'Return basic VoltMind health signals such as embedding coverage and stale pages.',
  run_doctor: 'Run VoltMind runtime health checks.',
  get_versions: 'List version history for a VoltMind page.',
  get_brain_identity: 'Return VoltMind runtime identity and basic counters.',
  get_status_snapshot: 'Return a compact VoltMind runtime status snapshot.',
  sync_brain: 'Sync a local source repository into VoltMind.',
  put_raw_data: 'Store raw source data for a VoltMind page as provenance for later citation or enrichment review.',
  get_raw_data: 'Retrieve raw source data attached to a VoltMind page.',
  get_job: 'Get VoltMind job status and details by ID.',
  list_jobs: 'List VoltMind jobs with optional filters.',
  cancel_job: 'Cancel a waiting, active, or delayed VoltMind job.',
  get_job_progress: 'Get structured progress for a running VoltMind job.',
  sources_add: 'Register a local source path with VoltMind.',
  sources_list: 'List registered VoltMind sources.',
  sources_remove: 'Remove a VoltMind source and its indexed pages.',
  sources_status: 'Return diagnostic status for one VoltMind source.',
};

const VOLTMIND_MVP_OPERATION_PARAMS: Record<string, string[]> = {
  query: ['query', 'limit', 'offset', 'expand', 'detail', 'source_id'],
  sync_brain: ['repo', 'dry_run', 'full', 'no_pull', 'no_embed'],
  sources_add: ['id', 'name', 'path'],
  sources_remove: ['id', 'confirm_destructive', 'dry_run', 'keep_storage'],
};

export function isVoltMindMvpCliCommand(name: string): boolean {
  return VOLTMIND_MVP_CLI_COMMANDS.has(name);
}

export function isVoltMindMvpOperationName(name: string): boolean {
  return VOLTMIND_MVP_OPERATION_NAMES.has(name);
}

export function filterVoltMindMvpOperations(ops: Operation[]): Operation[] {
  return ops
    .filter(op => isVoltMindMvpOperationName(op.name))
    .map(op => {
      const description = VOLTMIND_MVP_OPERATION_DESCRIPTIONS[op.name];
      const paramNames = VOLTMIND_MVP_OPERATION_PARAMS[op.name];
      const params = paramNames
        ? Object.fromEntries(paramNames.flatMap(name => op.params[name] ? [[name, op.params[name]]] : []))
        : op.params;
      return description || params !== op.params ? { ...op, ...(description ? { description } : {}), params } : op;
    });
}

export function voltMindMvpUnavailableMessage(name: string): string {
  return `voltmind ${name} is not included in the VoltMind MVP runtime yet. ` +
    'The inherited GBrain implementation is kept in the repository for a later phase.';
}

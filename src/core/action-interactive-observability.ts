import { existsSync } from 'fs';
import { appendFile, mkdir, readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';

export interface InteractiveActionEvent {
  ts: string;
  event: string;
  run_id?: number;
  source_id?: string;
  slug?: string;
  message?: string;
  [key: string]: unknown;
}

export async function appendInteractiveActionEvent(
  eventsPath: string | null | undefined,
  event: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  if (!eventsPath) return;
  const row: InteractiveActionEvent = {
    ts: new Date().toISOString(),
    event,
    ...fields,
  };
  try {
    await mkdir(dirname(eventsPath), { recursive: true });
    await appendFile(eventsPath, JSON.stringify(row) + '\n', 'utf-8');
  } catch {
    // Observability must never block action execution or writeback.
  }
}

export async function writeInteractiveJsonFile(
  path: string | null | undefined,
  value: unknown,
): Promise<void> {
  if (!path) return;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n', 'utf-8');
  } catch {
    // Best-effort diagnostic file.
  }
}

export async function readInteractiveActionEvents(
  eventsPath: string | null | undefined,
  limit = 20,
): Promise<InteractiveActionEvent[]> {
  if (!eventsPath || !existsSync(eventsPath)) return [];
  try {
    const raw = await readFile(eventsPath, 'utf-8');
    const lines = raw.split(/\r?\n/).filter(Boolean).slice(-Math.max(1, Math.min(limit, 100)));
    const events: InteractiveActionEvent[] = [];
    for (const line of lines) {
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && typeof parsed.event === 'string') {
          events.push(parsed as InteractiveActionEvent);
        }
      } catch {
        events.push({
          ts: new Date(0).toISOString(),
          event: 'unparseable_event',
          message: line.slice(0, 500),
        });
      }
    }
    return events;
  } catch {
    return [];
  }
}

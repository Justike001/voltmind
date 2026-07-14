/** Local control plane for an operator-requested Autopilot pause. */
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import { voltmindPath } from '../config.ts';

export interface AutopilotPauseRequest {
  action: 'pause';
  requested_at: string;
  /** Explicit operator authorization to terminate a drain that exceeds its grace window. */
  force?: boolean;
}

export function autopilotPauseRequestPath(): string {
  return join(voltmindPath('runtime'), 'autopilot-pause.json');
}

export function requestAutopilotPause(opts: { force?: boolean } = {}): AutopilotPauseRequest {
  const request: AutopilotPauseRequest = {
    action: 'pause',
    requested_at: new Date().toISOString(),
    ...(opts.force === true ? { force: true } : {}),
  };
  const path = autopilotPauseRequestPath();
  mkdirSync(voltmindPath('runtime'), { recursive: true });
  writeFileSync(path, JSON.stringify(request, null, 2) + '\n', 'utf-8');
  return request;
}

export function readAutopilotPauseRequest(): AutopilotPauseRequest | null {
  const path = autopilotPauseRequestPath();
  if (!existsSync(path)) return null;
  try {
    const request = JSON.parse(readFileSync(path, 'utf-8')) as Partial<AutopilotPauseRequest>;
    return request.action === 'pause' && typeof request.requested_at === 'string'
      ? { action: 'pause', requested_at: request.requested_at, ...(request.force === true ? { force: true } : {}) }
      : null;
  } catch {
    // A malformed control file must fail safe: it does not stop a service.
    return null;
  }
}

export function clearAutopilotPauseRequest(): boolean {
  const path = autopilotPauseRequestPath();
  if (!existsSync(path)) return false;
  try {
    unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

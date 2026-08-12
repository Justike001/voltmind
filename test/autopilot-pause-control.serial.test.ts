import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  autopilotPauseRequestPath,
  clearAutopilotPauseRequest,
  readAutopilotPauseRequest,
  requestAutopilotPause,
} from '../src/core/autopilot/pause-control.ts';

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'voltmind-pause-control-'));
  previousHome = process.env.VOLTMIND_HOME;
  process.env.VOLTMIND_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.VOLTMIND_HOME;
  else process.env.VOLTMIND_HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Autopilot pause control', () => {
  test('writes a local pause request that a running daemon can observe', () => {
    expect(readAutopilotPauseRequest()).toBeNull();
    const request = requestAutopilotPause();
    expect(readAutopilotPauseRequest()).toEqual(request);
    expect(autopilotPauseRequestPath()).toContain('autopilot-pause.json');
  });

  test('clears the request before a subsequent --start', () => {
    requestAutopilotPause();
    expect(clearAutopilotPauseRequest()).toBe(true);
    expect(readAutopilotPauseRequest()).toBeNull();
    expect(clearAutopilotPauseRequest()).toBe(false);
  });

  test('records force only when the operator explicitly requests it', () => {
    expect(requestAutopilotPause()).not.toHaveProperty('force');
    expect(requestAutopilotPause({ force: true })).toMatchObject({ action: 'pause', force: true });
    expect(readAutopilotPauseRequest()).toMatchObject({ action: 'pause', force: true });
  });
});

/**
 * Unit tests for createWindowsTaskXml() — the pure Task Scheduler XML
 * generator (spec §3.2 / §16.1).
 */

import { describe, test, expect } from 'bun:test';
import { createWindowsTaskXml, DEFAULT_WINDOWS_TASK_NAME } from '../src/core/autopilot/windows-task-xml.ts';

describe('createWindowsTaskXml', () => {
  const baseInput = {
    taskName: DEFAULT_WINDOWS_TASK_NAME,
    executable: 'C:\\Program Files\\voltmind\\voltmind.exe',
    arguments: ['autopilot', '--repo', 'C:\\Users\\alice\\brain repo'],
    workingDirectory: 'C:\\Users\\alice\\brain repo',
    recoveryStartBoundary: '2026-07-13T03:32:25.000Z',
    restartIntervalMinutes: 1,
    restartCount: 5,
  };

  test('contains a LogonTrigger that is enabled', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<LogonTrigger>');
    expect(xml).toContain('<Enabled>true</Enabled>');
  });

  test('can register the task disabled for a safe deployment window', () => {
    const xml = createWindowsTaskXml({ ...baseInput, enabled: false });
    expect(xml).toContain('<Settings>');
    expect(xml).toContain('<Enabled>false</Enabled>');
  });

  test('preserves an explicit task-control security descriptor', () => {
    const xml = createWindowsTaskXml({
      ...baseInput,
      securityDescriptor: 'O:S-1-5-21-1G:SYD:P(A;;GA;;;S-1-5-21-1)',
    });
    expect(xml).toContain('<SecurityDescriptor>O:S-1-5-21-1G:SYD:P(A;;GA;;;S-1-5-21-1)</SecurityDescriptor>');
  });

  test('does not add a repeating recovery trigger that collides with the live singleton', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).not.toContain('<CalendarTrigger>');
    expect(xml).not.toContain('<Repetition>');
  });

  test('uses LeastPrivilege run level and InteractiveToken logon', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
  });

  test('ExecutionTimeLimit is PT0S (indefinite)', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>');
  });

  test('starts missed recovery triggers when the user logs in again', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<StartWhenAvailable>true</StartWhenAvailable>');
  });

  test('MultipleInstancesPolicy is IgnoreNew (no StopExisting/Queue/Parallel)', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>');
    expect(xml).not.toContain('StopExisting');
    expect(xml).not.toContain('<Queue');
    expect(xml).not.toContain('Parallel');
  });

  test('RestartOnFailure interval is 1 minute, count is 5', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<Interval>PT1M</Interval>');
    expect(xml).toContain('<Count>5</Count>');
  });

  test('executable and arguments are separate elements (no shell concatenation)', () => {
    const xml = createWindowsTaskXml(baseInput);
    expect(xml).toContain('<Command>C:\\Program Files\\voltmind\\voltmind.exe</Command>');
    // arguments joined, repo path with space is quoted in the args element
    expect(xml).toContain('<Arguments>autopilot --repo &quot;C:\\Users\\alice\\brain repo&quot;</Arguments>');
  });

  test('XML-escapes ampersands and angle brackets in values', () => {
    const xml = createWindowsTaskXml({
      ...baseInput,
      arguments: ['autopilot', '--repo', 'C:\\a&b<c>d'],
    });
    expect(xml).toContain('&amp;');
    expect(xml).toContain('&lt;');
    expect(xml).toContain('&gt;');
    // The raw unescaped dangerous chars must not appear inside the arguments element
    expect(xml).not.toContain('<Arguments>autopilot --repo "C:\\a&b<c>d"</Arguments>');
  });

  test('handles Unicode repo path', () => {
    const xml = createWindowsTaskXml({
      ...baseInput,
      arguments: ['autopilot', '--repo', 'C:\\用户\\脑'],
    });
    expect(xml).toContain('用户');
    expect(xml).toContain('脑');
  });

  test('includes --runtime-env-file argument when present', () => {
    const xml = createWindowsTaskXml({
      ...baseInput,
      arguments: ['autopilot', '--repo', 'C:\\repo', '--runtime-env-file', 'C:\\env\\.voltmind.env'],
    });
    expect(xml).toContain('--runtime-env-file');
    expect(xml).toContain('.voltmind.env');
  });

  test('supports a native combined stdout/stderr log file argument', () => {
    const xml = createWindowsTaskXml({
      ...baseInput,
      arguments: ['autopilot', '--repo', 'C:\\repo', '--log-file', 'C:\\Users\\alice\\.voltmind\\runtime\\autopilot.log'],
    });
    expect(xml).toContain('--log-file');
    expect(xml).toContain('autopilot.log');
    expect(xml).not.toContain('powershell.exe');
  });

  test('never contains --no-worker', () => {
    const xml = createWindowsTaskXml({
      ...baseInput,
      arguments: ['autopilot', '--repo', 'C:\\repo', '--runtime-env-file', 'C:\\env.env'],
    });
    expect(xml).not.toContain('--no-worker');
  });

  test('throws on missing taskName', () => {
    expect(() => createWindowsTaskXml({ ...baseInput, taskName: '' } as never)).toThrow();
  });

  test('throws on non-positive restart interval', () => {
    expect(() => createWindowsTaskXml({ ...baseInput, restartIntervalMinutes: 0 })).toThrow();
  });
});

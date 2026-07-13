/**
 * Windows Task Scheduler XML generator (spec §3.2).
 *
 * `createWindowsTaskXml()` is a pure function: deterministic output, no side
 * effects, no shell, no localized `schtasks` text parsing. All values are
 * XML-escaped; executable and arguments are separate elements (never
 * concatenated shell strings).
 *
 * The generated task:
 *   - Logs on at user logon (LogonTrigger), current user, LeastPrivilege
 *   - Runs indefinitely (no ExecutionTimeLimit)
 *   - IgnoreNew multiple-instance policy (no concurrent autopilot)
 *   - Restart on failure 1 minute, up to `restartCount` times
 *   - No StopExisting / Queue / Parallel
 */

export interface WindowsTaskXmlInput {
  taskName: string;
  executable: string;
  arguments: string[];
  workingDirectory?: string;
  /** Windows user id (DOMAIN\user or user). Defaults to the interactive user. */
  userId?: string;
  restartIntervalMinutes: number;
  restartCount: number;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Generate Task Scheduler 1.2+ / 2.0 XML. Pure + deterministic.
 *
 * The `<Arguments>` element contains the joined argument string (Task
 * Scheduler passes executable + arguments separately, exactly like
 * CreateProcess). We join args with spaces, escaping each for the XML
 * layer only (no shell interpretation — Task Scheduler does not run the
 * arguments through a shell). Quotes are preserved as-is so paths with
 * spaces survive.
 */
export function createWindowsTaskXml(input: WindowsTaskXmlInput): string {
  if (!input.taskName) throw new Error('createWindowsTaskXml: taskName is required');
  if (!input.executable) throw new Error('createWindowsTaskXml: executable is required');
  if (input.restartCount < 0) throw new Error('createWindowsTaskXml: restartCount must be >= 0');
  if (input.restartIntervalMinutes <= 0) throw new Error('createWindowsTaskXml: restartIntervalMinutes must be > 0');

  const userIdEl = input.userId ? `<UserId>${escapeXml(input.userId)}</UserId>` : '';
  const workingDirEl = input.workingDirectory
    ? `      <WorkingDirectory>${escapeXml(input.workingDirectory)}</WorkingDirectory>`
    : '';
  const argsStr = input.arguments.map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ');

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${escapeXml(input.taskName)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      ${userIdEl}
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      ${userIdEl}
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT${input.restartIntervalMinutes}M</Interval>
      <Count>${input.restartCount}</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escapeXml(input.executable)}</Command>
      <Arguments>${escapeXml(argsStr)}</Arguments>
      ${workingDirEl}
    </Exec>
  </Actions>
</Task>`;
}

export const DEFAULT_WINDOWS_TASK_NAME = 'VoltMind Autopilot';
export const DEFAULT_RESTART_INTERVAL_MINUTES = 1;
export const DEFAULT_RESTART_COUNT = 5;

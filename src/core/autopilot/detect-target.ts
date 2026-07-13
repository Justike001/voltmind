/**
 * Install-target detection (spec §2.2).
 *
 *   win32  -> windows-task   (NEVER falls back to linux-cron)
 *   darwin -> macos
 *   linux  -> ephemeral-container | linux-systemd | linux-cron (existing)
 *
 * `--target windows-task` is an explicit override entry for testing/debugging.
 */

import { existsSync } from 'fs';
import { execSync } from 'child_process';
import {
  isInstallTarget,
  type InstallTarget,
  ALL_INSTALL_TARGETS,
  AutopilotError,
  AUTOPILOT_ERRORS,
} from './diagnostics.ts';
import type { AdapterDetectionContext, AdapterDetectionResult } from './adapter.ts';

export function detectInstallTarget(ctx: AdapterDetectionContext = { platform: process.platform, env: process.env }): AdapterDetectionResult {
  const forced = ctx.env?.VOLTMIND_AUTOPILOT_TARGET || ctx.forcedTarget;
  if (forced) {
    if (!isInstallTarget(forced)) {
      throw new AutopilotError({
        code: AUTOPILOT_ERRORS.CLI_INVOCATION_INVALID,
        stage: 'target-detection',
        message: `Unknown install target "${forced}". Allowed: ${ALL_INSTALL_TARGETS.join(', ')}.`,
      });
    }
    return { target: forced };
  }
  const warnings: string[] = [];
  if (ctx.platform === 'win32') {
    return { target: 'windows-task' };
  }
  if (ctx.platform === 'darwin') {
    return { target: 'macos' };
  }
  // Linux + ephemeral containers.
  const ephemeral = !!(
    ctx.env?.RENDER
    || ctx.env?.RAILWAY_ENVIRONMENT
    || ctx.env?.FLY_APP_NAME
    || existsSync('/.dockerenv')
  );
  if (ephemeral) return { target: 'ephemeral-container' };

  if (existsSync('/run/systemd/system')) {
    try {
      execSync('systemctl --user is-system-running', { stdio: 'pipe', timeout: 3000 });
      return { target: 'linux-systemd' };
    } catch {
      warnings.push('systemd user bus not available; falling back to cron.');
    }
  }

  return { target: 'linux-cron', warnings };
}

import type { BrainEngine } from '../core/engine.ts';
import {
  combineAdvisorReports,
  runLocalAdvisor,
  runWorkspaceAdvisor,
  type AdvisorReport,
} from '../core/advisor.ts';

export interface AdvisorCliResult { exitCode: 0 | 1 | 2; report: AdvisorReport }

function exitCode(report: AdvisorReport): 0 | 1 | 2 {
  return report.status === 'critical' ? 2 : report.status === 'warnings' ? 1 : 0;
}

function render(report: AdvisorReport): string {
  const lines = [`voltmind advisor: ${report.status}`];
  if (report.findings.length === 0) lines.push('No brain or workspace findings.');
  for (const finding of report.findings) {
    lines.push(`[${finding.severity}] ${finding.title}`);
    lines.push(`  ${finding.detail}`);
    lines.push(`  Next: ${finding.next_step.command}`);
  }
  return lines.join('\n');
}

export async function runAdvisorCli(
  engine: BrainEngine | null,
  args: string[],
  remoteBrainReport?: AdvisorReport,
): Promise<AdvisorCliResult> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log('Usage: voltmind advisor [--json]\n\nRead-only brain diagnostics plus local workspace diagnostics.');
    const report: AdvisorReport = { schema_version: 1, surface: 'combined', status: 'healthy', findings: [], diagnostics: {} };
    return { exitCode: 0, report };
  }
  const unknown = args.filter(arg => arg !== '--json');
  if (unknown.length > 0) throw new Error(`Unknown advisor option: ${unknown[0]}`);
  const report = engine
    ? await runLocalAdvisor(engine)
    : combineAdvisorReports(remoteBrainReport!, await runWorkspaceAdvisor());
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2));
  else console.log(render(report));
  return { exitCode: exitCode(report), report };
}

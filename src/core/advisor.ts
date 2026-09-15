import type { BrainEngine } from './engine.ts';
import { checkSkillTree, evaluateSkillRouting } from './skill-platform-diagnostics.ts';
import { doctorReportRemote, type DoctorReport } from '../commands/doctor.ts';

export type AdvisorSeverity = 'critical' | 'warn';

export interface AdvisorFinding {
  id: string;
  surface: 'brain' | 'workspace';
  severity: AdvisorSeverity;
  title: string;
  detail: string;
  next_step: { surface: 'host_cli' | 'local_cli'; command: string };
}

export interface AdvisorReport {
  schema_version: 1;
  surface: 'brain' | 'workspace' | 'combined';
  status: 'healthy' | 'warnings' | 'critical';
  findings: AdvisorFinding[];
  diagnostics: Record<string, unknown>;
}

function statusOf(findings: AdvisorFinding[]): AdvisorReport['status'] {
  if (findings.some(finding => finding.severity === 'critical')) return 'critical';
  return findings.length > 0 ? 'warnings' : 'healthy';
}

export async function runBrainAdvisor(
  engine: BrainEngine,
  doctor: (engine: BrainEngine) => Promise<DoctorReport> = doctorReportRemote,
): Promise<AdvisorReport> {
  const report = await doctor(engine);
  const findings = report.checks
    .filter(check => check.status !== 'ok')
    .map<AdvisorFinding>(check => ({
      id: `doctor:${check.name}`,
      surface: 'brain',
      severity: check.status === 'fail' ? 'critical' : 'warn',
      title: check.name,
      detail: check.message,
      next_step: { surface: 'host_cli', command: 'voltmind doctor --json' },
    }));
  return {
    schema_version: 1,
    surface: 'brain',
    status: statusOf(findings),
    findings,
    diagnostics: { doctor: report },
  };
}

export async function runWorkspaceAdvisor(
  deps: {
    skillTree?: typeof checkSkillTree;
    skillRouting?: typeof evaluateSkillRouting;
  } = {},
): Promise<AdvisorReport> {
  const findings: AdvisorFinding[] = [];
  let skillTree: unknown;
  let skillRouting: unknown;
  try {
    const result = (deps.skillTree ?? checkSkillTree)();
    skillTree = result;
    if (!result.ok) {
      findings.push({
        id: 'workspace:skill-tree', surface: 'workspace', severity: 'warn',
        title: 'Skill tree needs attention',
        detail: 'Resolver reachability or skill conformance checks reported issues.',
        next_step: { surface: 'local_cli', command: 'voltmind check-resolvable --strict' },
      });
    }
  } catch (error) {
    skillTree = { error: error instanceof Error ? error.message : String(error) };
    findings.push({
      id: 'workspace:skill-tree-unavailable', surface: 'workspace', severity: 'warn',
      title: 'Skill tree could not be inspected',
      detail: 'Open the agent workspace and run the local resolver check.',
      next_step: { surface: 'local_cli', command: 'voltmind check-resolvable --strict' },
    });
  }
  try {
    const result = (deps.skillRouting ?? evaluateSkillRouting)();
    skillRouting = result;
    if (!result.ok) {
      findings.push({
        id: 'workspace:skill-routing', surface: 'workspace', severity: 'warn',
        title: 'Skill routing evaluation has gaps',
        detail: 'Routing fixtures contain missed, ambiguous, malformed, or false-positive cases.',
        next_step: { surface: 'local_cli', command: 'voltmind routing-eval --json' },
      });
    }
  } catch (error) {
    skillRouting = { error: error instanceof Error ? error.message : String(error) };
    findings.push({
      id: 'workspace:skill-routing-unavailable', surface: 'workspace', severity: 'warn',
      title: 'Skill routing could not be inspected',
      detail: 'Run the routing evaluation from the local agent workspace.',
      next_step: { surface: 'local_cli', command: 'voltmind routing-eval --json' },
    });
  }
  return {
    schema_version: 1,
    surface: 'workspace',
    status: statusOf(findings),
    findings,
    diagnostics: { skill_tree: skillTree, skill_routing: skillRouting },
  };
}

export function combineAdvisorReports(brain: AdvisorReport, workspace: AdvisorReport): AdvisorReport {
  const findings = [...brain.findings, ...workspace.findings];
  return {
    schema_version: 1,
    surface: 'combined',
    status: statusOf(findings),
    findings,
    diagnostics: { brain: brain.diagnostics, workspace: workspace.diagnostics },
  };
}

export async function runLocalAdvisor(engine: BrainEngine): Promise<AdvisorReport> {
  const [brain, workspace] = await Promise.all([runBrainAdvisor(engine), runWorkspaceAdvisor()]);
  return combineAdvisorReports(brain, workspace);
}

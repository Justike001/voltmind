import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

type ActionMode = 'manual' | 'agent_assisted' | 'agent_executable';

interface ActionRecord {
  source_id: string;
  slug: string;
  title: string;
  status: string;
  priority: string | null;
  due_at: string | null;
  eligible: boolean;
  mode: ActionMode;
  runtime: string | null;
  trigger: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'restricted';
  requires_approval: boolean;
  approved_at: string | null;
  last_run_status: string | null;
  max_autonomy: string | null;
  urgency_score?: number;
  agent_contract?: { objective?: string; context_refs?: string[]; output_target?: { type?: string; path?: string }; success_criteria?: string[] };
  outcome?: string | null;
  next_step?: string | null;
}

interface PlanStep {
  id: string;
  text: string;
  done: boolean;
  note: string;
  regenerated_at?: string;
}

interface PlanPhase {
  phase: string;
  steps: PlanStep[];
}

interface ActionPlan {
  version: 2;
  plan: PlanPhase[];
  done: Record<string, boolean>;
}

const modes: Array<{ value: ActionMode; label: string; hint: string }> = [
  { value: 'manual', label: 'Manual', hint: 'plan and schedule only' },
  { value: 'agent_assisted', label: 'Agent Assisted', hint: 'drafts with approval' },
  { value: 'agent_executable', label: 'Agent Executable', hint: 'bounded execution' },
];

function actionKey(a: Pick<ActionRecord, 'source_id' | 'slug'>): string {
  return `${a.source_id}:${a.slug}`;
}

function riskBadge(risk: string) {
  return <span className={`action-badge-risk action-badge-risk-${risk}`}>{risk}</span>;
}

function approvalBadge(a: ActionRecord) {
  if (a.mode === 'manual') return <span className="action-badge-approval action-badge-ready">manual</span>;
  if (a.approved_at) return <span className="action-badge-approval action-badge-approved">approved</span>;
  if (a.requires_approval || a.risk_level !== 'low') return <span className="action-badge-approval action-badge-pending">needs approval</span>;
  return <span className="action-badge-approval action-badge-ready">ready</span>;
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function remaining(value: string | null): string {
  if (!value) return 'unscheduled';
  const ms = new Date(value).getTime() - Date.now();
  if (Number.isNaN(ms)) return 'unscheduled';
  const abs = Math.abs(ms);
  const hours = Math.round(abs / 3_600_000);
  if (ms < 0) return hours < 24 ? `${hours}h overdue` : `${Math.round(hours / 24)}d overdue`;
  if (hours < 24) return `${hours}h left`;
  return `${Math.round(hours / 24)}d left`;
}

function normalizePlan(raw: any): ActionPlan | null {
  if (!raw?.plan || !Array.isArray(raw.plan)) return null;
  const done = raw.done || {};
  return {
    version: 2,
    plan: raw.plan.map((phase: any, phaseIndex: number) => ({
      phase: typeof phase.phase === 'string' ? phase.phase : `Phase ${phaseIndex + 1}`,
      steps: Array.isArray(phase.steps) ? phase.steps.map((step: any, stepIndex: number) => {
        if (typeof step === 'string') {
          return { id: `p${phaseIndex + 1}s${stepIndex + 1}`, text: step, done: Boolean(done[`${phaseIndex}:${stepIndex}`]), note: '' };
        }
        return {
          id: step.id || `p${phaseIndex + 1}s${stepIndex + 1}`,
          text: step.text || '',
          done: Boolean(step.done ?? done[`${phaseIndex}:${stepIndex}`]),
          note: step.note || '',
          regenerated_at: step.regenerated_at,
        };
      }).filter((step: PlanStep) => step.text.trim()) : [],
    })).filter((phase: PlanPhase) => phase.steps.length > 0),
    done: {},
  };
}

function serializePlan(plan: ActionPlan | null): string {
  if (!plan?.plan.length) return '';
  return [
    'Generated execution todo list:',
    ...plan.plan.flatMap((phase, index) => [
      `${index + 1}. ${phase.phase.replace(/^\d+\.\s*/, '')}`,
      ...phase.steps.map(step => `- [${step.done ? 'x' : ' '}] ${step.text}${step.note ? `\n  Note: ${step.note}` : ''}`),
    ]),
  ].join('\n');
}

export function ActionsPage() {
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<ActionMode>('agent_assisted');
  const [statusFilter, setStatusFilter] = useState('open');
  const [executionPrompt, setExecutionPrompt] = useState('');
  const [wholePlanInstructions, setWholePlanInstructions] = useState('');
  const [dueEdit, setDueEdit] = useState('');
  const [modeEdit, setModeEdit] = useState<ActionMode>('agent_assisted');
  const [priorityEdit, setPriorityEdit] = useState('medium');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);

  const load = async (status: string) => {
    setLoading(true);
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}&limit=150` : '?limit=150';
      const rows: ActionRecord[] = await api.actions(qs);
      setActions(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(statusFilter); }, [statusFilter]);

  const visibleActions = useMemo(() => actions.filter(a => a.mode === mode), [actions, mode]);
  const current = useMemo(() => {
    if (!selectedKey) return visibleActions[0] || null;
    return visibleActions.find(a => actionKey(a) === selectedKey) || visibleActions[0] || null;
  }, [visibleActions, selectedKey]);

  useEffect(() => {
    setExecutionPrompt('');
    setWholePlanInstructions('');
    if (!current) {
      setPlan(null);
      return;
    }
    setDueEdit(toDatetimeLocal(current.due_at));
    setModeEdit(current.mode);
    setPriorityEdit(current.priority || 'medium');
    let cancelled = false;
    api.getActionPlan(current.slug, current.source_id || 'default')
      .then(saved => {
        if (!cancelled) setPlan(normalizePlan(saved));
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });
    return () => { cancelled = true; };
  }, [current?.source_id, current?.slug]);

  const persistPlan = async (next: ActionPlan) => {
    if (!current) return;
    next.done = Object.fromEntries(next.plan.flatMap((phase, pi) => phase.steps.map((step, si) => [`${pi}:${si}`, step.done])));
    setPlan({ ...next, plan: [...next.plan] });
    await api.saveActionPlan(current.slug, current.source_id || 'default', next);
  };

  const handleGeneratePlan = async (regenerate = false) => {
    if (!current) return;
    setPlanLoading(true);
    try {
      const result = regenerate
        ? await api.regenerateActionPlan(current.slug, current.source_id, wholePlanInstructions, executionPrompt)
        : await api.generateActionPlan(current.slug, current.source_id, executionPrompt);
      setPlan(normalizePlan(result));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  };

  const regenerateStep = async (phaseIndex: number, stepIndex: number) => {
    if (!current || !plan) return;
    const step = plan.plan[phaseIndex]?.steps[stepIndex];
    setPlanLoading(true);
    try {
      const result = await api.regenerateActionPlanStep(current.slug, current.source_id, phaseIndex, stepIndex, step?.note || '');
      setPlan(normalizePlan(result));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  };

  const updatePlanStep = async (phaseIndex: number, stepIndex: number, patch: Partial<PlanStep>) => {
    if (!plan) return;
    const next: ActionPlan = {
      ...plan,
      plan: plan.plan.map((phase, pi) => ({
        ...phase,
        steps: phase.steps.map((step, si) => pi === phaseIndex && si === stepIndex ? { ...step, ...patch } : step),
      })),
    };
    await persistPlan(next);
  };

  const allPlanDone = Boolean(plan?.plan.length) && plan!.plan.every(phase => phase.steps.every(step => step.done));

  const scan = async () => {
    setLoading(true);
    try {
      await api.actionsScan();
      await load(statusFilter);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!current) return;
    await api.updateAction(current.slug, current.source_id, dueEdit || undefined, executionPrompt || undefined, modeEdit, priorityEdit);
    await load(statusFilter);
  };

  const approve = async () => {
    if (!current) return;
    await api.approveAction(current.slug, current.source_id);
    await load(statusFilter);
  };

  const run = async () => {
    if (!current) return;
    await api.setActionStatus(current.slug, current.source_id || 'default', 'in_progress');
    await api.runAction(current.slug, current.source_id, [serializePlan(plan), executionPrompt ? `User execution instructions:\n${executionPrompt}` : ''].filter(Boolean).join('\n\n'));
    await load(statusFilter);
  };

  const archiveManual = async () => {
    if (!current) return;
    await api.setActionStatus(current.slug, current.source_id || 'default', 'done');
    await load(statusFilter);
  };

  const runChecked = async () => {
    const rows = visibleActions.filter(a => checked[actionKey(a)] && a.mode !== 'manual');
    for (const a of rows) {
      await api.runAction(a.slug, a.source_id, current && actionKey(a) === actionKey(current) ? serializePlan(plan) : '');
    }
    await load(statusFilter);
    setChecked({});
  };

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const modeCounts = Object.fromEntries(modes.map(m => [m.value, actions.filter(a => a.mode === m.value).length]));

  return (
    <>
      <div className="actions-toolbar">
        <div className="actions-toolbar-left">
          <div>
            <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Actions</h1>
            <div className="page-subtitle">Review mode, schedule precisely, plan, approve, and prepare agent work.</div>
          </div>
        </div>
        <div className="actions-toolbar-right">
          <button className="btn btn-secondary" onClick={runChecked} disabled={checkedCount === 0 || mode === 'manual'}>
            Prepare selected ({checkedCount})
          </button>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} style={{ width: 'auto', minWidth: 120 }}>
            <option value="">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="blocked">Blocked</option>
            <option value="done">Done</option>
            <option value="canceled">Canceled</option>
          </select>
          <button className="btn btn-primary" onClick={scan} disabled={loading}>Scan</button>
        </div>
      </div>

      <div className="mode-switch">
        {modes.map(item => (
          <button key={item.value} className={`mode-switch-item ${mode === item.value ? 'active' : ''}`} onClick={() => { setMode(item.value); setSelectedKey(null); }}>
            <span>{item.label}</span>
            <small>{modeCounts[item.value] || 0} · {item.hint}</small>
          </button>
        ))}
      </div>

      {error && <div className="action-error">{error}</div>}

      <div className="actions-grid">
        <div className="actions-list">
          {visibleActions.length === 0 && !loading ? (
            <div className="action-empty">No {mode.replace('_', ' ')} actions in this status filter.</div>
          ) : visibleActions.map(a => (
            <div
              key={actionKey(a)}
              className={`action-row ${current && actionKey(current) === actionKey(a) ? 'selected' : ''}`}
              onClick={() => setSelectedKey(actionKey(a))}
            >
              <div className="action-row-checkbox" onClick={e => e.stopPropagation()}>
                <input
                  type="checkbox"
                  disabled={a.mode === 'manual'}
                  checked={Boolean(checked[actionKey(a)])}
                  onChange={e => setChecked({ ...checked, [actionKey(a)]: e.target.checked })}
                />
              </div>
              <div className="action-row-body">
                <span className="action-row-title">{a.title}</span>
                <div className="action-row-meta">
                  <span className="mono">{a.slug}</span>
                  <span>·</span>
                  <span>{a.status}</span>
                  <span>·</span>
                  <span>{remaining(a.due_at)}</span>
                </div>
              </div>
              <div className="action-row-badges">
                <span className="score-pill">{Math.round((a.urgency_score || 0) * 100)}</span>
                {riskBadge(a.risk_level)}
                {approvalBadge(a)}
              </div>
            </div>
          ))}
        </div>

        <div className="action-detail-panel">
          {!current ? (
            <div className="action-detail-empty">Select an action to inspect</div>
          ) : (
            <>
              <div className="action-detail-header">
                <div className="action-detail-title">{current.title}</div>
                <div className="action-detail-slug">{current.slug}</div>
                <div className="action-detail-meta">
                  {riskBadge(current.risk_level)}
                  {approvalBadge(current)}
                  <span className="score-pill">score {Math.round((current.urgency_score || 0) * 100)}</span>
                </div>
              </div>

              <div className="action-detail-section">
                <h3>Review</h3>
                <div className="detail-two-col">
                  <label>Mode
                    <select value={modeEdit} onChange={e => setModeEdit(e.target.value as ActionMode)}>
                      {modes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                    </select>
                  </label>
                  <label>Priority
                    <select value={priorityEdit} onChange={e => setPriorityEdit(e.target.value)}>
                      <option value="urgent">Urgent</option>
                      <option value="high">High</option>
                      <option value="medium">Medium</option>
                      <option value="low">Low</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="action-detail-section">
                <h3>Schedule</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="datetime-local" value={dueEdit} onChange={e => setDueEdit(e.target.value)} style={{ flex: 1 }} />
                  <button className="btn btn-secondary" onClick={save}>Save</button>
                </div>
                <div className="schedule-hint">{remaining(current.due_at)}</div>
              </div>

              {current.outcome && (
                <div className="action-detail-section">
                  <h3>Outcome</h3>
                  <p className="detail-copy">{current.outcome}</p>
                </div>
              )}
              {current.next_step && (
                <div className="action-detail-section">
                  <h3>Next Step</h3>
                  <p className="detail-copy">{current.next_step}</p>
                </div>
              )}

              <div className="plan-container">
                <div className="plan-header-row">
                  <h3>Generated Plan</h3>
                  <button className="btn btn-secondary" onClick={() => handleGeneratePlan(false)} disabled={planLoading}>
                    {plan ? 'Generate fresh' : 'Generate Plan'}
                  </button>
                </div>
                {planLoading && <div className="plan-loading">Generating…</div>}
                {plan && (
                  <>
                    <div className="plan-list">
                      {plan.plan.map((phase, pi) => (
                        <div key={`${phase.phase}:${pi}`}>
                          <div className="plan-phase">{phase.phase}</div>
                          {phase.steps.map((step, si) => (
                            <div key={step.id} className="plan-item">
                              <input className="plan-item-checkbox" type="checkbox" checked={step.done} onChange={() => updatePlanStep(pi, si, { done: !step.done })} />
                              <div className="plan-item-main">
                                <span className={`plan-item-text${step.done ? ' plan-item-done' : ''}`}>{step.text}</span>
                                <div className="plan-item-tools">
                                  <input
                                    value={step.note}
                                    onChange={e => updatePlanStep(pi, si, { note: e.target.value })}
                                    placeholder="Instruction for this step"
                                  />
                                  <button className="icon-btn" title="Regenerate this step" onClick={() => regenerateStep(pi, si)} disabled={planLoading}>↻</button>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <div className="whole-plan-regenerate">
                      <input value={wholePlanInstructions} onChange={e => setWholePlanInstructions(e.target.value)} placeholder="Instructions for regenerating the whole plan" />
                      <button className="btn btn-secondary" onClick={() => handleGeneratePlan(true)} disabled={planLoading || !wholePlanInstructions.trim()}>Regenerate plan</button>
                    </div>
                  </>
                )}
              </div>

              {current.mode !== 'manual' && (
                <div className="action-detail-section">
                  <h3>Your Execution Instructions</h3>
                  <textarea
                    className="action-detail-prompt"
                    value={executionPrompt}
                    onChange={e => setExecutionPrompt(e.target.value)}
                    placeholder="Add constraints, desired output format, or context for the agent run."
                  />
                </div>
              )}

              <div className="action-detail-section">
                <h3>Details</h3>
                <div className="action-detail-field"><span className="action-detail-field-label">Status</span><span className="action-detail-field-value">{current.status}</span></div>
                <div className="action-detail-field"><span className="action-detail-field-label">Priority</span><span className="action-detail-field-value">{current.priority || '—'}</span></div>
                <div className="action-detail-field"><span className="action-detail-field-label">Runtime</span><span className="action-detail-field-value">{current.runtime || '—'}</span></div>
                <div className="action-detail-field"><span className="action-detail-field-label">Trigger</span><span className="action-detail-field-value">{current.trigger || '—'}</span></div>
              </div>

              {current.mode === 'manual' ? (
                <div className="manual-archive-panel">
                  <span>{allPlanDone ? 'Plan complete. Ready to archive this manual action.' : 'Manual actions archive after every generated plan checkbox is complete.'}</span>
                  <button className="btn btn-primary" onClick={archiveManual} disabled={!allPlanDone}>Archive action</button>
                </div>
              ) : (
                <div className="action-detail-actions">
                  <button className="btn btn-primary" onClick={approve}>Approve</button>
                  <button className="btn btn-secondary" onClick={run}>Start</button>
                  <button className="btn btn-secondary" onClick={() => api.setActionStatus(current.slug, current.source_id, 'done').then(() => load(statusFilter))}>Done</button>
                  <button className="btn btn-secondary" onClick={() => api.setActionStatus(current.slug, current.source_id, 'blocked').then(() => load(statusFilter))}>Block</button>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

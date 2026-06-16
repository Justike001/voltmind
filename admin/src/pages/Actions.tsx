import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';

interface ActionRecord {
  source_id: string;
  slug: string;
  title: string;
  status: string;
  priority: string | null;
  due_at: string | null;
  eligible: boolean;
  mode: string;
  runtime: string | null;
  risk_level: 'low' | 'medium' | 'high' | 'restricted';
  requires_approval: boolean;
  approved_at: string | null;
  last_run_status: string | null;
  max_autonomy: string | null;
  agent_contract?: { objective?: string; context_refs?: string[]; output_target?: { type?: string; path?: string }; success_criteria?: string[] };
  outcome?: string;
  next_step?: string;
}

interface PlanStep { phase: string; steps: string[]; }

const riskOrder = ['restricted', 'high', 'medium', 'low'] as const;

function actionKey(a: Pick<ActionRecord, 'source_id' | 'slug'>): string {
  return `${a.source_id}:${a.slug}`;
}

function riskBadge(risk: string) {
  const map: Record<string, string> = { low: 'low', medium: 'medium', high: 'high', restricted: 'restricted' };
  return <span className={`action-badge-risk action-badge-risk-${map[risk] || 'medium'}`}>{risk}</span>;
}

function approvalBadge(a: ActionRecord) {
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

export function ActionsPage() {
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [filter, setFilter] = useState('open');
  const [prompt, setPrompt] = useState('');
  const [dueEdit, setDueEdit] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PlanStep[] | null>(null);
  const [planDone, setPlanDone] = useState<Record<string, boolean>>({});
  const [planLoading, setPlanLoading] = useState(false);

  const load = async (f: string) => {
    setLoading(true);
    try {
      const qs = f ? `?status=${encodeURIComponent(f)}&limit=100` : '?limit=100';
      const rows: ActionRecord[] = await api.actions(qs);
      setActions(rows);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(filter); }, [filter]);

  const current = useMemo(() => {
    if (!selectedKey) return actions[0] || null;
    return actions.find(a => actionKey(a) === selectedKey) || actions[0] || null;
  }, [actions, selectedKey]);

  // Load saved plan when switching actions
  useEffect(() => {
    setPrompt('');
    if (!current) {
      setPlan(null);
      setPlanDone({});
      return;
    }
    setDueEdit(toDatetimeLocal(current.due_at));
    // Load persisted plan from backend
    let cancelled = false;
    api.getActionPlan(current.slug, current.source_id || 'default')
      .then((saved) => {
        if (cancelled) return;
        if (saved && saved.plan) {
          setPlan(saved.plan);
          setPlanDone(saved.done || {});
        } else {
          setPlan(null);
          setPlanDone({});
        }
      })
      .catch(() => {
        if (!cancelled) { setPlan(null); setPlanDone({}); }
      });
    return () => { cancelled = true; };
  }, [current?.source_id, current?.slug]);

  const handleGeneratePlan = async () => {
    if (!current) return;
    setPlanLoading(true);
    try {
      const result: { plan: PlanStep[] } = await api.generateActionPlan(current.slug, current.source_id, prompt);
      setPlan(result.plan);
      const freshDone: Record<string, boolean> = {};
      setPlanDone(freshDone);
      // Note: the server auto-persists the generated plan —
      // no separate save call needed here.
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPlanLoading(false);
    }
  };

  const togglePlanStep = (phaseIdx: number, stepIdx: number) => {
    const key = `${phaseIdx}:${stepIdx}`;
    setPlanDone(prev => {
      const next = { ...prev, [key]: !prev[key] };
      // Auto-persist plan state
      if (current && plan) {
        api.saveActionPlan(current.slug, current.source_id || 'default', { plan, done: next }).catch(() => {});
      }
      return next;
    });
  };

  const scan = async () => {
    setLoading(true);
    try {
      await api.actionsScan();
      await load(filter);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const run = async () => {
    if (!current) return;
    await api.setActionStatus(current.slug, current.source_id || 'default', 'in_progress');
    await api.runAction(current.slug, current.source_id, buildExecutionPrompt());
    await load(filter);
  };

  const approve = async () => {
    if (!current) return;
    await api.approveAction(current.slug, current.source_id);
    await load(filter);
  };

  const save = async () => {
    if (!current) return;
    await api.updateAction(current.slug, current.source_id, dueEdit || undefined, prompt || undefined);
    await load(filter);
  };

  const setStatus = async (status: string) => {
    if (!current) return;
    await api.setActionStatus(current.slug, current.source_id, status);
    await load(filter);
  };

  const runChecked = async () => {
    const rows = actions.filter(a => checked[actionKey(a)]);
    for (const a of rows) {
      const userPrompt = current && actionKey(a) === actionKey(current) ? buildExecutionPrompt() : prompt;
      await api.runAction(a.slug, a.source_id, userPrompt);
    }
    await load(filter);
    setChecked({});
  };

  const serializePlan = () => {
    if (!plan?.length) return '';
    return [
      'Generated execution todo list:',
      ...plan.flatMap((phase, index) => [
        `${index + 1}. ${phase.phase.replace(/^\d+\.\s*/, '')}`,
        ...phase.steps.map((step, stepIndex) => {
          const checkedMarker = planDone[`${index}:${stepIndex}`] ? 'x' : ' ';
          return `- [${checkedMarker}] ${step}`;
        }),
      ]),
    ].join('\n');
  };

  const buildExecutionPrompt = () => {
    const planText = serializePlan();
    return [
      planText,
      prompt ? `User execution instructions:\n${prompt}` : '',
    ].filter(Boolean).join('\n\n');
  };

  const grouped = riskOrder
    .map(risk => ({ risk, rows: actions.filter(a => a.risk_level === risk) }))
    .filter(g => g.rows.length > 0);

  const checkedCount = Object.values(checked).filter(Boolean).length;

  return (
    <>
      {/* Toolbar */}
      <div className="actions-toolbar">
        <div className="actions-toolbar-left">
          <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Actions</h1>
          <span style={{ color: 'var(--text-muted)', fontSize: 12, marginTop: 2 }}>draft-only agent prep, gated by risk and approval</span>
        </div>
        <div className="actions-toolbar-right">
          <button className="btn btn-secondary" onClick={runChecked} disabled={checkedCount === 0}>
            Prepare selected ({checkedCount})
          </button>
          <select value={filter} onChange={e => setFilter(e.target.value)} style={{ width: 'auto', minWidth: 110 }}>
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

      {error && <div className="action-error">{error}</div>}

      {/* Main grid: list + detail */}
      <div className="actions-grid">
        {/* Action list */}
        <div className="actions-list">
          {grouped.length === 0 && !loading && (
            <div className="action-empty">
              No actions indexed. Add Markdown under <code style={{ fontFamily: 'var(--font-mono)', fontSize: 12 }}>brain/state/actions/</code>, then scan.
            </div>
          )}
          {grouped.map(group => (
            <div key={group.risk} className="action-group">
              <div className="action-group-header" style={{ color: group.risk === 'low' ? 'var(--success)' : group.risk === 'medium' ? 'var(--warning)' : 'var(--error)' }}>
                {group.risk}
                <span className="action-group-count">{group.rows.length} action{group.rows.length !== 1 ? 's' : ''}</span>
              </div>
              {group.rows.map(a => (
                <div
                  key={`${a.source_id}:${a.slug}`}
                  className={`action-row ${selectedKey === actionKey(a) ? 'selected' : ''}`}
                  onClick={() => setSelectedKey(actionKey(a))}
                >
                  <div className="action-row-checkbox" onClick={e => e.stopPropagation()}>
                    <input
                      type="checkbox"
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
                      {a.due_at && <><span>·</span><span>due {new Date(a.due_at).toLocaleDateString()}</span></>}
                    </div>
                  </div>
                  <div className="action-row-badges">
                    {riskBadge(a.risk_level)}
                    {approvalBadge(a)}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Detail panel */}
        <div className="action-detail-panel">
          {!current ? (
            <div className="action-detail-empty">Select an action to see details</div>
          ) : (
            <>
              <div className="action-detail-header">
                <div className="action-detail-title">{current.title}</div>
                <div className="action-detail-slug">{current.slug}</div>
                <div className="action-detail-meta">
                  {riskBadge(current.risk_level)}
                  {approvalBadge(current)}
                  <span className="action-badge-approval action-badge-ready" style={{ fontSize: 11 }}>{current.mode}</span>
                </div>
              </div>

              {/* ── AI-Generated Plan ── */}
              <div className="plan-container">
                {!plan && !planLoading && (
                  <button className="plan-generate-btn" onClick={handleGeneratePlan}>
                    Generate Plan / ToDoList
                  </button>
                )}
                {planLoading && <div className="plan-loading">Generating plan via DeepSeek...</div>}
                {plan && (
                  <div className="plan-list">
                    {plan.map((phase, pi) => (
                      <div key={pi}>
                        <div className="plan-phase">{phase.phase}</div>
                        {phase.steps.map((step, si) => {
                          const key = `${pi}:${si}`;
                          const done = planDone[key];
                          return (
                            <label key={key} className="plan-item">
                              <input
                                type="checkbox"
                                className="plan-item-checkbox"
                                checked={done}
                                onChange={() => togglePlanStep(pi, si)}
                              />
                              <span className={`plan-item-text${done ? ' plan-item-done' : ''}`}>{step}</span>
                            </label>
                          );
                        })}
                      </div>
                    ))}
                    <button className="plan-regenerate" onClick={handleGeneratePlan} disabled={planLoading}>
                      {planLoading ? 'Generating...' : '↻ Regenerate'}
                    </button>
                  </div>
                )}
              </div>

              {/* ── User Prompt (after plan review) ── */}
              <div className="action-detail-section">
                <h3>Your Execution Instructions</h3>
                <textarea
                  className="action-detail-prompt"
                  value={prompt}
                  onChange={e => setPrompt(e.target.value)}
                  placeholder={plan ? "Review the plan above, then add your specific execution instructions here..." : "Generate a plan first, or enter your execution instructions directly..."}
                />
              </div>

              <div className="action-detail-section">
                <h3>Schedule</h3>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input
                    type="datetime-local"
                    value={dueEdit}
                    onChange={e => setDueEdit(e.target.value)}
                    style={{ flex: 1 }}
                  />
                  <button className="btn btn-secondary" onClick={save}>Save</button>
                </div>
              </div>

              <div className="action-detail-section">
                <h3>Details</h3>
                <div className="action-detail-field">
                  <span className="action-detail-field-label">Status</span>
                  <span className="action-detail-field-value">{current.status}</span>
                </div>
                <div className="action-detail-field">
                  <span className="action-detail-field-label">Priority</span>
                  <span className="action-detail-field-value">{current.priority || '—'}</span>
                </div>
                <div className="action-detail-field">
                  <span className="action-detail-field-label">Max autonomy</span>
                  <span className="action-detail-field-value">{current.max_autonomy || 'draft_only'}</span>
                </div>
                <div className="action-detail-field">
                  <span className="action-detail-field-label">Runtime</span>
                  <span className="action-detail-field-value">{current.runtime || '—'}</span>
                </div>
              </div>

              {current.outcome && (
                <div className="action-detail-section">
                  <h3>Outcome</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{current.outcome}</p>
                </div>
              )}
              {current.next_step && (
                <div className="action-detail-section">
                  <h3>Next Step</h3>
                  <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.5 }}>{current.next_step}</p>
                </div>
              )}
              <div className="action-detail-actions">
                <button className="btn btn-primary" onClick={approve}>Approve</button>
                
                <button className="btn btn-secondary" onClick={run}>Start</button>
                <button className="btn btn-secondary" onClick={() => setStatus('done')}>Done</button>
                <button className="btn btn-secondary" onClick={() => setStatus('blocked')}>Block</button>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

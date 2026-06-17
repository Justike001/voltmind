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

const modes: Array<{ value: ActionMode; label: string; hint: string; icon: string }> = [
  { value: 'manual', label: 'Manual', hint: 'You execute steps', icon: 'hand' },
  { value: 'agent_assisted', label: 'Agent Assisted', hint: 'Plan with agent, you execute', icon: 'bot' },
  { value: 'agent_executable', label: 'Agent Executable', hint: 'Agent executes end-to-end', icon: 'rocket' },
];

const ACTIONS_STATUS_FILTER_KEY = 'voltmind.admin.actions.statusFilter';
const ACTIONS_INSPECTOR_WIDTH_KEY = 'voltmind.admin.actions.inspectorWidth';
const validStatusFilters = new Set(['', 'open', 'in_progress', 'blocked', 'done', 'canceled']);
const MIN_INSPECTOR_WIDTH = 360;
const MAX_INSPECTOR_WIDTH = 760;
const DEFAULT_INSPECTOR_WIDTH = 520;

const priorityLabels: Record<string, string> = {
  urgent: 'P1',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
  none: 'P4',
};

function actionKey(a: Pick<ActionRecord, 'source_id' | 'slug'>): string {
  return `${a.source_id}:${a.slug}`;
}

function modeLabel(value: string): string {
  return modes.find(m => m.value === value)?.label || value.replace('_', ' ');
}

function scoreValue(action: Pick<ActionRecord, 'urgency_score'>): number {
  return Math.round((action.urgency_score || 0) * 100);
}

function scoreTone(score: number): 'hot' | 'warm' | 'cool' {
  if (score >= 75) return 'hot';
  if (score >= 50) return 'warm';
  return 'cool';
}

function Icon({ name }: { name: string }) {
  if (name === 'bot') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 9V6.5a4 4 0 0 1 8 0V9" /><path d="M5 10.5h14v8H5z" /><path d="M9 14h.01M15 14h.01M9 18h6" /><path d="M3 14h2M19 14h2" /></svg>;
  }
  if (name === 'rocket') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4c2.7.4 4.6 2.3 5 5l-7 7-4-4z" /><path d="M9 15l-2 4-2-2 4-2z" /><path d="M15 5l4 4" /><path d="M12 19l-3-3" /></svg>;
  }
  if (name === 'refresh') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a8 8 0 0 1-13.7 5.7" /><path d="M4 12A8 8 0 0 1 17.7 6.3" /><path d="M7 18H4v-3" /><path d="M17 6h3v3" /></svg>;
  }
  if (name === 'play') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg>;
  }
  if (name === 'check') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5" /></svg>;
  }
  if (name === 'block') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8" /><path d="m8 8 8 8" /></svg>;
  }
  return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5 5 8l3 3" /><path d="M16 19l3-3-3-3" /><path d="M5 8h14M5 16h14" /></svg>;
}

function riskBadge(risk: string) {
  return <span className={`vm-chip vm-risk-${risk}`}>{risk}</span>;
}

function priorityBadge(priority: string | null) {
  const value = priority || 'none';
  return <span className={`vm-chip vm-priority-${value}`}>{priorityLabels[value] || value.toUpperCase()}</span>;
}

function statusBadge(status: string) {
  return <span className={`vm-chip vm-status-${status}`}><span className="vm-dot" />{status.replace('_', ' ')}</span>;
}

function toDatetimeLocal(value: string | null): string {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function formatDue(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '-';
  return date.toLocaleString(undefined, { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function remaining(value: string | null): string {
  if (!value) return '-';
  const ms = new Date(value).getTime() - Date.now();
  if (Number.isNaN(ms)) return '-';
  const abs = Math.abs(ms);
  const hours = Math.round(abs / 3_600_000);
  if (ms < 0) return hours < 24 ? `${hours}h overdue` : `${Math.round(hours / 24)}d overdue`;
  if (hours < 24) return `${hours}h left`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function normalizePlan(raw: any): ActionPlan | null {
  if (!raw?.plan || !Array.isArray(raw.plan)) return null;
  const done = raw.done || {};
  const plan = raw.plan.map((phase: any, phaseIndex: number) => ({
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
  })).filter((phase: PlanPhase) => phase.steps.length > 0);
  return { version: 2, plan, done: {} };
}

function withDoneMap(plan: ActionPlan): ActionPlan {
  return {
    ...plan,
    done: Object.fromEntries(plan.plan.flatMap((phase, pi) => phase.steps.map((step, si) => [`${pi}:${si}`, step.done]))),
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

function getSavedStatusFilter(): string {
  try {
    const saved = window.localStorage.getItem(ACTIONS_STATUS_FILTER_KEY);
    return saved !== null && validStatusFilters.has(saved) ? saved : 'open';
  } catch {
    return 'open';
  }
}

function saveStatusFilter(value: string): void {
  try {
    window.localStorage.setItem(ACTIONS_STATUS_FILTER_KEY, value);
  } catch {
    // localStorage can be unavailable in hardened browser contexts.
  }
}

function clampInspectorWidth(value: number): number {
  const viewportMax = Math.max(MIN_INSPECTOR_WIDTH, Math.min(MAX_INSPECTOR_WIDTH, window.innerWidth - 900));
  return Math.min(Math.max(Math.round(value), MIN_INSPECTOR_WIDTH), viewportMax);
}

function getSavedInspectorWidth(): number {
  try {
    const saved = Number(window.localStorage.getItem(ACTIONS_INSPECTOR_WIDTH_KEY));
    return Number.isFinite(saved) ? clampInspectorWidth(saved) : DEFAULT_INSPECTOR_WIDTH;
  } catch {
    return DEFAULT_INSPECTOR_WIDTH;
  }
}

function saveInspectorWidth(value: number): void {
  try {
    window.localStorage.setItem(ACTIONS_INSPECTOR_WIDTH_KEY, String(value));
  } catch {
    // Best effort only.
  }
}

export function ActionsPage() {
  const [actions, setActions] = useState<ActionRecord[]>([]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [mode, setMode] = useState<ActionMode>('agent_assisted');
  const [statusFilter, setStatusFilter] = useState(getSavedStatusFilter);
  const [executionPrompt, setExecutionPrompt] = useState('');
  const [wholePlanInstructions, setWholePlanInstructions] = useState('');
  const [dueEdit, setDueEdit] = useState('');
  const [modeEdit, setModeEdit] = useState<ActionMode>('agent_assisted');
  const [priorityEdit, setPriorityEdit] = useState('medium');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<ActionPlan | null>(null);
  const [planLoading, setPlanLoading] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(getSavedInspectorWidth);

  const load = async (status: string) => {
    setLoading(true);
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}&limit=150` : '?limit=150';
      const rows: ActionRecord[] = await api.actions(qs);
      setActions(rows);
      setLastSyncedAt(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    saveStatusFilter(statusFilter);
    void load(statusFilter);
  }, [statusFilter]);

  useEffect(() => {
    saveInspectorWidth(inspectorWidth);
  }, [inspectorWidth]);

  useEffect(() => {
    const onResize = () => setInspectorWidth(width => clampInspectorWidth(width));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const startInspectorResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    event.preventDefault();
    const pointerId = event.pointerId;
    event.currentTarget.setPointerCapture(pointerId);
    document.body.classList.add('inspector-resizing');

    const onMove = (moveEvent: PointerEvent) => {
      setInspectorWidth(clampInspectorWidth(window.innerWidth - moveEvent.clientX));
    };
    const onUp = () => {
      document.body.classList.remove('inspector-resizing');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };

    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp, { once: true });
    window.addEventListener('pointercancel', onUp, { once: true });
  };

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

  const replaceAction = (updated: ActionRecord) => {
    const key = actionKey(updated);
    setActions(prev => prev.map(a => actionKey(a) === key ? updated : a));
    setSelectedKey(key);
    setMode(updated.mode);
    setModeEdit(updated.mode);
    setPriorityEdit(updated.priority || 'medium');
    setDueEdit(toDatetimeLocal(updated.due_at));
  };

  const commitActionPatch = async (
    patch: { dueAt?: string | null; userPrompt?: string | null; mode?: ActionMode; priority?: string | null },
    savingKey: string,
  ) => {
    if (!current) return;
    setSaving(savingKey);
    try {
      const updated: ActionRecord = await api.updateActionPatch(current.slug, current.source_id, patch);
      replaceAction(updated);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load(statusFilter);
    } finally {
      setSaving(null);
    }
  };

  const persistPlan = async (next: ActionPlan) => {
    if (!current) return;
    const normalized = withDoneMap(next);
    setPlan(normalized);
    await api.saveActionPlan(current.slug, current.source_id || 'default', normalized);
  };

  const patchPlanStepLocal = (phaseIndex: number, stepIndex: number, patch: Partial<PlanStep>): ActionPlan | null => {
    if (!plan) return null;
    const next: ActionPlan = {
      ...plan,
      plan: plan.plan.map((phase, pi) => ({
        ...phase,
        steps: phase.steps.map((step, si) => pi === phaseIndex && si === stepIndex ? { ...step, ...patch } : step),
      })),
    };
    setPlan(next);
    return next;
  };

  const updatePlanStep = async (phaseIndex: number, stepIndex: number, patch: Partial<PlanStep>) => {
    const next = patchPlanStepLocal(phaseIndex, stepIndex, patch);
    if (next) await persistPlan(next);
  };

  const handleGeneratePlan = async (regenerate = false) => {
    if (!current) return;
    setPlanLoading(true);
    try {
      const result = regenerate
        ? await api.regenerateActionPlan(current.slug, current.source_id, wholePlanInstructions, executionPrompt)
        : await api.generateActionPlan(current.slug, current.source_id, executionPrompt);
      setPlan(normalizePlan(result));
      setWholePlanInstructions('');
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

  const addPlanStep = async () => {
    if (!plan) return;
    const phase = plan.plan[0] || { phase: 'Plan', steps: [] };
    const next: ActionPlan = {
      ...plan,
      plan: [
        { ...phase, steps: [...phase.steps, { id: `p1s${phase.steps.length + 1}-${Date.now()}`, text: 'New step', done: false, note: '' }] },
        ...plan.plan.slice(1),
      ],
    };
    await persistPlan(next);
  };

  const allPlanDone = Boolean(plan?.plan.length) && plan!.plan.every(phase => phase.steps.every(step => step.done));
  const checkedCount = Object.values(checked).filter(Boolean).length;
  const modeCounts = Object.fromEntries(modes.map(m => [m.value, actions.filter(a => a.mode === m.value).length]));
  const selectedScore = current ? scoreValue(current) : 0;
  const selectedTone = scoreTone(selectedScore);
  const planStepCount = plan?.plan.reduce((sum, phase) => sum + phase.steps.length, 0) || 0;

  const scan = async () => {
    setLoading(true);
    try {
      await api.actionsScan('E:\\gbrain\\VoltMind-PersonalBrain');
      await load(statusFilter);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  const approve = async () => {
    if (!current) return;
    const updated = await api.approveAction(current.slug, current.source_id);
    replaceAction(updated);
  };

  const run = async () => {
    if (!current) return;
    await api.setActionStatus(current.slug, current.source_id || 'default', 'in_progress');
    await api.runAction(current.slug, current.source_id, [serializePlan(plan), executionPrompt ? `User execution instructions:\n${executionPrompt}` : ''].filter(Boolean).join('\n\n'));
    await load(statusFilter);
  };

  const archiveCurrent = async (note: string) => {
    if (!current) return;
    setSaving('archive');
    const key = actionKey(current);
    try {
      await api.setActionStatus(current.slug, current.source_id || 'default', 'done', note);
      setActions(prev => prev.filter(a => actionKey(a) !== key));
      setSelectedKey(null);
      setChecked(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      window.location.hash = 'archive';
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      await load(statusFilter);
    } finally {
      setSaving(null);
    }
  };

  const archiveManual = async () => {
    await archiveCurrent('Archived from manual action cockpit.');
  };

  const markDone = async () => {
    await archiveCurrent('Marked done from action cockpit.');
  };

  const runChecked = async () => {
    const rows = visibleActions.filter(a => checked[actionKey(a)] && a.mode !== 'manual');
    for (const a of rows) {
      await api.runAction(a.slug, a.source_id, current && actionKey(a) === actionKey(current) ? serializePlan(plan) : '');
    }
    await load(statusFilter);
    setChecked({});
  };

  return (
    <div className="actions-workbench">
      <header className="actions-topbar">
        <div className="actions-title-block">
          <h1>Actions</h1>
        </div>
        <div className="actions-status-strip">
          <div className="sync-state sync-state-ok"><Icon name="check" /><span>Scan Complete</span><small>{lastSyncedAt || '-'}</small></div>
          <div className="sync-state sync-state-blue"><Icon name="refresh" /><span>All Synced</span><small>{lastSyncedAt || '-'}</small></div>
          <button className="vm-tool-button" onClick={scan} disabled={loading}><Icon name="play" />Scan Now</button>
          <button className="vm-tool-button" onClick={() => void load(statusFilter)} disabled={loading}><Icon name="refresh" />Sync Now</button>
          <label className="vm-filter-button">Filters
            <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
              <option value="">All</option>
              <option value="open">Open</option>
              <option value="in_progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="done">Done</option>
              <option value="canceled">Canceled</option>
            </select>
          </label>
        </div>
      </header>

      {error && <div className="action-error">{error}</div>}

      <div
        className="actions-board"
        style={{ '--inspector-width': `${inspectorWidth}px` } as React.CSSProperties}
      >
        <section className="actions-queue-panel">
          <div className="mode-switch">
            {modes.map(item => (
              <button key={item.value} className={`mode-switch-item ${mode === item.value ? 'active' : ''}`} onClick={() => { setMode(item.value); setSelectedKey(null); }}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
                <small>{item.hint}</small>
                <em>{modeCounts[item.value] || 0}</em>
              </button>
            ))}
          </div>

          <div className="actions-table-shell">
            <table className="actions-table">
              <thead>
                <tr>
                  <th className="select-col"><input type="checkbox" aria-label="Select visible" disabled={mode === 'manual'} onChange={e => {
                    const next = { ...checked };
                    visibleActions.forEach(a => { if (a.mode !== 'manual') next[actionKey(a)] = e.target.checked; });
                    setChecked(next);
                  }} /></th>
                  <th>Title</th>
                  <th>Source</th>
                  <th>Status</th>
                  <th>Risk</th>
                  <th>Priority</th>
                  <th>Due (Local)</th>
                  <th>Remaining</th>
                  <th>Score</th>
                </tr>
              </thead>
              <tbody>
                {visibleActions.length === 0 && !loading ? (
                  <tr><td colSpan={9} className="table-empty">No {modeLabel(mode)} actions in this status filter.</td></tr>
                ) : visibleActions.map(a => {
                  const key = actionKey(a);
                  const score = scoreValue(a);
                  return (
                    <tr key={key} className={current && actionKey(current) === key ? 'selected' : ''} onClick={() => setSelectedKey(key)}>
                      <td className="select-col" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          disabled={a.mode === 'manual'}
                          checked={Boolean(checked[key])}
                          onChange={e => setChecked({ ...checked, [key]: e.target.checked })}
                        />
                      </td>
                      <td><strong>{a.title}</strong></td>
                      <td><span className="source-path">{a.slug.replace(/^state\/actions\//, '')}</span></td>
                      <td>{statusBadge(a.status)}</td>
                      <td>{riskBadge(a.risk_level)}</td>
                      <td>{priorityBadge(a.priority)}</td>
                      <td>{formatDue(a.due_at)}</td>
                      <td>{remaining(a.due_at)}</td>
                      <td>
                        <div className={`score-cell score-${scoreTone(score)}`}>
                          <span>{score || '-'}</span>
                          <div className="score-bars">{Array.from({ length: 12 }, (_, i) => <i key={i} className={i < Math.round(score / 8.4) ? 'on' : ''} />)}</div>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <footer className="actions-table-footer">
              <span>{checkedCount} selected</span>
              <span>{visibleActions.length} of {actions.length} actions</span>
            </footer>
          </div>

          <div className="score-formula">
            <span>Score =</span>
            <strong>Risk (20%)</strong>
            <span>+</span>
            <strong>Deadline (45%)</strong>
            <span>+</span>
            <strong>Priority (35%)</strong>
            <em>Higher score rises first.</em>
          </div>
        </section>

        <aside className="action-inspector">
          <button
            className="inspector-resize-handle"
            aria-label="Resize action inspector"
            title="Drag to resize inspector"
            onPointerDown={startInspectorResize}
          />
          {!current ? (
            <div className="action-detail-empty">Select an action to inspect</div>
          ) : (
            <>
              <div className="inspector-nav">
                <button className="back-link" onClick={() => setSelectedKey(null)}>Back to list</button>
              </div>
              <div className="inspector-heading">
                <h2>{current.title}</h2>
                <span>☆</span>
              </div>

              <div className="field-stack">
                <label>Outcome
                  <input readOnly value={current.outcome || 'No outcome captured yet.'} />
                </label>
                <label>Next Step
                  <input readOnly value={current.next_step || 'No next step captured yet.'} />
                </label>
              </div>

              <div className="review-grid">
                <label>Mode (Review)
                  <select
                    value={modeEdit}
                    disabled={saving === 'mode'}
                    onChange={e => {
                      const value = e.target.value as ActionMode;
                      setModeEdit(value);
                      void commitActionPatch({ mode: value }, 'mode');
                    }}
                  >
                    {modes.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                </label>
                <label>Schedule (Local)
                  <input
                    type="datetime-local"
                    value={dueEdit}
                    disabled={saving === 'due'}
                    onChange={e => setDueEdit(e.target.value)}
                    onBlur={() => {
                      if (dueEdit !== toDatetimeLocal(current.due_at)) void commitActionPatch({ dueAt: dueEdit || null }, 'due');
                    }}
                  />
                </label>
                <label>Priority
                  <select
                    value={priorityEdit}
                    disabled={saving === 'priority'}
                    onChange={e => {
                      const value = e.target.value;
                      setPriorityEdit(value);
                      void commitActionPatch({ priority: value }, 'priority');
                    }}
                  >
                    <option value="urgent">P1 Urgent</option>
                    <option value="high">P1 High</option>
                    <option value="medium">P2 Medium</option>
                    <option value="low">P3 Low</option>
                  </select>
                </label>
              </div>

              <div className="inspector-facts">
                <div><small>Risk</small><span className={`fact-risk-${current.risk_level}`}>{current.risk_level}</span></div>
                <div><small>Priority</small><span>{priorityLabels[current.priority || 'none'] || '-'}</span></div>
                <div><small>Due</small><span>{formatDue(current.due_at)}</span></div>
                <div><small>Remaining</small><span>{remaining(current.due_at)}</span></div>
                <div><small>Score</small><span className={`fact-score-${selectedTone}`}>{selectedScore || '-'}</span></div>
              </div>

              <div className="plan-container">
                <div className="plan-header-row">
                  <h3>Generated Plan <span>{planStepCount} steps</span></h3>
                </div>
                <div className="whole-plan-regenerate">
                  <input value={wholePlanInstructions} onChange={e => setWholePlanInstructions(e.target.value)} placeholder="Plan instructions (optional), e.g., focus on compliance, be concise, include citations..." />
                  <button className="btn btn-primary" onClick={() => handleGeneratePlan(Boolean(plan))} disabled={planLoading || (Boolean(plan) && !wholePlanInstructions.trim())}>Apply</button>
                </div>
                {planLoading && <div className="plan-loading">Generating...</div>}
                {plan && (
                  <>
                    <div className="plan-list">
                      {plan.plan.map((phase, pi) => (
                        <div key={`${phase.phase}:${pi}`} className="plan-phase-block">
                          {plan.plan.length > 1 && <div className="plan-phase">{phase.phase}</div>}
                          {phase.steps.map((step, si) => (
                            <div key={step.id} className="plan-item">
                              <span className="drag-handle">::</span>
                              <input className="plan-item-checkbox" type="checkbox" checked={step.done} onChange={() => updatePlanStep(pi, si, { done: !step.done })} />
                              <div className="plan-item-main">
                                <span className={`plan-item-text${step.done ? ' plan-item-done' : ''}`}>{step.text}</span>
                              </div>
                              <input
                                className="step-note"
                                value={step.note}
                                onChange={e => patchPlanStepLocal(pi, si, { note: e.target.value })}
                                onBlur={() => plan && persistPlan(plan)}
                                placeholder="Add feedback..."
                              />
                              <button className="icon-btn" title="Regenerate this step" onClick={() => regenerateStep(pi, si)} disabled={planLoading}><Icon name="refresh" /></button>
                            </div>
                          ))}
                        </div>
                      ))}
                    </div>
                    <button className="add-step-button" onClick={addPlanStep}>+ Add step</button>
                  </>
                )}
              </div>

              {current.mode !== 'manual' && (
                <div className="action-detail-section">
                  <h3>Your Execution Instructions</h3>
                  <textarea
                    className="action-detail-prompt"
                    value={executionPrompt}
                    onBlur={() => executionPrompt && commitActionPatch({ userPrompt: executionPrompt }, 'prompt')}
                    onChange={e => setExecutionPrompt(e.target.value)}
                    placeholder="Add constraints, desired output format, or context for the agent run."
                  />
                </div>
              )}

              {current.mode === 'manual' ? (
                <div className="manual-archive-panel">
                  <span>{allPlanDone ? 'Plan complete. Ready to archive this manual action.' : 'Manual actions archive after every generated plan checkbox is complete.'}</span>
                  <button className="btn btn-primary" onClick={archiveManual} disabled={!allPlanDone || saving === 'archive'}><Icon name="check" />Archive action</button>
                </div>
              ) : (
                <div className="action-detail-actions">
                  <button className="btn btn-success" onClick={approve}><Icon name="check" />Approve Plan</button>
                  <button className="btn btn-primary" onClick={run}><Icon name="play" />Start</button>
                  <button className="btn btn-warning" onClick={() => api.setActionStatus(current.slug, current.source_id, 'blocked').then(() => load(statusFilter))}><Icon name="block" />Block</button>
                  <button className="btn btn-secondary" onClick={markDone} disabled={saving === 'archive'}><Icon name="check" />Mark Done</button>
                </div>
              )}

              <p className="execution-note">{current.mode === 'manual' ? 'Agent will not execute. You use the plan as guidance.' : 'Agent will not execute until the action is approved and started.'}</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

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
  tool_route?: ActionToolRoute | null;
  outcome?: string | null;
  next_step?: string | null;
  related_context?: ActionRelatedContext;
}

interface ActionRunRecord {
  id: number;
  source_id: string;
  action_slug: string;
  status: string;
  created_at: string;
  finished_at: string | null;
}

interface ActionRunStatusResponse {
  finalized: boolean;
  writeback_status: string;
  missing_result?: boolean;
  run?: ActionRunRecord;
  action?: ActionRecord | null;
  outcome?: { summary?: string };
}

interface RunActionResponse {
  action_run_id?: number;
  writeback_status?: string;
  run?: ActionRunRecord;
}

interface PendingWritebackState {
  runId: number;
  sourceId: string;
  slug: string;
  status: string;
  startedAt: number;
  message: string;
  timedOut?: boolean;
}

interface ActionRelatedContext {
  related_people: string[];
  related_project: string | null;
  related_systems: string[];
  related_entities: string[];
  related_projects: string[];
  related_workstream: string | null;
}

interface RelatedRuntimeContext {
  hits?: unknown[];
  warnings?: string[];
}

interface ActionToolRouteSkill {
  name: string;
  description: string;
}

interface ActionToolRouteCandidate {
  plugin: string;
  display_name: string;
  description: string;
  icon_data_url?: string;
  category: string;
  score: number;
  reason: string;
  skills: ActionToolRouteSkill[];
  tools: string[];
}

interface ActionToolRoute {
  version: 1;
  source: 'auto' | 'llm' | 'user';
  generated_at: string;
  selected_plugins: string[];
  selected_tools: string[];
  blocked_tools: string[];
  confidence: number;
  reason: string;
  candidates: ActionToolRouteCandidate[];
  notes?: string;
}

interface ToolRouteDraft {
  selectedPlugins: string[];
  selectedTools: string[];
  blockedTools: string[];
  notes: string;
}

const toolRoutePluginProviders = ['openai-curated', 'openai-bundled'] as const;

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
  { value: 'manual', label: 'Manual', hint: 'Human-run checklist actions', icon: 'hand' },
  { value: 'agent_assisted', label: 'Agent Assisted', hint: 'Agent prepares the plan; human starts execution', icon: 'bot' },
  { value: 'agent_executable', label: 'Agent Executable', hint: 'Agent can run the approved action end to end', icon: 'rocket' },
];

const ACTIONS_STATUS_FILTER_KEY = 'voltmind.admin.actions.statusFilter';
const ACTIONS_INSPECTOR_WIDTH_KEY = 'voltmind.admin.actions.inspectorWidth';
const validStatusFilters = new Set(['', 'open', 'on_schedule', 'in_progress', 'blocked', 'canceled']);
const MIN_INSPECTOR_WIDTH = 360;
const MAX_INSPECTOR_WIDTH = 760;
const DEFAULT_INSPECTOR_WIDTH = 520;
const WRITEBACK_POLL_MS = 3000;
const WRITEBACK_TIMEOUT_MS = 10 * 60 * 1000;

function uniqueList(values: string[]): string[] {
  return Array.from(new Set(values.map(value => value.trim()).filter(Boolean)));
}

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

function pendingWritebackFromRunResponse(
  response: RunActionResponse,
  fallback: Pick<ActionRecord, 'source_id' | 'slug'>,
): PendingWritebackState | null {
  const runId = response.action_run_id ?? response.run?.id;
  const status = response.writeback_status ?? response.run?.status;
  if (status !== 'interactive_pending' || typeof runId !== 'number') return null;
  return {
    runId,
    sourceId: fallback.source_id || 'default',
    slug: fallback.slug,
    status,
    startedAt: Date.now(),
    message: 'Waiting for Codex writeback.',
  };
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

function routePluginIcon(plugin: string): string {
  const id = plugin.toLowerCase();
  if (id.includes('email') || id.includes('mail')) return 'mail';
  if (id.includes('teams')) return 'messages';
  if (id.includes('calendar')) return 'calendar';
  if (id.includes('browser') || id.includes('chrome')) return 'browser';
  return 'plugin';
}

function Icon({ name }: { name: string }) {
  if (name === 'mail') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6h16v12H4z" /><path d="m4 7 8 6 8-6" /></svg>;
  }
  if (name === 'messages') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 6h14v9H8l-3 3z" /><path d="M8 9h8M8 12h5" /></svg>;
  }
  if (name === 'calendar') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v15H5z" /><path d="M8 3v4M16 3v4M5 10h14" /><path d="M8 14h2M12 14h2M16 14h1M8 17h2M12 17h2" /></svg>;
  }
  if (name === 'browser') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z" /><path d="M4 9h16" /><path d="M8 7h.01M11 7h.01" /></svg>;
  }
  if (name === 'plugin') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5h4v7h-5v4H8v-4H4V9h4z" /></svg>;
  }
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
  if (name === 'x') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>;
  }
  if (name === 'arrow-right') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14" /><path d="M12 5l7 7-7 7" /></svg>;
  }
  if (name === 'help') {
    return <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.5 10.2a2.6 2.6 0 0 1 5 1c0 1.8-2.5 2.2-2.5 3.8" /><path d="M12 17h.01" /></svg>;
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

function normalizeRelatedContext(context: ActionRelatedContext | undefined): ActionRelatedContext {
  return {
    related_people: context?.related_people || [],
    related_project: context?.related_project || null,
    related_systems: context?.related_systems || [],
    related_entities: context?.related_entities || [],
    related_projects: context?.related_projects || [],
    related_workstream: context?.related_workstream || null,
  };
}

function relatedEntries(action: ActionRecord): Array<{ label: string; values: string[] }> {
  const context = normalizeRelatedContext(action.related_context);
  return [
    { label: 'People', values: context.related_people },
    { label: 'Project', values: context.related_project ? [context.related_project] : [] },
    { label: 'Projects', values: context.related_projects },
    { label: 'Workstream', values: context.related_workstream ? [context.related_workstream] : [] },
    { label: 'Systems', values: context.related_systems },
    { label: 'Entities', values: context.related_entities },
  ].filter(group => group.values.length > 0);
}

function relatedChipText(value: string): string {
  return value.replace(/^(people|projects|workstreams|systems|companies|concepts)\//, '');
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

function normalizeToolRouteDraft(route: ActionToolRoute | null | undefined): ToolRouteDraft {
  return {
    selectedPlugins: route?.selected_plugins || [],
    selectedTools: route?.selected_tools || [],
    blockedTools: route?.blocked_tools || [],
    notes: route?.notes || '',
  };
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
  const [planContextWarnings, setPlanContextWarnings] = useState<string[]>([]);
  const [toolRouteDraft, setToolRouteDraft] = useState<ToolRouteDraft>(normalizeToolRouteDraft(null));
  const [toolRouteLoading, setToolRouteLoading] = useState(false);
  const [availablePlugins, setAvailablePlugins] = useState<ActionToolRouteCandidate[]>([]);
  const [pluginsLoading, setPluginsLoading] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<string | null>(null);
  const [inspectorWidth, setInspectorWidth] = useState(getSavedInspectorWidth);
  const [inspectorCollapsed, setInspectorCollapsed] = useState(true);
  const [pendingWriteback, setPendingWriteback] = useState<PendingWritebackState | null>(null);

  const load = async (status: string) => {
    setLoading(true);
    try {
      const qs = status ? `?status=${encodeURIComponent(status)}&limit=150` : '?limit=150';
      const rows: ActionRecord[] = await api.actions(qs);
      setActions(status ? rows : rows.filter(row => row.status !== 'done'));
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
    if (!selectedKey) return null;
    return visibleActions.find(a => actionKey(a) === selectedKey) || null;
  }, [visibleActions, selectedKey]);
  const inspectorOpen = Boolean(current && !inspectorCollapsed);
  const currentPendingWriteback = current && pendingWriteback?.sourceId === current.source_id && pendingWriteback.slug === current.slug
    ? pendingWriteback
    : null;

  useEffect(() => {
    setExecutionPrompt('');
    setWholePlanInstructions('');
    setPlanContextWarnings([]);
    if (!current) {
      setPlan(null);
      return;
    }
    setDueEdit(toDatetimeLocal(current.due_at));
    setModeEdit(current.mode);
    setPriorityEdit(current.priority || 'medium');
    setToolRouteDraft(normalizeToolRouteDraft(current.tool_route));
    let cancelled = false;
    api.getActionPlan(current.slug, current.source_id || 'default')
      .then(saved => {
        if (!cancelled) setPlan(normalizePlan(saved));
      })
      .catch(() => {
        if (!cancelled) setPlan(null);
      });
    if (current.mode !== 'manual') {
      setPluginsLoading(true);
      api.listAvailableToolPlugins()
        .then(({ plugins }) => {
          if (cancelled) return;
          const normalized = plugins.map((p: any) => ({
            plugin: p.plugin || '',
            display_name: p.display_name || p.plugin || '',
            description: p.description || '',
            category: p.category || 'Other',
            score: 0,
            reason: '',
            skills: [],
            tools: Array.isArray(p.tools) ? p.tools.filter((tool: unknown): tool is string => typeof tool === 'string' && tool.trim().length > 0) : [],
            icon_data_url: p.icon_data_url,
          }));
          setAvailablePlugins(normalized);
          const savedPlugins = current.tool_route?.selected_plugins || [];
          if (savedPlugins.length && savedPlugins.every((plugin: string) => !normalized.find((c: ActionToolRouteCandidate) => c.plugin === plugin))) {
            setToolRouteDraft(normalizeToolRouteDraft(null));
          }
        })
        .catch(() => {})
        .finally(() => {
          if (!cancelled) setPluginsLoading(false);
        });
    }
    return () => { cancelled = true; };
  }, [current?.source_id, current?.slug, current?.mode]);

  useEffect(() => {
    if (!current || current.last_run_status !== 'interactive_pending') return;
    if (pendingWriteback?.sourceId === current.source_id && pendingWriteback.slug === current.slug) return;
    let cancelled = false;
    api.actionRuns(current.slug, current.source_id || 'default')
      .then((runs: ActionRunRecord[]) => {
        if (cancelled) return;
        const pending = runs.find(run => run.status === 'interactive_pending');
        if (!pending) return;
        setPendingWriteback({
          runId: pending.id,
          sourceId: pending.source_id || current.source_id || 'default',
          slug: pending.action_slug || current.slug,
          status: 'interactive_pending',
          startedAt: Date.now(),
          message: 'Waiting for Codex writeback.',
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [current?.source_id, current?.slug, current?.last_run_status, pendingWriteback?.runId]);

  useEffect(() => {
    if (!pendingWriteback) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const response: ActionRunStatusResponse = await api.actionRunStatus(pendingWriteback.runId);
        if (cancelled) return;
        const status = response.writeback_status || response.run?.status || 'interactive_pending';
        if (status === 'interactive_pending') {
          const timedOut = Date.now() - pendingWriteback.startedAt > WRITEBACK_TIMEOUT_MS;
          setPendingWriteback(prev => prev?.runId === pendingWriteback.runId
            ? {
                ...prev,
                status,
                timedOut,
                message: timedOut
                  ? 'Still waiting for Codex writeback. You can mark this action Done or Blocked manually.'
                  : 'Waiting for Codex writeback.',
              }
            : prev);
          return;
        }
        setPendingWriteback(prev => prev?.runId === pendingWriteback.runId ? null : prev);
        await load(statusFilter);
        setError(null);
      } catch (e) {
        if (cancelled) return;
        setPendingWriteback(prev => prev?.runId === pendingWriteback.runId
          ? { ...prev, message: e instanceof Error ? e.message : String(e) }
          : prev);
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), WRITEBACK_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [pendingWriteback?.runId, pendingWriteback?.startedAt, statusFilter]);

  const replaceAction = (updated: ActionRecord) => {
    const key = actionKey(updated);
    setActions(prev => prev.map(a => actionKey(a) === key ? updated : a));
    setSelectedKey(key);
    setMode(updated.mode);
    setModeEdit(updated.mode);
    setPriorityEdit(updated.priority || 'medium');
    setDueEdit(toDatetimeLocal(updated.due_at));
    setToolRouteDraft(normalizeToolRouteDraft(updated.tool_route));
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
      const relatedRuntime = (result as { related_runtime_context?: RelatedRuntimeContext }).related_runtime_context;
      setPlanContextWarnings(Array.isArray(relatedRuntime?.warnings) ? relatedRuntime.warnings : []);
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

  const saveSelectedToolRoute = async (pluginName: string, selected: boolean) => {
    if (!current) return;
    const candidate = availablePlugins.find(c => c.plugin === pluginName);
    if (!candidate) return;
    const selectedPlugins = selected
      ? uniqueList([...toolRouteDraft.selectedPlugins, candidate.plugin])
      : toolRouteDraft.selectedPlugins.filter(plugin => plugin !== candidate.plugin);
    const selectedPluginSet = new Set(selectedPlugins);
    const selectedTools = uniqueList(
      availablePlugins
        .filter(plugin => selectedPluginSet.has(plugin.plugin))
        .flatMap(plugin => plugin.tools || []),
    );
    const nextDraft: ToolRouteDraft = {
      selectedPlugins,
      selectedTools,
      blockedTools: [],
      notes: '',
    };
    setToolRouteDraft(nextDraft);
    setToolRouteLoading(true);
    try {
      const updated: ActionRecord = await api.saveActionToolRoute(current.slug, current.source_id || 'default', nextDraft);
      replaceAction(updated);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setToolRouteLoading(false);
    }
  };

  const checkedCount = Object.values(checked).filter(Boolean).length;
  const modeCounts = Object.fromEntries(modes.map(m => [m.value, actions.filter(a => a.mode === m.value).length]));
  const planStepCount = plan?.plan.reduce((sum, phase) => sum + phase.steps.length, 0) || 0;
  const selectedToolPluginSet = new Set(toolRouteDraft.selectedPlugins);
  const selectedToolCandidates = availablePlugins.filter(candidate => selectedToolPluginSet.has(candidate.plugin));

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
    const hasSchedule = Boolean(dueEdit || current.due_at);
    const hasPlan = Boolean(plan?.plan.length);
    const hasTool = current.mode === 'manual' || toolRouteDraft.selectedPlugins.length > 0;
    if (!hasSchedule) {
      setError('Set a schedule before approving this action.');
      return;
    }
    if (!hasPlan) {
      setError('Generate or save a plan before approving this action.');
      return;
    }
    if (!hasTool) {
      setError('Choose a tool before approving this action.');
      return;
    }

    setSaving('approve');
    try {
      if (dueEdit !== toDatetimeLocal(current.due_at)) {
        await api.updateActionPatch(current.slug, current.source_id, { dueAt: dueEdit || null });
      }
      await api.approveAction(current.slug, current.source_id);
      await api.setActionStatus(current.slug, current.source_id || 'default', 'on_schedule', 'Approved plan and scheduled from action cockpit.');
      await load(statusFilter);
      setSelectedKey(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const run = async () => {
    if (!current) return;
    setSaving('start');
    try {
      await api.setActionStatus(current.slug, current.source_id || 'default', 'in_progress', 'Started from action cockpit.');
      if (current.mode !== 'manual') {
        const response: RunActionResponse = await api.runAction(current.slug, current.source_id, {
          userPrompt: executionPrompt,
          execute: true,
          interactive: true,
          confirmed: true,
          force: true,
        });
        const pending = pendingWritebackFromRunResponse(response, current);
        if (pending) setPendingWriteback(pending);
      }
      await load(statusFilter);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
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

  const markDone = async () => {
    await archiveCurrent('Marked done from action cockpit.');
  };

  const blockCurrent = async () => {
    if (!current) return;
    setSaving('block');
    try {
      await api.setActionStatus(current.slug, current.source_id, 'blocked', 'Blocked from action cockpit.');
      await load(statusFilter);
      setSelectedKey(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const cancelCurrent = async () => {
    if (!current) return;
    setSaving('cancel');
    try {
      await api.setActionStatus(current.slug, current.source_id, 'canceled', 'Canceled from action cockpit.');
      await load(statusFilter);
      setSelectedKey(null);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(null);
    }
  };

  const runChecked = async () => {
    const rows = visibleActions.filter(a => checked[actionKey(a)] && a.mode !== 'manual');
    let latestPending: PendingWritebackState | null = null;
    for (const a of rows) {
      const response: RunActionResponse = await api.runAction(a.slug, a.source_id, {
        userPrompt: current && actionKey(a) === actionKey(current) ? executionPrompt : '',
        execute: true,
        interactive: true,
        confirmed: true,
        force: true,
      });
      const pending = pendingWritebackFromRunResponse(response, a);
      if (pending) latestPending = pending;
    }
    if (latestPending) setPendingWriteback(latestPending);
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
              <option value="on_schedule">On Schedule</option>
              <option value="in_progress">In progress</option>
              <option value="blocked">Blocked</option>
              <option value="canceled">Canceled</option>
            </select>
          </label>
        </div>
      </header>

      {error && <div className="action-error">{error}</div>}

      <div
        className={`actions-board ${inspectorOpen ? 'inspector-open' : 'inspector-hidden'}`}
        style={{ '--inspector-width': `${inspectorWidth}px` } as React.CSSProperties}
      >
        <section className="actions-queue-panel">
          <div className="mode-switch">
            {modes.map(item => (
              <button key={item.value} className={`mode-switch-item ${mode === item.value ? 'active' : ''}`} title={item.hint} onClick={() => { setMode(item.value); setSelectedKey(null); setInspectorCollapsed(true); }}>
                <Icon name={item.icon} />
                <span>{item.label}</span>
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
                  <th>
                    <span className="score-heading">
                      Score
                      <span className="score-help" title="Score = Risk (20%) + Deadline (45%) + Priority (35%). Higher score rises first."><Icon name="help" /></span>
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visibleActions.length === 0 && !loading ? (
                  <tr><td colSpan={9} className="table-empty">No {modeLabel(mode)} actions in this status filter.</td></tr>
                ) : visibleActions.map(a => {
                  const key = actionKey(a);
                  const score = scoreValue(a);
                  const related = relatedEntries(a).flatMap(group => group.values.map(value => ({ group: group.label, value }))).slice(0, 4);
                  return (
                    <tr key={key} className={current && actionKey(current) === key ? 'selected' : ''} onClick={() => { setSelectedKey(key); setInspectorCollapsed(false); }}>
                      <td className="select-col" onClick={e => e.stopPropagation()}>
                        <input
                          type="checkbox"
                          disabled={a.mode === 'manual'}
                          checked={Boolean(checked[key])}
                          onChange={e => setChecked({ ...checked, [key]: e.target.checked })}
                        />
                      </td>
                      <td>
                        <div className="action-title-cell">
                          <strong>{a.title}</strong>
                          {related.length > 0 && (
                            <div className="related-chip-row">
                              {related.map(item => (
                                <span key={`${item.group}:${item.value}`} className="related-chip" title={`${item.group}: ${item.value}`}>
                                  {relatedChipText(item.value)}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      </td>
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
                <button className="back-link" onClick={() => setInspectorCollapsed(true)}><Icon name="arrow-right" />Back to list</button>
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

              {relatedEntries(current).length > 0 && (
                <div className="related-context-panel">
                  <h3>Related Context</h3>
                  {relatedEntries(current).map(group => (
                    <div className="related-context-group" key={group.label}>
                      <span>{group.label}</span>
                      <div className="related-chip-row">
                        {group.values.map(value => (
                          <span key={value} className="related-chip" title={value}>{relatedChipText(value)}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              )}

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

              {current.mode !== 'manual' && (
                <div className="tool-route-panel">
                  <div className="tool-route-heading">
                    <span>Tools</span>
                    <small>{pluginsLoading ? 'Scanning...' : `${toolRouteDraft.selectedPlugins.length} selected`}</small>
                  </div>

                  <div className="tool-route-grid" aria-label="Select action tool routes">
                    {availablePlugins.length === 0 ? (
                      <div className="tool-route-empty">{pluginsLoading ? 'Scanning plugins...' : 'No plugin tools found.'}</div>
                    ) : availablePlugins.map(candidate => {
                      const selected = selectedToolPluginSet.has(candidate.plugin);
                      return (
                        <label key={candidate.plugin} className={`tool-route-option${selected ? ' selected' : ''}`}>
                          <input
                            type="checkbox"
                            checked={selected}
                            disabled={pluginsLoading || toolRouteLoading}
                            onChange={e => void saveSelectedToolRoute(candidate.plugin, e.target.checked)}
                          />
                          <span className="tool-route-check" aria-hidden="true"><Icon name="check" /></span>
                          <span className="tool-route-icon">
                            {candidate.icon_data_url
                              ? <img src={candidate.icon_data_url} alt="" />
                              : <Icon name={routePluginIcon(candidate.plugin)} />}
                          </span>
                          <span className="tool-route-plugin-body">
                            <strong>{candidate.display_name}</strong>
                            <small>@{candidate.plugin} · {candidate.category}</small>
                          </span>
                        </label>
                      );
                    })}
                  </div>

                  {selectedToolCandidates.length > 0 && (
                    <div className="tool-route-selected-summary">
                      <span>Route capsule</span>
                      <div>
                        {selectedToolCandidates.map(candidate => (
                          <em key={candidate.plugin}>@{candidate.plugin}</em>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}

              <div className="plan-container">
                <div className="plan-header-row">
                  <h3>Generated Plan <span>{planStepCount} steps</span></h3>
                </div>
                <div className="whole-plan-regenerate">
                  <input value={wholePlanInstructions} onChange={e => setWholePlanInstructions(e.target.value)} placeholder="Plan instructions (optional), e.g., focus on compliance, be concise, include citations..." />
                  <button className="btn btn-primary" onClick={() => handleGeneratePlan(Boolean(plan))} disabled={planLoading || (Boolean(plan) && !wholePlanInstructions.trim())}>Apply</button>
                </div>
                {planLoading && <div className="plan-loading">Generating...</div>}
                {planContextWarnings.length > 0 && (
                  <div className="plan-context-warning">
                    {planContextWarnings.map(warning => <div key={warning}>{warning}</div>)}
                  </div>
                )}
                {plan && (
                  <>
                    <div className="plan-list">
                      {plan.plan.map((phase, pi) => (
                        <div key={`${phase.phase}:${pi}`} className="plan-phase-block">
                          {plan.plan.length > 1 && (
                            <div className="plan-phase">
                              <span>{phase.phase}</span>
                              <em>{phase.steps.length} steps</em>
                            </div>
                          )}
                          {phase.steps.map((step, si) => (
                            <div key={step.id} className={`plan-item${step.done ? ' plan-item-complete' : ''}`}>
                              <span className="plan-step-index">{pi + 1}.{si + 1}</span>
                              <label className="plan-check-shell" title={step.done ? 'Mark step open' : 'Mark step done'}>
                                <input className="plan-item-checkbox" type="checkbox" checked={step.done} onChange={() => updatePlanStep(pi, si, { done: !step.done })} />
                              </label>
                              <div className="plan-item-body">
                                <div className="plan-item-main">
                                  <span className={`plan-item-text${step.done ? ' plan-item-done' : ''}`}>{step.text}</span>
                                </div>
                                <div className="plan-item-tools">
                                  <input
                                    className="step-note"
                                    value={step.note}
                                    onChange={e => patchPlanStepLocal(pi, si, { note: e.target.value })}
                                    onBlur={() => plan && persistPlan(plan)}
                                    placeholder="Add feedback..."
                                  />
                                  <button className="icon-btn" title="Regenerate this step" onClick={() => regenerateStep(pi, si)} disabled={planLoading}><Icon name="refresh" /></button>
                                </div>
                              </div>
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

              {currentPendingWriteback && (
                <div className={`interactive-writeback-panel${currentPendingWriteback.timedOut ? ' timed-out' : ''}`}>
                  <div>
                    <strong>Waiting for Codex writeback</strong>
                    <span>Run #{currentPendingWriteback.runId}</span>
                  </div>
                  <p>{currentPendingWriteback.message}</p>
                </div>
              )}

              <div className="action-detail-actions">
                {current.status === 'open' && (
                  <button className="btn btn-success" onClick={approve} disabled={saving === 'approve'}><Icon name="check" />Approve Plan</button>
                )}
                {(current.status === 'open' || current.status === 'on_schedule') && (
                  <button className="btn btn-primary" onClick={run} disabled={saving === 'start'}><Icon name="play" />Start</button>
                )}
                {current.status === 'in_progress' && (
                  <button className="btn btn-warning" onClick={blockCurrent} disabled={saving === 'block'}><Icon name="block" />Blocked</button>
                )}
                {(current.status === 'open' || current.status === 'on_schedule' || (current.mode === 'manual' && current.status === 'in_progress')) && (
                  <button className="btn btn-secondary" onClick={markDone} disabled={saving === 'archive'}><Icon name="check" />Done</button>
                )}
                {['open', 'on_schedule', 'in_progress'].includes(current.status) && (
                  <button className="btn btn-danger" onClick={cancelCurrent} disabled={saving === 'cancel'}><Icon name="x" />Cancel</button>
                )}
              </div>

              <p className="execution-note">{current.mode === 'manual' ? 'Agent will not execute. You use the plan as guidance.' : 'Agent will not execute until the action is approved and started.'}</p>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

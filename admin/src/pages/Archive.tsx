import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface ArchivedAction {
  source_id: string;
  slug: string;
  title: string;
  status: string;
  mode: string;
  priority: string | null;
  risk_level: string;
  due_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  archived_at: string | null;
  elapsed_ms: number | null;
  file_path: string | null;
  last_run_status: string | null;
  last_run?: { status: string; result: Record<string, unknown> | null; error_text: string | null; finished_at: string | null } | null;
}

function formatDate(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString([], { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function formatElapsed(ms: number | null): string {
  if (!ms || ms < 0) return '—';
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

export function ArchivePage() {
  const [rows, setRows] = useState<ArchivedAction[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = async () => {
    setLoading(true);
    try {
      const data = await api.archivedActions();
      setRows(data);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const handleRestore = async (row: ArchivedAction) => {
    if (!confirm(`Restore "${row.title}" back to open actions?`)) return;
    setLoading(true);
    try {
      await api.unarchiveAction(row.slug, row.source_id);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <div className="page-header-row">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>Archive</h1>
          <div className="page-subtitle">Completed actions, storage paths, and execution time.</div>
        </div>
        <button className="btn btn-secondary" onClick={load} disabled={loading}>Refresh</button>
      </div>

      {error && <div className="action-error">{error}</div>}

      {rows.length === 0 && !loading ? (
        <div className="empty-panel">No archived actions yet. Manual actions enter here after their generated plan is fully checked and archived.</div>
      ) : (
        <div className="archive-table-wrap">
          <table>
            <thead>
              <tr>
                <th>Action</th>
                <th>Mode</th>
                <th>Risk</th>
                <th>Priority</th>
                <th>Due</th>
                <th>Completed</th>
                <th>Elapsed</th>
                <th>Last Run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const key = `${row.source_id}:${row.slug}`;
                return (
                  <React.Fragment key={key}>
                    <tr onClick={() => setExpanded(expanded === key ? null : key)} style={{ cursor: 'pointer' }}>
                      <td>
                        <div className="archive-title">{row.title}</div>
                        <div className="archive-slug mono">{row.slug}</div>
                      </td>
                      <td><span className="mode-pill">{row.mode.replace('_', ' ')}</span></td>
                      <td><span className={`action-badge-risk action-badge-risk-${row.risk_level}`}>{row.risk_level}</span></td>
                      <td>{row.priority || '—'}</td>
                      <td>{formatDate(row.due_at)}</td>
                      <td>{formatDate(row.completed_at || row.archived_at)}</td>
                      <td className="mono">{formatElapsed(row.elapsed_ms)}</td>
                      <td><span className={`badge badge-${row.last_run_status || 'success'}`}>{row.last_run_status || '—'}</span></td>
                    </tr>
                    {expanded === key && (
                      <tr>
                        <td colSpan={8} className="archive-expanded">
                          <div className="archive-expanded-grid">
                            <span>Source</span><code>{row.source_id}</code>
                            <span>Stored at</span><code>{row.file_path || '—'}</code>
                            <span>Started</span><span>{formatDate(row.started_at)}</span>
                            <span>Archived</span><span>{formatDate(row.archived_at)}</span>
                            <span>Run result</span>
                            <pre>{JSON.stringify(row.last_run?.result || row.last_run?.error_text || {}, null, 2)}</pre>
                          </div>
                          <div className="archive-actions-bar">
                            <button
                              className="btn btn-warning"
                              onClick={() => handleRestore(row)}
                              disabled={loading}
                            >
                              Restore action
                            </button>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

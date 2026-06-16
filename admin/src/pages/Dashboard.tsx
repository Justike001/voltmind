import React, { useEffect, useState } from 'react';
import { api } from '../api';

interface FeedEvent {
  agent_name?: string;
  token_name?: string;
  operation: string;
  latency_ms: number;
  status: string;
  created_at: string;
  error_message?: string | null;
}

function metricValue(value: unknown): string {
  if (typeof value === 'number') return value.toLocaleString();
  if (typeof value === 'string') return value;
  return '—';
}

function timeAgo(ts: string): string {
  const diff = Date.now() - new Date(ts).getTime();
  if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(ts).toLocaleDateString();
}

export function DashboardPage() {
  const [stats, setStats] = useState<Record<string, unknown>>({});
  const [fullStats, setFullStats] = useState<Record<string, unknown>>({});
  const [health, setHealth] = useState({ expiring_soon: 0, error_rate: '0%' });
  const [requests, setRequests] = useState<FeedEvent[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    try {
      const [basic, full, h, recent] = await Promise.all([
        api.stats(),
        api.fullStats(),
        api.health(),
        api.requests(1, ''),
      ]);
      setStats(basic);
      setFullStats(full);
      setHealth(h);
      setRequests(recent.rows || []);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    void load();
    const timer = setInterval(() => { void load(); }, 30000);
    return () => clearInterval(timer);
  }, []);

  const cards = [
    { label: 'Pages', value: fullStats.page_count ?? fullStats.pages ?? fullStats.pageCount },
    { label: 'Chunks', value: fullStats.chunk_count ?? fullStats.chunks ?? fullStats.chunkCount },
    { label: 'Sources', value: fullStats.source_count ?? fullStats.sources ?? fullStats.sourceCount },
    { label: 'Requests 24h', value: stats.requests_today },
    { label: 'Active Tokens', value: stats.active_tokens },
    { label: 'Active API Keys', value: stats.active_api_keys },
  ];

  return (
    <>
      <div className="page-header-row">
        <div>
          <h1 className="page-title" style={{ marginBottom: 4 }}>Dashboard</h1>
          <div className="page-subtitle">VoltMind runtime health, brain shape, and recent agent/API activity.</div>
        </div>
        <button className="btn btn-secondary" onClick={load}>Refresh</button>
      </div>

      {error && <div className="action-error">{error}</div>}

      <div className="dashboard-grid">
        {cards.map(card => (
          <div key={card.label} className="metric">
            <div className="metric-value">{metricValue(card.value)}</div>
            <div className="metric-label">{card.label}</div>
          </div>
        ))}
      </div>

      <div className="dashboard-split">
        <section className="ops-panel">
          <h2 className="section-title">Runtime Health</h2>
          <div className="health-row"><span>Engine</span><span className="mono">{metricValue(fullStats.engine)}</span></div>
          <div className="health-row"><span>Status</span><span className="badge badge-success">{metricValue(fullStats.status || 'ok')}</span></div>
          <div className="health-row"><span>Error rate 24h</span><span style={{ color: health.error_rate === '0%' ? 'var(--success)' : 'var(--error)' }}>{health.error_rate}</span></div>
          <div className="health-row"><span>Tokens expiring soon</span><span className="mono">{health.expiring_soon}</span></div>
        </section>

        <section className="ops-panel">
          <h2 className="section-title">Recent API Activity</h2>
          {requests.length === 0 ? (
            <div className="feed-empty">No recent MCP/API requests.</div>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Agent</th>
                  <th>Operation</th>
                  <th>Latency</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {requests.slice(0, 8).map((row, index) => (
                  <tr key={`${row.created_at}:${index}`}>
                    <td>{timeAgo(row.created_at)}</td>
                    <td>{row.agent_name || row.token_name || '—'}</td>
                    <td className="mono">{row.operation}</td>
                    <td className="mono">{row.latency_ms}ms</td>
                    <td><span className={`badge badge-${row.status}`}>{row.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      </div>
    </>
  );
}

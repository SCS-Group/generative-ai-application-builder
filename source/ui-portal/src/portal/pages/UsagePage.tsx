import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/portal/ui/Card';
import { Badge } from '@/portal/ui/Badge';
import { getVoiceUsage, type VoiceUsageResponse } from '@/portal/api/usage';
import { Alert } from '@/portal/ui/Alert';

export function UsagePage() {
  const [days, setDays] = useState<number>(7);
  const [data, setData] = useState<VoiceUsageResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    setError(null);
    getVoiceUsage(days)
      .then((d) => mounted && setData(d))
      .catch((e: any) => mounted && setError(e?.message ?? 'Failed to load usage.'))
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [days]);

  const totals = data?.totals;
  const hasData = (totals?.calls ?? 0) > 0;

  const dayLabel = useMemo(() => {
    if (days === 1) return 'Last 24 hours';
    return `Last ${days} days`;
  }, [days]);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Usage</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Voice KPIs first. Chat/web metering next.
        </p>
      </div>

      {error && <Alert variant="error">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        {[7, 30].map((d) => (
          <button
            key={d}
            type="button"
            onClick={() => setDays(d)}
            className={
              d === days
                ? 'rounded-full bg-muted px-3 py-1 text-sm font-medium'
                : 'rounded-full px-3 py-1 text-sm text-muted-foreground hover:bg-muted'
            }
          >
            {d}d
          </button>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Voice usage</CardTitle>
          <div className="text-sm text-muted-foreground">{dayLabel}</div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading usage…</div>
          ) : !data ? (
            <div className="text-sm text-muted-foreground">No usage data.</div>
          ) : !hasData ? (
            <div className="text-sm text-muted-foreground">
              No calls in this period yet.
            </div>
          ) : (
            <div className="grid gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Calls</div>
                <div className="mt-1 text-xl font-semibold">{totals?.calls ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Total minutes</div>
                <div className="mt-1 text-xl font-semibold">{totals?.totalDurationMinutes ?? 0}</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Avg duration</div>
                <div className="mt-1 text-xl font-semibold">{totals?.avgDurationSec ?? 0}s</div>
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs text-muted-foreground">Errors</div>
                <div className="mt-1 text-xl font-semibold">{totals?.errorCalls ?? 0}</div>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>By agent</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="text-sm text-muted-foreground">Loading…</div>
          ) : !data || data.byUseCase.length === 0 ? (
            <div className="text-sm text-muted-foreground">No agent usage yet.</div>
          ) : (
            <div className="space-y-2">
              {data.byUseCase.map((u) => (
                <div
                  key={u.useCaseId}
                  className="flex flex-col gap-2 rounded-lg border border-border p-3 md:flex-row md:items-center md:justify-between"
                >
                  <div className="min-w-0">
                    <div className="truncate font-medium">{u.useCaseName}</div>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                      <span>{u.calls} calls</span>
                      <span>•</span>
                      <span>{u.totalDurationSec > 0 ? Math.max(1, Math.ceil(u.totalDurationSec / 60)) : 0} min</span>
                      <span>•</span>
                      <span>{u.avgDurationSec}s avg</span>
                      <span>•</span>
                      <span>{u.avgTurns} turns avg</span>
                      <span>•</span>
                      <span>{u.avgLatencyMs}ms avg</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {u.errorCalls > 0 ? <Badge variant="destructive">Errors {u.errorCalls}</Badge> : <Badge variant="secondary">Healthy</Badge>}
                    {u.endedCalls === u.calls ? <Badge variant="secondary">Completed</Badge> : <Badge variant="secondary">In progress</Badge>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}



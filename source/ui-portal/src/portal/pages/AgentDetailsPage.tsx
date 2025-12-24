import { useQuery } from '@tanstack/react-query';
import { useParams, Link } from 'react-router-dom';
import { getDeploymentDetails } from '@/portal/api/deployments';
import { getMe } from '@/portal/api/me';
import { listPortalUsers, type PortalUser } from '@/portal/api/users';
import { getUseCaseSupervisors, setUseCaseSupervisors } from '@/portal/api/supervisors';
import { Card, CardContent, CardHeader, CardTitle } from '@/portal/ui/Card';
import { Badge } from '@/portal/ui/Badge';
import { Button } from '@/portal/ui/Button';
import { useMemo, useState } from 'react';
import { useToast } from '@/portal/ui/toast';

function ToolsList({ tools }: { tools?: Array<{ ToolId: string }> }) {
  const ids = (tools ?? []).map((t) => t?.ToolId).filter(Boolean);
  if (ids.length === 0) return <span className="text-muted-foreground">-</span>;
  return (
    <div className="flex flex-wrap gap-2">
      {ids.map((id) => (
        <Badge key={id} variant="default">
          {id}
        </Badge>
      ))}
    </div>
  );
}

export function AgentDetailsPage() {
  const { useCaseId, useCaseType } = useParams();
  const { push: toast } = useToast();
  const [assignOpen, setAssignOpen] = useState(false);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const q = useQuery({
    queryKey: ['portalDeploymentDetails', useCaseId, useCaseType],
    queryFn: async () => {
      if (!useCaseId) throw new Error('Missing useCaseId');
      return await getDeploymentDetails(useCaseId, useCaseType);
    },
    enabled: Boolean(useCaseId),
    staleTime: 0,
    refetchOnMount: 'always'
  });

  const meQ = useQuery({
    queryKey: ['portalMe'],
    queryFn: async () => await getMe(),
    staleTime: 30_000
  });
  const isCustomerAdmin = Array.isArray((meQ.data as any)?.groups) && (meQ.data as any).groups.includes('customer_admin');

  const supervisorsQ = useQuery({
    queryKey: ['portalUseCaseSupervisors', useCaseId],
    queryFn: async () => {
      if (!useCaseId) throw new Error('Missing useCaseId');
      return await getUseCaseSupervisors(useCaseId);
    },
    enabled: Boolean(useCaseId) && Boolean(isCustomerAdmin),
    staleTime: 0,
    refetchOnMount: 'always'
  });

  const usersQ = useQuery({
    queryKey: ['portalUsersForSupervisorAssign'],
    queryFn: async () => await listPortalUsers(),
    enabled: Boolean(assignOpen) && Boolean(isCustomerAdmin),
    staleTime: 0
  });

  const customerUsers = useMemo(() => {
    const all: PortalUser[] = (usersQ.data as any)?.users ?? [];
    return all.filter((u) => (u.groupName ?? '').toLowerCase() === 'customer_user');
  }, [usersQ.data]);

  const supervisorUsernames = useMemo(() => {
    const v: string[] = (supervisorsQ.data as any)?.usernames ?? [];
    return Array.isArray(v) ? v : [];
  }, [supervisorsQ.data]);

  const openAssign = () => {
    const map: Record<string, boolean> = {};
    supervisorUsernames.forEach((u) => (map[u] = true));
    setSelected(map);
    setAssignOpen(true);
  };

  const saveAssign = async () => {
    if (!useCaseId) return;
    const usernames = Object.entries(selected)
      .filter(([, v]) => v)
      .map(([k]) => k);
    try {
      await setUseCaseSupervisors(useCaseId, usernames);
      toast({ title: 'Saved', message: 'Supervisor assignments updated.', variant: 'success' });
      setAssignOpen(false);
      supervisorsQ.refetch();
    } catch (e: any) {
      toast({ title: 'Save failed', message: e?.message ?? 'Failed to update supervisors', variant: 'error', timeoutMs: 8000 });
    }
  };

  const d: any = q.data;
  const hasWeb = Boolean(d?.cloudFrontWebUrl);
  const hasVoice = Boolean(d?.VoicePhoneNumber?.trim?.());
  const status = d?.status ?? d?.Status ?? 'unknown';
  const model =
    d?.LlmParams?.BedrockLlmParams?.InferenceProfileId ??
    d?.LlmParams?.BedrockLlmParams?.ModelId ??
    d?.ModelProviderName ??
    '-';
  const systemPrompt =
    d?.AgentBuilderParams?.SystemPrompt ??
    d?.WorkflowParams?.SystemPrompt ??
    '-';
  const tools =
    d?.AgentBuilderParams?.Tools ??
    d?.WorkflowParams?.AgentsAsToolsParams?.Agents ??
    undefined;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-muted-foreground">
            <Link to="/app/agents" className="hover:underline">
              Agents
            </Link>{' '}
            / {d?.UseCaseName ?? 'Details'}
          </div>
          <h1 className="mt-1 text-2xl font-semibold">{d?.UseCaseName ?? 'Deployment'}</h1>
        </div>
      </div>

      {q.isLoading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : q.isError ? (
        <div className="text-sm text-muted-foreground">Failed to load details.</div>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Overview</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Status</span>
                <span>{status}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Enabled Channels</span>
                <div className="flex gap-2">
                  {hasWeb && <Badge variant="blue">Web</Badge>}
                  {hasVoice && <Badge variant="green">Voice</Badge>}
                  {!hasWeb && !hasVoice && <span className="text-muted-foreground">-</span>}
                </div>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Voice Phone</span>
                <span>{d?.VoicePhoneNumber?.trim?.() ? d.VoicePhoneNumber : '-'}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Model</span>
                <span className="max-w-[22rem] truncate" title={model}>
                  {model}
                </span>
              </div>
              <div className="space-y-2">
                <span className="text-muted-foreground">Capabilities / Tools</span>
                <ToolsList tools={d?.AgentBuilderParams?.Tools} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>System Prompt</CardTitle>
            </CardHeader>
            <CardContent>
              <pre className="max-h-[420px] whitespace-pre-wrap rounded-md border border-border bg-background p-4 text-xs text-foreground">
                {systemPrompt}
              </pre>
            </CardContent>
          </Card>

          {isCustomerAdmin && (
            <Card className="lg:col-span-2">
              <CardHeader>
                <div className="flex items-center justify-between gap-4">
                  <CardTitle>Supervisors</CardTitle>
                  <Button type="button" variant="secondary" onClick={openAssign}>
                    Assign supervisors
                  </Button>
                </div>
              </CardHeader>
              <CardContent>
                {supervisorsQ.isLoading ? (
                  <div className="text-sm text-muted-foreground">Loading supervisors…</div>
                ) : supervisorUsernames.length === 0 ? (
                  <div className="text-sm text-muted-foreground">No supervisors assigned.</div>
                ) : (
                  <div className="flex flex-wrap gap-2">
                    {supervisorUsernames.map((u) => (
                      <Badge key={u} variant="default">
                        {u}
                      </Badge>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}
        </div>
      )}

      {assignOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Close assign supervisors modal"
            onClick={() => setAssignOpen(false)}
          />
          <div className="relative w-full max-w-2xl rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div className="text-lg font-semibold">Assign supervisors</div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
                onClick={() => setAssignOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="mt-4">
              {usersQ.isLoading ? (
                <div className="text-sm text-muted-foreground">Loading users…</div>
              ) : customerUsers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
                  No supervisor users exist yet. Invite a <span className="font-medium">customer_user</span> from the Users page
                  first.
                </div>
              ) : (
                <div className="grid gap-2 sm:grid-cols-2">
                  {customerUsers.map((u) => (
                    <label
                      key={u.username}
                      className="flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 hover:bg-muted/50"
                    >
                      <input
                        type="checkbox"
                        className="mt-1 h-4 w-4"
                        checked={Boolean(selected[u.username])}
                        onChange={(e) => setSelected((prev) => ({ ...prev, [u.username]: e.target.checked }))}
                      />
                      <div className="min-w-0">
                        <div className="truncate text-sm font-medium">{u.username}</div>
                        <div className="mt-1 truncate text-xs text-muted-foreground">{u.email || '—'}</div>
                      </div>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="mt-6 flex items-center justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => setAssignOpen(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={usersQ.isLoading} onClick={saveAssign}>
                Save
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



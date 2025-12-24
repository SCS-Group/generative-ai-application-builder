import { useEffect, useMemo, useState } from 'react';
import { Card, CardContent } from '@/portal/ui/Card';
import { Input } from '@/portal/ui/Input';
import { Label } from '@/portal/ui/Label';
import { Button } from '@/portal/ui/Button';
import { Badge } from '@/portal/ui/Badge';
import { invitePortalUser, listPortalUsers, type PortalUser } from '@/portal/api/users';
import { useToast } from '@/portal/ui/toast';

function usernameFromEmail(email: string): string {
  const raw = (email || '').trim().toLowerCase();
  if (!raw) return '';
  const prefix = raw.includes('@') ? raw.split('@')[0] : raw;
  // keep conservative set: [a-z0-9._-] and replace the rest with '-'
  return prefix
    .replace(/@/g, '')
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '')
    .slice(0, 128);
}

export function UsersPage() {
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);

  const [inviteOpen, setInviteOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [usernameTouched, setUsernameTouched] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const { push: toast } = useToast();

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    listPortalUsers()
      .then((resp) => {
        if (!mounted) return;
        setUsers(resp.users ?? []);
      })
      .catch((e: any) => {
        if (!mounted) return;
        const raw = e?.message ?? 'Failed to load users';
        const hint =
          raw === 'Network Error'
            ? 'Network Error: failed to reach /portal/users. This usually means the backend API route is not deployed yet, blocked by auth/policy, or CORS is misconfigured.'
            : raw;
        toast({ title: 'Failed to load users', message: hint, variant: 'error', timeoutMs: 8000 });
      })
      .finally(() => mounted && setLoading(false));
    return () => {
      mounted = false;
    };
  }, [refreshNonce]);

  useEffect(() => {
    if (usernameTouched) return;
    setUsername(usernameFromEmail(email));
  }, [email, usernameTouched]);

  const canSubmit = useMemo(() => {
    return email.trim().length > 3 && username.trim().length > 0 && !submitting;
  }, [email, username, submitting]);

  const onInvite = async () => {
    setSubmitting(true);
    try {
      const resp = await invitePortalUser({ email: email.trim(), username: username.trim() || undefined });
      toast({
        title: 'User invited',
        message: `Invited ${resp.email} (username: ${resp.username}). They will receive an email with a temporary password.`,
        variant: 'success'
      });
      setEmail('');
      setUsername('');
      setUsernameTouched(false);
      setInviteOpen(false);
      setRefreshNonce((n) => n + 1);
    } catch (e: any) {
      toast({ title: 'Invite failed', message: e?.message ?? 'Failed to invite user', variant: 'error', timeoutMs: 8000 });
    } finally {
      setSubmitting(false);
    }
  };

  const statusBadge = (s: string) => {
    const v = (s || '').toLowerCase();
    if (v === 'active') return <Badge variant="success">active</Badge>;
    if (v === 'invited') return <Badge variant="warning">invited</Badge>;
    if (v === 'disabled') return <Badge variant="destructive">disabled</Badge>;
    return <Badge>{s || 'unknown'}</Badge>;
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">Users</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Invite tenant users (supervisors) and track their status.
          </p>
        </div>
        <Button
          type="button"
          onClick={() => {
            setInviteOpen(true);
          }}
        >
          Invite user
        </Button>
      </div>

      <Card>
        <CardContent>
          {loading ? (
            <div className="py-10 text-sm text-muted-foreground">Loading users…</div>
          ) : (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {users.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border p-6 text-sm text-muted-foreground sm:col-span-2 lg:col-span-3">
                  No users found. Click <span className="font-medium">Invite user</span> to add one.
                </div>
              ) : (
                <>
                  {users.map((u) => (
                    <div key={u.username} className="rounded-lg border border-border p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="truncate text-sm font-medium">{u.username}</div>
                          <div className="mt-1 truncate text-xs text-muted-foreground">{u.email || '—'}</div>
                        </div>
                        <div className="shrink-0">{statusBadge(u.status)}</div>
                      </div>
                      {u.groupName && (
                        <div className="mt-3 text-xs text-muted-foreground">
                          group: <span className="font-medium">{u.groupName}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      {inviteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <button
            type="button"
            className="absolute inset-0 bg-black/50"
            aria-label="Close invite modal"
            onClick={() => setInviteOpen(false)}
          />
          <div className="relative w-full max-w-lg rounded-xl border border-border bg-card p-6 shadow-xl">
            <div className="flex items-center justify-between gap-4">
              <div className="text-lg font-semibold">Invite user</div>
              <button
                type="button"
                className="rounded-md px-2 py-1 text-sm text-muted-foreground hover:bg-muted"
                onClick={() => setInviteOpen(false)}
              >
                Close
              </button>
            </div>

            <div className="mt-4 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="invite-email">Email</Label>
                <Input
                  id="invite-email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="user@company.com"
                  autoComplete="email"
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="invite-username">Username</Label>
                <Input
                  id="invite-username"
                  value={username}
                  onChange={(e) => {
                    setUsernameTouched(true);
                    setUsername(e.target.value);
                  }}
                  placeholder="username"
                  autoComplete="username"
                />
                <div className="text-xs text-muted-foreground">
                  Default is derived from email prefix; you can override.
                </div>
              </div>

              <div className="flex items-center justify-end gap-2">
                <Button type="button" variant="secondary" onClick={() => setInviteOpen(false)}>
                  Cancel
                </Button>
                <Button type="button" disabled={!canSubmit} onClick={onInvite}>
                  {submitting ? 'Inviting…' : 'Invite'}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}



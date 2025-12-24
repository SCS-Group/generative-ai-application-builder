import { Outlet, NavLink, useNavigate } from 'react-router-dom';
import { Auth } from 'aws-amplify';
import { Button } from '@/portal/ui/Button';
import { cn } from '@/portal/lib/cn';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from '@/portal/theme/ThemeProvider';
import { Input } from '@/portal/ui/Input';
import {
  Settings as SettingsIcon,
  Sun as SunIcon,
  Moon as MoonIcon,
  Monitor as MonitorIcon,
  Copy as CopyIcon,
  User as UserIcon,
  Menu as MenuIcon,
  X as CloseIcon
} from 'lucide-react';

const navItems = [
  { to: '/app/agents', label: 'Agents' },
  { to: '/app/usage', label: 'Usage' }
];

function Icon({
  name,
  className
}: {
  name: 'gear' | 'sun' | 'moon' | 'monitor' | 'copy' | 'user' | 'menu' | 'close';
  className?: string;
}) {
  const common = cn('h-4 w-4', className);
  switch (name) {
    case 'gear':
      return <SettingsIcon className={common} aria-hidden="true" />;
    case 'sun':
      return <SunIcon className={common} aria-hidden="true" />;
    case 'moon':
      return <MoonIcon className={common} aria-hidden="true" />;
    case 'monitor':
      return <MonitorIcon className={common} aria-hidden="true" />;
    case 'copy':
      return <CopyIcon className={common} aria-hidden="true" />;
    case 'user':
      return <UserIcon className={common} aria-hidden="true" />;
    case 'menu':
      return <MenuIcon className={common} aria-hidden="true" />;
    case 'close':
      return <CloseIcon className={common} aria-hidden="true" />;
  }
}

function ThemeSegment() {
  const { theme, setTheme } = useTheme();
  const items: Array<{ key: 'light' | 'dark' | 'system'; icon: 'sun' | 'moon' | 'monitor'; label: string }> = [
    { key: 'light', icon: 'sun', label: 'Light' },
    { key: 'dark', icon: 'moon', label: 'Dark' },
    { key: 'system', icon: 'monitor', label: 'System' }
  ];

  return (
    <div className="flex items-center gap-1 rounded-lg bg-background p-1">
      {items.map((i) => (
        <button
          key={i.key}
          type="button"
          onClick={() => setTheme(i.key)}
          className={cn(
            'flex items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors',
            theme === i.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted'
          )}
          aria-label={i.label}
          title={i.label}
        >
          <Icon name={i.icon} />
        </button>
      ))}
    </div>
  );
}

function UserMenu() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [displayName, setDisplayName] = useState<string>('User');
  const [email, setEmail] = useState<string>('');
  const menuRef = useRef<HTMLDivElement | null>(null);

  const initials = useMemo(() => {
    const base = displayName?.trim() || email?.trim() || 'U';
    const parts = base.split(/\s+/).filter(Boolean);
    const a = parts[0]?.[0] ?? 'U';
    const b = parts.length > 1 ? parts[1]?.[0] : (parts[0]?.[1] ?? '');
    return (a + b).toUpperCase();
  }, [displayName, email]);

  useEffect(() => {
    let mounted = true;
    Auth.currentAuthenticatedUser()
      .then((u: any) => {
        if (!mounted) return;
        const attrs = u?.attributes ?? {};
        setEmail(attrs.email ?? '');
        setDisplayName(attrs.name ?? attrs.given_name ?? u?.username ?? 'User');
      })
      .catch(() => {});
    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!menuRef.current) return;
      if (!menuRef.current.contains(e.target as any)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  return (
    <div ref={menuRef} className="relative flex items-center gap-2">
      {/* Settings cog */}
      <button
        type="button"
        onClick={() => navigate('/app/settings')}
        className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted"
        aria-label="Settings"
        title="Settings"
      >
        <Icon name="gear" className="h-5 w-5" />
      </button>

      {/* User dropdown trigger */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-11 w-11 items-center justify-center rounded-full border border-border bg-background text-sm hover:bg-muted"
        aria-label="User menu"
      >
        <Icon name="user" className="h-6 w-6" />
      </button>

      {open && (
        <div className="absolute right-0 top-11 w-80 rounded-xl border border-border bg-card shadow-xl">
          <div className="p-4">
            <div className="text-base font-semibold">{displayName}</div>
            {email && <div className="mt-1 text-sm text-muted-foreground">{email}</div>}

            <div className="mt-3">
              <ThemeSegment />
            </div>
          </div>

          <div className="border-t border-border p-2">
            <button
              type="button"
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={() => {
                setOpen(false);
                navigate('/app/profile');
              }}
            >
              Your profile
            </button>
            <button
              type="button"
              className="w-full rounded-md px-3 py-2 text-left text-sm hover:bg-muted"
              onClick={async () => {
                setOpen(false);
                try {
                  // Use global sign-out to be robust across Hosted UI / federated sessions.
                  await Auth.signOut({ global: true } as any);
                } catch {
                  // ignore - we'll still force navigation below
                } finally {
                  // The App component only checks auth on initial mount; force a reload to reflect signed-out state.
                  window.location.assign('/');
                }
              }}
            >
              Log out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function AppShell() {
  const navigate = useNavigate();
  const [isMobile, setIsMobile] = useState<boolean>(() => window.innerWidth < 1024);
  const [sidebarOpen, setSidebarOpen] = useState<boolean>(() => (window.innerWidth < 1024 ? false : true));
  const [search, setSearch] = useState<string>('');

  useEffect(() => {
    const mq = window.matchMedia('(min-width: 1024px)');
    const apply = () => {
      const nowMobile = !mq.matches;
      setIsMobile(nowMobile);
      if (nowMobile) {
        // Auto-collapse on smaller screens
        setSidebarOpen(false);
      } else {
        // Always show sidebar on desktop
        setSidebarOpen(true);
      }
    };
    apply();
    mq.addEventListener?.('change', apply);
    return () => mq.removeEventListener?.('change', apply);
  }, []);

  return (
    <div className="min-h-screen bg-background">
      {/* Top nav (full width) */}
      <header className="sticky top-0 z-20 flex h-16 items-center justify-between border-b border-border bg-background px-6">
        <div className="flex items-center gap-3">
          {/* Hamburger only on small screens (sidebar auto-collapses) */}
          {isMobile && (
            <button
              type="button"
              className="inline-flex h-11 w-11 items-center justify-center rounded-md border border-border bg-background text-foreground hover:bg-muted"
              aria-label={sidebarOpen ? 'Close menu' : 'Open menu'}
              title={sidebarOpen ? 'Close menu' : 'Open menu'}
              onClick={() => setSidebarOpen((v) => !v)}
            >
              <Icon name={sidebarOpen ? 'close' : 'menu'} className="h-6 w-6" />
            </button>
          )}
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg border border-border bg-muted" />
            <div className="text-sm font-semibold tracking-wide">AiAgentsWorkforce</div>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <UserMenu />
        </div>
      </header>

      {/* Body: sidebar starts under top nav */}
      <div className="flex min-h-[calc(100vh-4rem)]">
        {/* Mobile backdrop */}
        {isMobile && sidebarOpen && (
          <button
            type="button"
            aria-label="Close menu"
            className="fixed inset-0 z-10 bg-black/40"
            onClick={() => setSidebarOpen(false)}
          />
        )}

        {/* Sidebar */}
        <aside
          className={cn(
            'z-20 w-72 border-r border-border bg-background p-4',
            isMobile
              ? cn(
                  'fixed left-0 top-16 h-[calc(100vh-4rem)] shadow-xl transition-transform',
                  sidebarOpen ? 'translate-x-0' : '-translate-x-full'
                )
              : 'sticky top-16 h-[calc(100vh-4rem)]'
          )}
        >
          <div className="space-y-3">
            <div className="relative">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search"
                className="pr-16"
              />
              <div className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                ⌘K
              </div>
            </div>

            <div className="pt-2">
              <div className="px-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Get started
              </div>
              <nav className="mt-2 space-y-1">
                {navItems.map((n) => (
                  <NavLink
                    key={n.to}
                    to={n.to}
                    onClick={() => {
                      if (isMobile) setSidebarOpen(false);
                    }}
                    className={({ isActive }) =>
                      cn(
                        'block rounded-md px-3 py-2 text-sm',
                        isActive ? 'bg-muted font-medium' : 'hover:bg-muted'
                      )
                    }
                  >
                    {n.label}
                  </NavLink>
                ))}
              </nav>
            </div>
          </div>
        </aside>

        <main className="flex-1 px-6 py-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}



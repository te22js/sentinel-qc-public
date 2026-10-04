/** App shell: minimal left rail with icons + auth gate. */
import { Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, announceSessionChange, type Me } from './api';

export function useMe() {
  return useQuery<Me>({
    queryKey: ['me'],
    queryFn: () => api.get<Me>('/auth/me'),
    retry: false,
    refetchOnWindowFocus: true,
    refetchInterval: 60_000,
  });
}

const stroke = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;

const ICONS: Record<string, ReactNode> = {
  qc: (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2" />
      <rect x="9" y="3" width="6" height="4" rx="1" />
      <path d="m9 14 2 2 4-4.5" />
    </svg>
  ),
  history: (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
    </svg>
  ),
  monitoring: (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M3 12h4l2.5-6 4 12L16 12h5" />
    </svg>
  ),
  plates: (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <rect x="4" y="4" width="16" height="16" rx="2.5" />
      <circle cx="9" cy="9" r="1.1" />
      <circle cx="15" cy="9" r="1.1" />
      <circle cx="9" cy="15" r="1.1" />
      <circle cx="15" cy="15" r="1.1" />
    </svg>
  ),
  guide: (
    <svg width="15" height="15" viewBox="0 0 24 24" {...stroke}>
      <path d="M12 6.5C10.5 5 8.5 4.5 6 4.5c-1 0-2 .15-3 .5v14c1-.35 2-.5 3-.5 2.5 0 4.5.5 6 2 1.5-1.5 3.5-2 6-2 1 0 2 .15 3 .5v-14c-1-.35-2-.5-3-.5-2.5 0-4.5.5-6 2Z" />
      <path d="M12 6.5V20.5" />
    </svg>
  ),
};

const NAV = [
  { to: '/', label: 'QC', icon: 'qc' },
  { to: '/history', label: 'History', icon: 'history' },
  { to: '/monitoring', label: 'Monitoring', icon: 'monitoring' },
  { to: '/plates', label: 'Plates', icon: 'plates' },
  { to: '/guide', label: 'Guide', icon: 'guide' },
] as const;

function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="inline-grid place-items-center w-[22px] h-[22px] rounded-[7px] bg-blue-700 shadow-[0_1px_3px_rgba(29,78,216,0.4)]">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M3 13h4l2.5-6 4 11L16 13h5" />
        </svg>
      </span>
      <span className="font-semibold tracking-[-0.02em] text-slate-900 text-[13.5px]">Sentinel QC</span>
    </span>
  );
}

export function Shell() {
  const me = useMe();
  const qc = useQueryClient();
  const path = useRouterState({ select: (s) => s.location.pathname });
  useEffect(() => {
    const reset = () => { qc.clear(); window.location.replace('/'); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) reset(); };
    window.addEventListener('sentinel-session-ended', reset);
    window.addEventListener('pageshow', restored);
    const expiry = me.data?.expiresAt;
    const timer = expiry ? window.setTimeout(reset, Math.max(0, Date.parse(expiry) - Date.now())) : undefined;
    return () => {
      window.removeEventListener('sentinel-session-ended', reset);
      window.removeEventListener('pageshow', restored);
      window.clearTimeout(timer);
    };
  }, [qc, me.data?.expiresAt]);

  if (me.isLoading) {
    return <div className="min-h-screen grid place-items-center text-slate-400">Loading…</div>;
  }
  if (me.isError) {
    const err = me.error;
    if (err instanceof ApiError && err.status === 401) return <LoginScreen />;
    return (
      <div className="min-h-screen grid place-items-center text-slate-500">
        <div className="text-center">
          <p>Cannot reach the Sentinel QC server.</p>
          <p className="text-slate-400 mt-1">{String(me.error)}</p>
        </div>
      </div>
    );
  }
  const user = me.data!;
  return (
    <div className="min-h-screen flex flex-col md:flex-row">
      <nav aria-label="Main navigation" className="w-full md:w-52 shrink-0 flex flex-col py-4 md:py-5 px-3.5 border-b md:border-b-0 md:border-r border-slate-200/60">
        <div className="px-2.5 pb-6">
          <Brand />
        </div>
        <div className="px-2.5 pb-2 microlabel">Workflow</div>
        <div className="flex flex-wrap md:block flex-1 gap-1 md:space-y-0.5 mb-3 md:mb-0">
          {NAV.map((item) => {
            const active = item.to === '/' ? path === '/' : path.startsWith(item.to);
            return (
              <Link
                key={item.to}
                to={item.to}
                aria-current={active ? 'page' : undefined}
                className={`flex items-center gap-2.5 px-2.5 py-[7px] rounded-lg font-medium tracking-[-0.01em] ${
                  active
                    ? 'bg-white text-blue-700 shadow-[0_1px_3px_rgba(15,23,42,0.07)] border border-slate-200/80'
                    : 'text-slate-500 hover:text-slate-900 hover:bg-slate-200/40'
                }`}
              >
                <span className={active ? 'text-blue-700' : 'text-slate-400'}>{ICONS[item.icon]}</span>
                {item.label}
              </Link>
            );
          })}
        </div>
        <UserBox user={user} />
      </nav>
      <main className="flex-1 min-w-0 px-4 md:px-7 py-5 md:py-6"><div className="max-w-[1000px] mx-auto">
        <div className="mb-5 flex flex-wrap items-center justify-between gap-2 border-b border-slate-200/70 pb-3 text-[11px]">
          <span className="inline-flex items-center gap-1.5 font-medium text-slate-600">
            <svg width="12" height="13" viewBox="0 0 20 22" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true"><rect x="3" y="9" width="14" height="11" rx="2" /><path d="M6 9V6a4 4 0 0 1 8 0v3" /></svg>
            Private session
            <span className="font-normal text-slate-400">· ends {new Date(user.expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
          </span>
          <span className="text-slate-500">Download your reports before signing out.</span>
        </div>
        <Outlet />
        </div>
      </main>
    </div>
  );
}

function UserBox({ user }: { user: Me }) {
  const qc = useQueryClient();
  return (
    <div className="mx-1 px-2 py-2 flex items-center gap-2.5 rounded-lg border border-slate-200/70 bg-white/60">
      <span className="w-6 h-6 rounded-full bg-slate-200 text-slate-600 grid place-items-center text-[10.5px] font-semibold">
        {user.displayName.slice(0, 1).toUpperCase()}
      </span>
      <span className="flex-1 truncate text-slate-600 text-[12px]" title={`${user.displayName} (${user.role})`}>
        {user.displayName}
      </span>
      <button
        className="text-slate-300 hover:text-slate-700"
        title="Sign out and clear this workspace"
        aria-label="Sign out and clear this workspace"
        onClick={async () => {
          await api.post('/auth/logout');
          announceSessionChange();
          qc.clear();
          location.reload();
        }}
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5" />
          <path d="M21 12H9" />
        </svg>
      </button>
    </div>
  );
}

function LoginScreen() {
  const qc = useQueryClient();
  const [username, setUsername] = useState('labqc'); // shared lab account
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('/auth/login', { username, password });
      announceSessionChange();
      qc.clear();
      window.location.replace('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'login failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="min-h-screen grid place-items-center"
      style={{
        background:
          'radial-gradient(700px 420px at 18% 8%, rgba(29,78,216,0.07), transparent 60%), radial-gradient(600px 400px at 85% 90%, rgba(29,78,216,0.05), transparent 60%), #f6f7f9',
      }}
    >
      <div className="w-[360px] max-w-[calc(100vw-32px)]">
        <form onSubmit={submit} className="card p-7 space-y-4" style={{ boxShadow: '0 8px 30px rgba(15,23,42,0.08)' }}>
          <div className="space-y-2">
            <Brand />
            <p className="text-slate-400">Quality control for the bench — Levey–Jennings, Westgard rules and clean PDF reports, in seconds per run.</p>
          </div>
          <label className="block">
            <span className="microlabel">Username</span>
            <input className="w-full mt-1" autoComplete="username" maxLength={60} value={username} onChange={(e) => setUsername(e.target.value)} />
          </label>
          <label className="block">
            <span className="microlabel">Password</span>
            <input type="password" autoComplete="current-password" maxLength={256} className="w-full mt-1" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
          </label>
          {error && <p className="text-red-600">{error}</p>}
          <button type="submit" className="btn-primary w-full" disabled={busy || !username || !password}>
            {busy ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        <p className="text-center text-slate-500 text-[11px] mt-4">Shared sign-in · private, temporary workspace</p>
        <p className="text-center text-slate-400 text-[11px] mt-1">Use separate browser profiles for different people on one device.</p>
      </div>
    </div>
  );
}

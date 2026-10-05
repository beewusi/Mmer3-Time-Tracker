import { useState, useEffect, useRef } from 'react';
import { supabase, ADMIN_EMAIL } from './supabase';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import ResetPassword from './pages/ResetPassword';
import Legal from './pages/Legal';
import PendingApproval from './pages/PendingApproval';
import Dashboard from './pages/Dashboard';
import AdminDashboard from './pages/AdminDashboard';
import Companion from './pages/Companion';
import { HourglassIcon } from './icons';

// /privacy and /terms are public pages, opened in their own tab
const LEGAL_PATH = window.location.pathname.replace(/\/+$/, '');
// /companion is what the desktop app shows (sign in, then the small window)
const IS_COMPANION = LEGAL_PATH === '/companion';
// signed in longer than this = sign in again (not the desktop app, which
// stays signed in on its own laptop)
const MAX_SESSION_HOURS = 12;

function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState('login');
  const [pendingStatus, setPendingStatus] = useState('pending');
  const [loading, setLoading] = useState(true);
  const [loginNotice, setLoginNotice] = useState('');
  // Opened from a password reset link. Stays on the set new password screen
  // until it's saved, even though Supabase has already signed them in.
  const recoveryRef = useRef(/type=recovery/.test(window.location.hash + window.location.search));

  // Admin is identified by ADMIN_EMAIL and skips approval. Everyone else needs
  // profiles.status = 'approved'.
  async function resolvePageForUser(sessionUser) {
    if (sessionUser.email === ADMIN_EMAIL) {
      return 'admin';
    }

    const { data: profile, error } = await supabase
      .from('profiles')
      .select('status')
      .eq('id', sessionUser.id)
      .maybeSingle();

    // No profile row yet (new Google sign-in before the trigger runs) counts
    // as pending.
    if (error || !profile || profile.status !== 'approved') {
      setPendingStatus(profile?.status || 'pending');
      return 'pending-approval';
    }

    return 'dashboard';
  }

  // Normal routing after sign-in, skipped while a password reset is in progress.
  // Checked again after the await since the recovery event can land in between.
  async function routeSignedInUser(sessionUser) {
    if (recoveryRef.current) {
      setPage('reset-password');
      return;
    }
    const next = await resolvePageForUser(sessionUser);
    setPage(recoveryRef.current ? 'reset-password' : next);
  }

  useEffect(() => {
    supabase.auth.getSession().then(async ({ data: { session } }) => {
      if (session) {
        setUser(session.user);
        await routeSignedInUser(session.user);
      }
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      async (event, session) => {
        // Password reset link goes to the set new password screen.
        if (event === 'PASSWORD_RECOVERY') {
          recoveryRef.current = true;
          if (session) setUser(session.user);
          setPage('reset-password');
          return;
        }
        if (session) {
          setUser(session.user);
          await routeSignedInUser(session.user);
        } else {
          recoveryRef.current = false;
          setUser(null);
          setPage('login');
        }
      }
    );

    return () => subscription.unsubscribe();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // New password saved from the reset link: tidy the link out of the
  // address bar and carry on into the app (they're already signed in).
  async function finishPasswordReset() {
    recoveryRef.current = false;
    window.history.replaceState(null, '', window.location.pathname);
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      setUser(session.user);
      setPage(await resolvePageForUser(session.user));
    } else {
      setPage('login');
    }
  }

  async function handleLogout(notice = '') {
    recoveryRef.current = false;
    await supabase.auth.signOut();
    setUser(null);
    setLoginNotice(typeof notice === 'string' ? notice : '');
    setPage('login');
  }

  // 12-hour limit, checked every minute
  useEffect(() => {
    if (!user || IS_COMPANION || page === 'reset-password') return undefined;
    const check = () => {
      const since = user.last_sign_in_at ? new Date(user.last_sign_in_at).getTime() : null;
      if (since && Date.now() - since > MAX_SESSION_HOURS * 3600 * 1000) {
        handleLogout(`You were signed out after ${MAX_SESSION_HOURS} hours. Please sign in again.`);
      }
    };
    check();
    const t = setInterval(check, 60000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user, page]);

  // Account removed or no longer approved: out straight away, not on the
  // next 30-second check (needs profiles in realtime, clock_in_checks.sql)
  useEffect(() => {
    if (!user || user.email === ADMIN_EMAIL) return undefined;
    const channel = supabase
      .channel(`account-${user.id}`)
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'profiles' }, payload => {
        if (payload.old?.id === user.id) {
          handleLogout('Your account has been removed. Please contact your admin.');
        }
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'profiles', filter: `id=eq.${user.id}` }, payload => {
        if (payload.new && payload.new.status !== 'approved') {
          setPendingStatus(payload.new.status || 'pending');
          setPage('pending-approval');
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleRecheckApproval() {
    if (!user) return;
    setPage(await resolvePageForUser(user));
  }

  if (LEGAL_PATH === '/privacy' || LEGAL_PATH === '/terms') {
    return <Legal doc={LEGAL_PATH.slice(1)} />;
  }

  if (loading) {
    return (
      <div className="app-loading">
        <HourglassIcon width={28} height={28} />
        <span>Loading Mmerℇ...</span>
      </div>
    );
  }

  return (
    <>
      {page === 'signup' && (
        <SignUp onGoToLogin={() => setPage('login')} />
      )}

      {page === 'login' && (
        <Login
          key={loginNotice}
          notice={loginNotice}
          hideGoogle={IS_COMPANION}
          onLogin={async (loggedInUser) => {
            setLoginNotice('');
            setUser(loggedInUser);
            setPage(await resolvePageForUser(loggedInUser));
          }}
          onGoToSignUp={() => setPage('signup')}
        />
      )}

      {page === 'reset-password' && (
        <ResetPassword onGoToLogin={handleLogout} onDone={finishPasswordReset} />
      )}

      {page === 'pending-approval' && (
        <PendingApproval
          status={pendingStatus}
          onLogout={handleLogout}
          onRefresh={handleRecheckApproval}
        />
      )}

      {page === 'admin' && IS_COMPANION && (
        <div className="app-loading">
          <span>The desktop app is for employee accounts. Sign in as the employee who uses this laptop.</span>
          <button className="sec-btn-secondary" onClick={handleLogout}>Sign out</button>
        </div>
      )}

      {page === 'dashboard' && IS_COMPANION && (
        <Companion user={user} onLogout={handleLogout} />
      )}

      {page === 'admin' && !IS_COMPANION && (
        <AdminDashboard
          user={user}
          onLogout={handleLogout}
        />
      )}

      {page === 'dashboard' && !IS_COMPANION && (
        <Dashboard
          user={user}
          onLogout={handleLogout}
        />
      )}
    </>
  );
}

export default App;

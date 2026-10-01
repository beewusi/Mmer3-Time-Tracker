import { useState, useEffect, useRef } from 'react';
import { supabase, ADMIN_EMAIL } from './supabase';
import Login from './pages/Login';
import SignUp from './pages/SignUp';
import ResetPassword from './pages/ResetPassword';
import Legal from './pages/Legal';
import PendingApproval from './pages/PendingApproval';
import Dashboard from './pages/Dashboard';
import AdminDashboard from './pages/AdminDashboard';
import { HourglassIcon } from './icons';

function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState('login');
  const [pendingStatus, setPendingStatus] = useState('pending');
  const [loading, setLoading] = useState(true);
  // Privacy / Terms open on top of sign in or sign up, so the form keeps what's typed
  const [legalDoc, setLegalDoc] = useState(null);
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

  async function handleLogout() {
    recoveryRef.current = false;
    await supabase.auth.signOut();
    setUser(null);
    setPage('login');
  }

  async function handleRecheckApproval() {
    if (!user) return;
    setPage(await resolvePageForUser(user));
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
      {legalDoc && (page === 'login' || page === 'signup') && (
        <div className="legal-overlay">
          <Legal doc={legalDoc} onBack={() => setLegalDoc(null)} onSwitch={setLegalDoc} />
        </div>
      )}

      {page === 'signup' && (
        <SignUp onGoToLogin={() => setPage('login')} onOpenLegal={setLegalDoc} />
      )}

      {page === 'login' && (
        <Login
          onLogin={async (loggedInUser) => {
            setUser(loggedInUser);
            setPage(await resolvePageForUser(loggedInUser));
          }}
          onGoToSignUp={() => setPage('signup')}
          onOpenLegal={setLegalDoc}
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

      {page === 'admin' && (
        <AdminDashboard
          user={user}
          onLogout={handleLogout}
        />
      )}

      {page === 'dashboard' && (
        <Dashboard
          user={user}
          onLogout={handleLogout}
        />
      )}
    </>
  );
}

export default App;

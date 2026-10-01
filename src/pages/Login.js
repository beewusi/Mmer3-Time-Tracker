import { useState } from 'react';
import { supabase } from '../supabase';
import AuthPanel from '../components/AuthPanel';
import PasswordInput from '../components/PasswordInput';
import { AuthDivider, GoogleButton } from '../components/SocialAuth';
import './Login.css';

function Login({ onLogin, onGoToSignUp, onOpenLegal }) {
  const [mode, setMode] = useState('login'); // 'login' | 'forgot'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleLogin() {
    if (!email || !password) {
      setError('Please enter your email and password.');
      return;
    }

    setLoading(true);
    setError('');

    const { data, error } = await supabase.auth.signInWithPassword({
      email: email,
      password: password
    });

    if (error) {
      setError('Incorrect email or password. Please try again.');
      setLoading(false);
    } else {
      onLogin(data.user);
      setLoading(false);
    }
  }

  function handleGoogleLogin() {
    supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
  }

  async function handleForgotPassword() {
    if (!email) {
      setError('Enter your email above first, then request a reset link.');
      return;
    }

    setLoading(true);
    setError('');
    setInfo('');

    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin
    });

    setLoading(false);
    if (error) {
      setError(error.message);
    } else {
      setInfo('Check your inbox for a link to reset your password.');
    }
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter') handleLogin();
  }

  return (
    <div className="login-page">
      <AuthPanel>
        <h1 className="login-tagline">
          Track your time.<br />Work smarter.
        </h1>
        <p className="login-sub">
          Clock in, take breaks, and keep clean attendance records —
          with reminders so nothing slips through.
        </p>
      </AuthPanel>

      <div className="auth-right">
        <div className="auth-box">
          {mode === 'login' && (
            <>
              <h2>Welcome back</h2>
              <p className="auth-prompt">Sign in to your account</p>

              {error && <p className="form-alert">{error}</p>}
              {info && <p className="form-success">{info}</p>}

              <div className="input-group">
                <label>Email</label>
                <input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                  onKeyDown={handleKeyDown}
                />
              </div>

              <PasswordInput
                label="Password"
                placeholder="Enter your password"
                value={password}
                onChange={e => setPassword(e.target.value)}
                onKeyDown={handleKeyDown}
              />

              <span
                className="forgot-link"
                onClick={() => { setMode('forgot'); setError(''); setInfo(''); }}
              >
                Forgot password?
              </span>

              <button
                className="btn-primary login-btn"
                onClick={handleLogin}
                disabled={loading}>
                {loading ? 'Signing in...' : 'Sign In'}
              </button>

              <AuthDivider />
              <GoogleButton onClick={handleGoogleLogin} />

              <p className="auth-switch-link">
                Don't have an account?{' '}
                <span onClick={onGoToSignUp}>Sign Up</span>
              </p>

              <p className="auth-legal-note">
                By signing in, you agree to our{' '}
                <button type="button" className="auth-inline-link" onClick={() => onOpenLegal?.('terms')}>Terms of Use</button>
                {' '}and{' '}
                <button type="button" className="auth-inline-link" onClick={() => onOpenLegal?.('privacy')}>Privacy Notice</button>.
              </p>
            </>
          )}

          {mode === 'forgot' && (
            <>
              <h2>Reset your password</h2>
              <p className="auth-prompt">Enter your email and we'll send you a reset link</p>

              {error && <p className="form-alert">{error}</p>}
              {info && <p className="form-success">{info}</p>}

              <div className="input-group">
                <label>Email</label>
                <input
                  type="email"
                  placeholder="Enter your email"
                  value={email}
                  onChange={e => setEmail(e.target.value)}
                />
              </div>

              <button
                className="btn-primary"
                onClick={handleForgotPassword}
                disabled={loading}>
                {loading ? 'Sending...' : 'Send Reset Link'}
              </button>

              <button
                className="btn-secondary"
                onClick={() => { setMode('login'); setError(''); setInfo(''); }}>
                Back to Sign In
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

export default Login;

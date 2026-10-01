import { GoogleIcon } from '../icons';

export function AuthDivider() {
  return (
    <div className="auth-divider">
      <span>or continue with</span>
    </div>
  );
}

export function GoogleButton({ onClick, label = 'Continue with Google', disabled = false }) {
  return (
    <button type="button" className="social-btn" onClick={onClick} disabled={disabled}>
      <GoogleIcon />
      <span>{label}</span>
    </button>
  );
}

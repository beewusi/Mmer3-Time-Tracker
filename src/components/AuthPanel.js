import AnimatedHourglass from './AnimatedHourglass';
import './AuthPanel.css';

// Dark left panel for Login, SignUp and ResetPassword. Text comes in as
// children. On small screens it shrinks to a brand bar above the form.
function AuthPanel({ children }) {
  return (
    <div className="auth-panel">
      <div className="auth-panel-inner">
        <div className="auth-brand">
          <AnimatedHourglass size={44} />
          <span className="auth-brand-name">Mmerℇ</span>
        </div>
        {/* only shown on small screens, where the page text below is hidden */}
        <p className="auth-brand-tag">Track your time. Work smarter.</p>
        {children}
      </div>
    </div>
  );
}

export default AuthPanel;

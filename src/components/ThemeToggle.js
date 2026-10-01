import { MoonIcon, SunIcon } from '../icons';

// Icon-only light/dark switch, top right on both dashboards.
// The icon is keyed on the mode so it replays the spin-in each time.
function ThemeToggle({ isDarkMode, onToggle }) {
  const label = isDarkMode ? 'Switch to light mode' : 'Switch to dark mode';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      title={label}
      aria-label={label}>
      <span className="theme-toggle-icon" key={isDarkMode ? 'sun' : 'moon'}>
        {isDarkMode ? <SunIcon width={17} height={17} /> : <MoonIcon width={17} height={17} />}
      </span>
    </button>
  );
}

export default ThemeToggle;

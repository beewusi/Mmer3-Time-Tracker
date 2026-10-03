import { useEffect, useMemo, useRef, useState } from 'react';
import { SearchIcon } from '../icons';
import './EmployeeSearch.css';

// Find anyone fast: Ctrl+K (Cmd+K on a Mac) or "/" anywhere on the admin
// dashboard. Enter opens their details; Timesheet / Activity jump straight there.

const STATUS_TEXT = {
  clocked_in: 'Clocked in', on_break: 'On break', clocked_out: 'Clocked out',
  on_leave: 'On leave', not_clocked_in: 'Not clocked in'
};

export function useSearchShortcut(open) {
  useEffect(() => {
    function onKey(e) {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        open();
      } else if (e.key === '/' && !typing) {
        e.preventDefault();
        open();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
}

export const SEARCH_HINT = typeof navigator !== 'undefined' && /Mac/i.test(navigator.platform || navigator.userAgent) ? '⌘K' : 'Ctrl K';

function EmployeeSearch({ employees, getStatus, onClose, onOpen, onTimesheet, onActivity }) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = employees.map(e => ({
      ...e,
      haystack: `${e.full_name || ''} ${e.email || ''} ${e.department || ''}`.toLowerCase()
    }));
    const hits = q
      ? list.filter(e => q.split(/\s+/).every(part => e.haystack.includes(part)))
      : list;
    // names that start with what was typed come first
    return hits.sort((a, b) => {
      const aStart = (a.full_name || '').toLowerCase().startsWith(q) ? 0 : 1;
      const bStart = (b.full_name || '').toLowerCase().startsWith(q) ? 0 : 1;
      return aStart - bStart || (a.full_name || a.email).localeCompare(b.full_name || b.email);
    }).slice(0, 8);
  }, [employees, query]);

  useEffect(() => { setIndex(0); }, [query]);

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setIndex(i => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setIndex(i => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && results[index]) {
      e.preventDefault();
      onOpen(results[index]);
    } else if (e.key === 'Escape') {
      onClose();
    }
  }

  return (
    <div className="search-overlay" onMouseDown={onClose}>
      <div className="search-box" onMouseDown={e => e.stopPropagation()} role="dialog" aria-label="Find an employee">
        <div className="search-input-row">
          <SearchIcon width={18} height={18} />
          <input
            ref={inputRef}
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Find an employee by name, email or department"
            aria-label="Search employees"
          />
          <kbd>Esc</kbd>
        </div>
        {results.length === 0 ? (
          <p className="search-empty">No one matches “{query}”.</p>
        ) : (
          <ul className="search-results">
            {results.map((e, i) => {
              const status = getStatus(e.id);
              return (
                <li
                  key={e.id}
                  className={i === index ? 'is-active' : ''}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => onOpen(e)}>
                  <span className="search-avatar">{(e.full_name || e.email || '?')[0].toUpperCase()}</span>
                  <span className="search-who">
                    <strong>{e.full_name || e.email}</strong>
                    <span>{[e.department, STATUS_TEXT[status]].filter(Boolean).join(' · ')}</span>
                  </span>
                  <span className="search-actions">
                    <button onClick={ev => { ev.stopPropagation(); onTimesheet(e); }}>Timesheet</button>
                    <button onClick={ev => { ev.stopPropagation(); onActivity(e); }}>Activity</button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
        <p className="search-foot"><kbd>↑</kbd><kbd>↓</kbd> to move · <kbd>Enter</kbd> to open</p>
      </div>
    </div>
  );
}

export default EmployeeSearch;

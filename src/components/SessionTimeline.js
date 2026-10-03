import { useState } from 'react';
import {
  parseClockTime, minutesToHHMM, dateToHHMM, formatClock, minutesAfter,
  formatDuration, validateSession
} from '../lib/time';
import { ClockTimePicker, DurationPicker } from './TimeScrollPicker';
import { PencilIcon } from '../icons';
import AutoTextarea from './AutoTextarea';
import './SessionTimeline.css';

// One session as a list of entries: work, break, work ... clocked out.
// Work rows are the time between breaks, so neighbouring rows share their
// edge and editing one side moves the other with it.
//
// session: {
//   clockIn: "HH:MM", clockOut: "HH:MM" | null (still clocked in),
//   breaks: [{ id, start: "HH:MM", end: "HH:MM" | null (on break now) }],
//   breakTotal: "HH:MM:SS"   only used when there are no break rows (older entries)
// }
// onSave(model) gets the same shape back and returns '' or an error message.

function toSeconds(hms) {
  const parts = String(hms || '').split(':').map(Number);
  return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
}

function copySession(session) {
  return {
    clockIn: session.clockIn,
    clockOut: session.clockOut,
    breakTotal: session.breakTotal,
    breaks: [...session.breaks]
      .sort((a, b) => (minutesAfter(session.clockIn, a.start) ?? 0) - (minutesAfter(session.clockIn, b.start) ?? 0))
      .map(b => ({ ...b }))
  };
}

// refs point at the value a row edge is tied to
function readRef(model, ref) {
  if (ref.type === 'clockIn') return model.clockIn;
  if (ref.type === 'clockOut') return model.clockOut;
  return model.breaks[ref.index][ref.side];
}

function writeRef(model, ref, value) {
  if (ref.type === 'clockIn') model.clockIn = value;
  else if (ref.type === 'clockOut') model.clockOut = value;
  else model.breaks[ref.index][ref.side] = value;
}

function buildRows(model, nowHHMM) {
  const rows = [];
  let cursor = { ref: { type: 'clockIn' } };

  model.breaks.forEach((b, index) => {
    if (cursor) {
      rows.push({ kind: 'work', startRef: cursor.ref, endRef: { type: 'break', index, side: 'start' } });
    }
    rows.push({
      kind: 'break',
      breakIndex: index,
      startRef: { type: 'break', index, side: 'start' },
      endRef: b.end === null ? null : { type: 'break', index, side: 'end' }
    });
    cursor = b.end === null ? null : { ref: { type: 'break', index, side: 'end' } };
  });

  if (cursor) {
    rows.push({ kind: 'work', startRef: cursor.ref, endRef: model.clockOut ? { type: 'clockOut' } : null });
  }

  return rows.map((row, i) => {
    const start = readRef(model, row.startRef);
    const end = row.endRef ? readRef(model, row.endRef) : nowHHMM;
    const minutes = (minutesAfter(model.clockIn, end) ?? 0) - (minutesAfter(model.clockIn, start) ?? 0);
    return { ...row, key: `${row.kind}-${i}`, start, end, seconds: Math.max(0, minutes) * 60 };
  });
}

// new 15 min break in the middle of the longest work row
function suggestBreak(rows) {
  const work = rows.filter(r => r.kind === 'work').sort((a, b) => b.seconds - a.seconds)[0];
  if (!work) return { start: '12:00', end: '12:15' };
  const startMinutes = parseClockTime(work.start);
  const length = Math.round(work.seconds / 60);
  const offset = Math.max(0, Math.floor(length / 2) - 7);
  const breakLength = Math.min(15, Math.max(1, length - offset));
  return {
    start: minutesToHHMM(startMinutes + offset),
    end: minutesToHHMM(startMinutes + offset + breakLength)
  };
}

// requireReason: admin edits need a reason, kept in the change log
function SessionTimeline({ session, editable = false, onSave, requireReason = false }) {
  const [editing, setEditing] = useState(null); // { key, start, end } | { key: 'new' ... } | { key: 'total', total }
  const [error, setError] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const nowHHMM = dateToHHMM(new Date());
  const model = copySession(session);
  const rows = buildRows(model, nowHHMM);
  const live = !session.clockOut;
  const showTotalRow = model.breaks.length === 0 && toSeconds(session.breakTotal) > 0;

  function startEditing(row) {
    setError('');
    setEditing({ key: row.key, start: row.start, end: row.endRef ? row.end : null });
  }

  function cancel() {
    setEditing(null);
    setError('');
    setReason('');
  }

  async function commit(nextModel) {
    const problem = validateSession(nextModel.clockIn, nextModel.clockOut ?? nowHHMM, nextModel.breaks);
    if (problem) {
      setError(problem);
      return;
    }
    if (requireReason && !reason.trim()) {
      setError('Add a reason for this change.');
      return;
    }
    setSaving(true);
    const saveError = await onSave(nextModel, reason.trim());
    setSaving(false);
    if (saveError) {
      setError(saveError);
      return;
    }
    setEditing(null);
    setError('');
    setReason('');
  }

  function saveRow(row) {
    const next = copySession(session);
    writeRef(next, row.startRef, editing.start);
    if (row.endRef && editing.end !== null) writeRef(next, row.endRef, editing.end);
    commit(next);
  }

  function removeBreak(row) {
    const next = copySession(session);
    next.breaks.splice(row.breakIndex, 1);
    commit(next);
  }

  function saveNewBreak() {
    const next = copySession(session);
    next.breaks.push({ id: null, start: editing.start, end: editing.end });
    commit(next);
  }

  function saveTotal() {
    const next = copySession(session);
    next.breakTotal = editing.total;
    commit(next);
  }

  function renderActions(onSaveClick, extra) {
    return (
      <div className="st-edit-actions">
        {requireReason && (
          <AutoTextarea
            className="st-reason"
            placeholder="Reason for the change (kept in the change log)"
            value={reason}
            maxLength={300}
            maxRows={4}
            onChange={e => setReason(e.target.value)}
          />
        )}
        <button type="button" className="st-link" onClick={onSaveClick} disabled={saving}>{saving ? 'Saving...' : 'Save'}</button>
        <button type="button" className="st-link st-link-muted" onClick={cancel} disabled={saving}>Cancel</button>
        {extra}
      </div>
    );
  }

  return (
    <div className="st">
      {rows.map(row => {
        const isEditing = editing && editing.key === row.key;
        const isBreak = row.kind === 'break';
        const openBreak = isBreak && !row.endRef;
        const liveWork = !isBreak && !row.endRef;

        if (isEditing) {
          return (
            <div className="st-row st-row-editing" key={row.key}>
              <span className={`st-dot ${isBreak ? 'st-dot-break' : 'st-dot-work'}`} />
              <span className="st-kind">{isBreak ? 'Break' : 'Work'}</span>
              <div className="st-edit-times">
                <ClockTimePicker value={editing.start} onChange={v => setEditing({ ...editing, start: v })} />
                <span className="st-to">to</span>
                {editing.end === null
                  ? <span className="st-now">{openBreak ? 'On break now' : 'Now'}</span>
                  : <ClockTimePicker value={editing.end} onChange={v => setEditing({ ...editing, end: v })} />}
              </div>
              {renderActions(() => saveRow(row), isBreak && !openBreak && (
                <button type="button" className="st-link st-link-danger" onClick={() => removeBreak(row)} disabled={saving}>Remove break</button>
              ))}
              {error && <p className="st-error">{error}</p>}
            </div>
          );
        }

        return (
          <div className={`st-row ${session.declined ? 'st-row-declined' : ''}`} key={row.key}>
            <span className={`st-dot ${isBreak ? 'st-dot-break' : 'st-dot-work'}`} />
            <span className="st-kind">{isBreak ? 'Break' : 'Work'}</span>
            <span className="st-times">
              {formatClock(row.start)} {'–'} {row.endRef ? formatClock(row.end) : <span className="st-now">{openBreak ? 'on break now' : 'now'}</span>}
            </span>
            <span className="st-duration">{formatDuration(row.seconds)}{(openBreak || liveWork) ? ' so far' : ''}</span>
            {editable ? (
              <button type="button" className="st-edit-btn" onClick={() => startEditing(row)} aria-label={`Edit ${isBreak ? 'break' : 'work'} ${formatClock(row.start)}`}>
                <PencilIcon width={14} height={14} />
              </button>
            ) : <span />}
          </div>
        );
      })}

      {showTotalRow && (
        editing && editing.key === 'total' ? (
          <div className="st-row st-row-editing">
            <span className="st-dot st-dot-break" />
            <span className="st-kind">Breaks</span>
            <div className="st-edit-times">
              <DurationPicker value={editing.total} onChange={v => setEditing({ ...editing, total: v })} />
            </div>
            {renderActions(saveTotal)}
            {error && <p className="st-error">{error}</p>}
          </div>
        ) : (
          <div className="st-row">
            <span className="st-dot st-dot-break" />
            <span className="st-kind">Breaks</span>
            <span className="st-times st-muted">Break times weren't recorded for this entry</span>
            <span className="st-duration">{formatDuration(toSeconds(session.breakTotal))}</span>
            {editable ? (
              <button type="button" className="st-edit-btn" onClick={() => { setError(''); setEditing({ key: 'total', total: session.breakTotal }); }} aria-label="Edit break total">
                <PencilIcon width={14} height={14} />
              </button>
            ) : <span />}
          </div>
        )
      )}

      {editing && editing.key === 'new' && (
        <div className="st-row st-row-editing">
          <span className="st-dot st-dot-break" />
          <span className="st-kind">New break</span>
          <div className="st-edit-times">
            <ClockTimePicker value={editing.start} onChange={v => setEditing({ ...editing, start: v })} />
            <span className="st-to">to</span>
            <ClockTimePicker value={editing.end} onChange={v => setEditing({ ...editing, end: v })} />
          </div>
          {renderActions(saveNewBreak)}
          {error && <p className="st-error">{error}</p>}
        </div>
      )}

      {!live ? (
        <div className="st-row st-row-out">
          <span className="st-dot st-dot-out" />
          <span className="st-kind">Out</span>
          <span className="st-times st-muted">Clocked out {formatClock(session.clockOut)}</span>
          <span />
          <span />
        </div>
      ) : null}

      {editable && !editing && (
        <button type="button" className="st-link st-add" onClick={() => { setError(''); setEditing({ key: 'new', ...suggestBreak(rows) }); }}>
          + Add break
        </button>
      )}
    </div>
  );
}

export default SessionTimeline;

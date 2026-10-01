import { useEffect, useRef } from 'react';

// Text box that grows with what's typed (up to maxRows, then scrolls),
// so longer messages stay visible without moving the cursor back.
function AutoTextarea({ value, maxRows = 6, className = '', ...props }) {
  const ref = useRef(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    const border = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    const max = lineHeight * maxRows + padding + border;

    el.style.height = 'auto';
    const needed = el.scrollHeight + border;
    el.style.height = `${Math.min(needed, max)}px`;
    el.style.overflowY = needed > max ? 'auto' : 'hidden';
  }, [value, maxRows]);

  return <textarea ref={ref} rows={1} value={value} className={`auto-textarea ${className}`} {...props} />;
}

export default AutoTextarea;

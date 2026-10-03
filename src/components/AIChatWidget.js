import { useState, useRef, useEffect } from 'react';
import { callAI } from '../lib/ai';
import { HelpIcon, XIcon } from '../icons';
import AutoTextarea from './AutoTextarea';
import './AIChatWidget.css';

// Floating support chat on the employee dashboard, available from any tab.
// App questions from the FAQ + the employee's own stats (buildChatContext() in
// Dashboard.js); everyday questions answered too. Rules in ai-assist.
function AIChatWidget({ context }) {
  const [open, setOpen] = useState(false);
  const [messages, setMessages] = useState([
    { role: 'assistant', content: "Hi! Ask me anything about clocking in, breaks, your timesheet or time off, or just a quick question." }
  ]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, open]);

  async function handleSend() {
    const text = input.trim();
    if (!text || loading) return;

    const nextMessages = [...messages, { role: 'user', content: text }];
    setMessages(nextMessages);
    setInput('');
    setLoading(true);
    setError('');

    try {
      const result = await callAI('chat', { messages: nextMessages, context });
      setMessages(prev => [...prev, { role: 'assistant', content: result.message }]);
    } catch (err) {
      console.log('AI assistant error:', err);
      setError("Couldn't reach the assistant — please try again in a moment.");
    }
    setLoading(false);
  }

  function handleKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="ai-chat-root">
      {open && (
        <div className="ai-chat-panel">
          <div className="ai-chat-header">
            <span>Assistant</span>
            <button className="ai-chat-close" onClick={() => setOpen(false)} aria-label="Close assistant">
              <XIcon width={15} height={15} />
            </button>
          </div>
          <div className="ai-chat-messages" ref={scrollRef}>
            {messages.map((m, i) => (
              <div key={i} className={`ai-chat-bubble ai-chat-bubble-${m.role}`}>
                {m.content}
              </div>
            ))}
            {loading && (
              <div className="ai-chat-bubble ai-chat-bubble-assistant ai-chat-typing">Thinking...</div>
            )}
          </div>
          {error && <p className="ai-chat-error">{error}</p>}
          <div className="ai-chat-input-row">
            {/* Enter sends, Shift+Enter for a new line */}
            <AutoTextarea
              placeholder="Ask a question..."
              value={input}
              maxRows={5}
              onChange={e => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
            />
            <button onClick={handleSend} disabled={loading || !input.trim()}>Send</button>
          </div>
        </div>
      )}
      <button className="ai-chat-fab" onClick={() => setOpen(o => !o)} aria-label="Open assistant">
        <HelpIcon width={20} height={20} />
      </button>
    </div>
  );
}

export default AIChatWidget;

// supabase/functions/ai-assist/index.ts
//
// One edge function behind every assistant feature. The frontend calls it with
// supabase.functions.invoke('ai-assist', { body: { task, ...payload } }) so
// the API key stays server-side.
//
// Gemini API. Key from aistudio.google.com, stored as the GEMINI_API_KEY
// secret in Supabase. GEMINI_MODEL secret overrides the model if Google
// retires this one.
// Only signed-in users can call it (checked below).

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const MODEL = Deno.env.get('GEMINI_MODEL') || 'gemini-3.5-flash-lite';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type'
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'content-type': 'application/json' }
  });
}

type Turn = { role: 'user' | 'model'; text: string };

async function callGemini(system: string, userMessage: string | Turn[], maxTokens = 400) {
  // API keys go in x-goog-api-key. Bearer only takes Google sign-in tokens
  // (that's the "Expected OAuth 2 access token" 401).
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY ?? ''
    },
    body: JSON.stringify({
      system_instruction: { parts: [{ text: system }] },
      contents: typeof userMessage === 'string'
        ? [{ role: 'user', parts: [{ text: userMessage }] }]
        : userMessage.map(t => ({ role: t.role, parts: [{ text: t.text }] })),
      generationConfig: { maxOutputTokens: maxTokens, temperature: 0.7 }
    })
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Gemini API error (${res.status}): ${text}`);
  }

  const data = await res.json();

  // Blocked prompt or empty response comes back as 200 with no candidate.
  // Throw instead of returning an empty string.
  const blockReason = data?.promptFeedback?.blockReason;
  if (blockReason) {
    throw new Error(`Gemini blocked this request: ${blockReason}`);
  }

  const parts = data?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p: { text?: string }) => p.text || '').join('');

  if (!text) {
    const finishReason = data?.candidates?.[0]?.finishReason;
    throw new Error(`Gemini returned no text (finishReason: ${finishReason || 'unknown'})`);
  }

  return text;
}

// Strip ```json fences in case the model adds them.
function jsonFromText(text: string) {
  const cleaned = text.replace(/```json|```/g, '').trim();
  return JSON.parse(cleaned);
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  // signed-in users only, the public anon key on its own isn't enough
  const authClient = createClient(
    Deno.env.get('SUPABASE_URL') ?? '',
    Deno.env.get('SUPABASE_ANON_KEY') ?? '',
    { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } }
  );
  const { data: { user } } = await authClient.auth.getUser();
  if (!user) {
    return jsonResponse({ error: 'Please sign in to use the assistant.' }, 401);
  }

  try {
    if (!GEMINI_API_KEY) {
      throw new Error('The assistant isn\'t set up yet (GEMINI_API_KEY missing).');
    }

    const body = await req.json();
    const { task } = body;

    // ---------- Time off decision message ----------
    if (task === 'time_off_message') {
      const { employeeName, type, startDate, endDate, status, reason } = body;
      const system = 'You write short, warm, professional messages from a workplace admin to an ' +
        'employee about a time off decision. 2-4 sentences. No greeting, sign-off, subject line or ' +
        'placeholders — just the message body itself. British English spelling.';
      const user = `Employee: ${employeeName}\nLeave type: ${type}\nDates: ${startDate} to ${endDate}\n` +
        `Employee's stated reason: ${reason || 'none given'}\nDecision: ${status}\n\n` +
        'Write the message the employee will see.';
      const text = await callGemini(system, user, 200);
      return jsonResponse({ message: text.trim() });
    }

    // ---------- Weekly summary ----------
    if (task === 'weekly_summary') {
      const { employeeName, weekLabel, hoursWorked, breakHours, sessionsCount, timeOffDays } = body;
      const system = 'You write a short, friendly weekly work summary (3-5 sentences) for an employee, ' +
        "based on their timesheet stats. Encouraging but factual — don't invent details beyond what's " +
        'given. British English spelling.';
      const user = `Employee: ${employeeName}\nWeek: ${weekLabel}\nHours worked: ${hoursWorked}\n` +
        `Break time: ${breakHours}\nSessions: ${sessionsCount}\nApproved time off this week: ${timeOffDays} day(s)\n\n` +
        'Write the summary.';
      const text = await callGemini(system, user, 250);
      return jsonResponse({ message: text.trim() });
    }

    // ---------- Timesheet anomaly note ----------
    // The app decides what's unusual (AdminDashboard.js). This only words the
    // note.
    if (task === 'timesheet_anomaly') {
      const { employeeName, date, hoursToday, averageHours } = body;
      const system = "You write one short, neutral sentence flagging a timesheet entry that differs " +
        "from an employee's usual average, for an admin to see. Factual, not accusatory. British English spelling.";
      const user = `Employee: ${employeeName}\nDate: ${date}\nHours that day: ${hoursToday}\n` +
        `Their average: ${averageHours}\n\nWrite the one-sentence note.`;
      const text = await callGemini(system, user, 100);
      return jsonResponse({ message: text.trim() });
    }

    // ---------- Natural-language time off parsing ----------
    if (task === 'parse_time_off') {
      const { text: description, today } = body;
      const system = 'You convert a plain-English time off request into strict JSON with keys: ' +
        'type (one of "Annual Leave", "Sick Leave", "Unpaid Leave", "Emergency Leave", "Compassionate Leave"), ' +
        'start_date (YYYY-MM-DD), end_date (YYYY-MM-DD), reason (short string, can be empty). ' +
        `Today's date is ${today}. Reply with ONLY the JSON object — no markdown fences, no commentary.`;
      const text = await callGemini(system, description, 200);
      const parsed = jsonFromText(text);
      return jsonResponse(parsed);
    }

    // ---------- Review note (admin, Review page) ----------
    if (task === 'review_note') {
      const { employeeName, decision, when, flags, checks } = body;
      const accepted = decision === 'authorised';
      const system = 'You write a short note from a workplace admin to an employee about a clock-in ' +
        'session that the time-tracking app flagged for review. The employee reads it. 1-2 sentences, ' +
        'under 250 characters. Plain, calm and fair: say what was noticed in everyday words and what the ' +
        (accepted
          ? 'decision is (accepted, the session counts as normal). If it helps, one practical tip so it doesn\'t happen again.'
          : 'decision is (declined, the session won\'t count). Say they can speak to the admin if they think it\'s wrong.') +
        ' Never accuse or guess at reasons. No greeting, sign-off, name or placeholders. British English spelling.';
      const user = `Employee: ${employeeName}\nSession: ${when}\n` +
        `What was flagged: ${(flags || []).join('; ') || 'nothing specific'}\n` +
        `Checks that passed: ${(checks || []).join(', ') || 'none recorded'}\n` +
        `Decision: ${accepted ? 'accepted' : 'declined'}\n\nWrite the note.`;
      const text = await callGemini(system, user, 150);
      return jsonResponse({ message: text.trim().replace(/^"|"$/g, '') });
    }

    // ---------- Support chat ----------
    if (task === 'chat') {
      const { messages, context } = body;
      const system = 'You are the assistant inside Mmerℇ, a time-tracking app (clock in/out, breaks, ' +
        'timesheets, time off, face and laptop checks). You are talking to an employee.\n\n' +
        'How to answer:\n' +
        '- Questions about the app or their own work: answer from the FAQ, app guide and their data ' +
        'below. Be specific (which page, which button).\n' +
        '- Everyday questions (simple maths, dates and days, quick facts, explaining a word, help ' +
        'wording a message or a time off reason): just answer them, briefly and correctly.\n' +
        '- Things only the company knows (pay, contracts, leave allowance, HR rules, why a request ' +
        'was declined) or that the admin has to do (approving time off, correcting a timesheet, ' +
        'approving a laptop or face, reviewing a flag): say plainly you can\'t see or do that, say ' +
        'who can (their admin) and what to tell them or where in the app to go, e.g. "Send a time ' +
        'off request from Time Off" or "Ask your admin to correct it; they\'ll need the date and the right times".\n' +
        '- Never invent their data, company policy or anything about other employees. Never reveal ' +
        'other people\'s information. Don\'t help get around the clock-in checks.\n' +
        '- Anything harmful, or medical, legal or financial advice beyond common sense: decline ' +
        'in one friendly sentence and suggest the right kind of person to ask.\n' +
        '- Keep it short: 1-4 sentences, or a few short steps when they ask how to do something. ' +
        'Plain text, no markdown headings. Friendly, not chatty. British English spelling.\n\n' +
        `Now: ${context?.now || new Date().toISOString()}\n\n` +
        `FAQ:\n${context?.faq || ''}\n\nThis employee's data:\n${context?.employeeData || ''}`;
      // the opening greeting is the app's, not part of the conversation
      const turns: Turn[] = (messages || [])
        .slice(-10)
        .map((m: { role: string; content: string }) => ({
          role: (m.role === 'user' ? 'user' : 'model') as Turn['role'],
          text: String(m.content || '').slice(0, 2000)
        }));
      while (turns.length && turns[0].role !== 'user') turns.shift();
      if (!turns.length) throw new Error('No question was sent.');
      const text = await callGemini(system, turns, 400);
      return jsonResponse({ message: text.trim() });
    }

    throw new Error(`Unknown task: ${task}`);
  } catch (err) {
    console.error('ai-assist error:', (err as Error).message);
    return jsonResponse({ error: (err as Error).message }, 400);
  }
});
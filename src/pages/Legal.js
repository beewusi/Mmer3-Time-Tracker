import { useEffect, useRef } from 'react';
import { HourglassIcon } from '../icons';
import './Legal.css';

// Privacy Notice and Terms of Use, opened from the sign in and sign up pages.
// Contact details live here so both pages stay in step.
const CONTACT_EMAIL = 'ebelinda695@gmail.com';
const LAST_UPDATED = '1 October 2026';

function Contact() {
  return <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
}

function PrivacyNotice() {
  return (
    <>
      <h1>Privacy Notice</h1>
      <p className="legal-updated">Last updated {LAST_UPDATED}</p>

      <p>
        Mmerℇ is a time tracking tool used by your organisation to record working
        hours, breaks and time off. This notice explains what information Mmerℇ
        collects about you, why, who can see it and the choices you have.
      </p>

      <h2>1. Information we collect</h2>
      <ul>
        <li><strong>Account details:</strong> your name, email address, password (stored encrypted, never visible to anyone), department and, if you add them, your phone number and profile photo.</li>
        <li><strong>Work records:</strong> clock in and clock out times, each break you take, hours worked and any changes an administrator makes to these records.</li>
        <li><strong>Location check:</strong> when you clock in, your device's location is compared with the office location. Only the result (authorised, unauthorised or unavailable) is saved. Your exact coordinates are not stored.</li>
        <li><strong>Time off:</strong> the type, dates and any reason you give, plus the administrator's response.</li>
        <li><strong>Reminder settings:</strong> which reminders you switch on and, if you turn on desktop notifications, a technical address your browser provides so notifications can reach that device.</li>
        <li><strong>Assistant requests:</strong> if you use the AI assistant features, the text you type and the work details needed to answer you.</li>
        <li><strong>On your device:</strong> Mmerℇ remembers a few display choices in your browser, such as dark mode and whether the sidebar is collapsed. These are not sent anywhere.</li>
      </ul>

      <h2>2. Why we use it</h2>
      <ul>
        <li>To keep accurate attendance and working-time records for your organisation.</li>
        <li>To let administrators review, correct and approve timesheets and time off.</li>
        <li>To flag clock-ins made away from the office so they can be reviewed.</li>
        <li>To send the reminders and summaries you have switched on, and account emails such as password resets.</li>
        <li>To keep the service secure and working properly.</li>
      </ul>

      <h2>3. Who can see your information</h2>
      <p>
        You can see your own records. Administrators of your organisation can see
        and manage the records of everyone in it. Other employees cannot see your
        information.
      </p>
      <p>Mmerℇ relies on these service providers to run:</p>
      <ul>
        <li><strong>Supabase</strong> stores the database, sign-in accounts and profile photos.</li>
        <li><strong>Render</strong> hosts the website.</li>
        <li><strong>EmailJS</strong> and <strong>Google (Gmail)</strong> send reminder and account emails.</li>
        <li><strong>Google</strong> handles sign-in if you choose "Continue with Google".</li>
        <li><strong>Google Gemini</strong> processes assistant requests, only when you use those features.</li>
      </ul>
      <p>
        These providers only process information to provide their service. Some of
        them may store it outside Ghana. Your information is never sold.
      </p>

      <h2>4. How long we keep it</h2>
      <p>
        Work records, breaks and time off are kept for as long as your organisation
        needs them for its records, including after your account is deleted, so that
        past timesheets stay complete. Your sign-in account is removed when an
        administrator deletes it.
      </p>

      <h2>5. Keeping it safe</h2>
      <p>
        Information is sent over encrypted connections, and database access rules
        limit each person to the records they are allowed to see. No system is
        completely secure, so please keep your password private and let us know
        straight away if you think your account has been misused.
      </p>

      <h2>6. Your rights</h2>
      <p>
        Under Ghana's Data Protection Act, 2012 (Act 843) you can ask to see the
        information held about you, ask for it to be corrected, and object to how it
        is used. You can update your name, phone number, photo and password yourself
        from your Profile page. For anything else, contact <Contact />. If you are
        not satisfied with the response, you can complain to the Data Protection
        Commission of Ghana.
      </p>

      <h2>7. Changes to this notice</h2>
      <p>
        If this notice changes, the date at the top will be updated. Important
        changes will be shown in the app.
      </p>

      <h2>8. Contact</h2>
      <p>Questions about this notice or your information: <Contact />.</p>
    </>
  );
}

function TermsOfUse() {
  return (
    <>
      <h1>Terms of Use</h1>
      <p className="legal-updated">Last updated {LAST_UPDATED}</p>

      <p>
        These terms apply to everyone who creates an account on or uses Mmerℇ. By
        creating an account or signing in, you agree to them. Please also read the
        Privacy Notice, which explains how your information is used.
      </p>

      <h2>1. Who can use Mmerℇ</h2>
      <p>
        Mmerℇ is for employees of organisations that use it to track working time.
        New accounts must be approved by an administrator before they can be used,
        and an administrator may decline or remove any account.
      </p>

      <h2>2. Your account</h2>
      <ul>
        <li>Give your real name and an email address you use.</li>
        <li>Keep your password private and do not share your account.</li>
        <li>You are responsible for what happens under your account. Tell us straight away if you think someone else has used it.</li>
      </ul>

      <h2>3. Recording your time</h2>
      <ul>
        <li>Clock in, take breaks and clock out honestly, for yourself only.</li>
        <li>Do not clock in or out for someone else, fake your location, or try to change records in ways the app does not allow.</li>
        <li>Allow location access when you clock in. If location is unavailable or outside the office area, the clock-in is still recorded but is flagged for an administrator to review.</li>
        <li>Sessions still running after 8 hours 15 minutes are clocked out automatically.</li>
        <li>Administrators can review, correct, authorise, decline and approve records and time off requests.</li>
      </ul>

      <h2>4. Acceptable use</h2>
      <p>
        Do not try to access other people's information, interfere with how Mmerℇ
        works, get around its security, or use it for anything unlawful.
      </p>

      <h2>5. Assistant features</h2>
      <p>
        Some features use AI to draft text or fill in forms. Suggestions can be
        wrong, so always check them before you submit anything.
      </p>

      <h2>6. Availability</h2>
      <p>
        We work to keep Mmerℇ running and accurate, but it is provided as it is and
        may sometimes be unavailable or contain mistakes. Your organisation's
        official records and policies take priority over anything shown in the app.
      </p>

      <h2>7. Ending your use</h2>
      <p>
        An administrator may suspend or delete an account that breaks these terms or
        is no longer needed. Work records may be kept afterwards, as described in the
        Privacy Notice.
      </p>

      <h2>8. Changes</h2>
      <p>
        These terms may be updated. The date at the top shows the latest version,
        and continuing to use Mmerℇ after a change means you accept it.
      </p>

      <h2>9. Governing law and contact</h2>
      <p>
        These terms are governed by the laws of Ghana. Questions: <Contact />.
      </p>
    </>
  );
}

function Legal({ doc, onBack, onSwitch }) {
  const pageRef = useRef(null);

  // back to the top when switching between the two
  useEffect(() => {
    const scroller = pageRef.current?.closest('.legal-overlay');
    if (scroller) scroller.scrollTop = 0;
    else window.scrollTo(0, 0);
  }, [doc]);

  return (
    <div className="legal-page" ref={pageRef}>
      <header className="legal-bar">
        <div className="legal-brand">
          <HourglassIcon width={20} height={20} />
          <span>Mmerℇ</span>
        </div>
        <button type="button" className="legal-back" onClick={onBack}>← Back</button>
      </header>

      <article className="legal-doc">
        {doc === 'terms' ? <TermsOfUse /> : <PrivacyNotice />}

        <p className="legal-switch">
          {doc === 'terms' ? (
            <>Also read the <span onClick={() => onSwitch('privacy')}>Privacy Notice</span></>
          ) : (
            <>Also read the <span onClick={() => onSwitch('terms')}>Terms of Use</span></>
          )}
        </p>
      </article>
    </div>
  );
}

export default Legal;

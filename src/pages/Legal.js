import { useEffect, useState } from 'react';
import {
  HourglassIcon, ShieldIcon, FileTextIcon, PinIcon, UsersIcon, CheckCircleIcon,
  ClockIcon, AlertIcon, ChatIcon, MailIcon, ArrowUpRightIcon
} from '../icons';
import './Legal.css';

// Privacy Notice (/privacy) and Terms of Use (/terms). Own URLs so the links on
// sign in / sign up open them in a new tab. Render needs the /* -> /index.html
// rewrite for these to load directly.
const CONTACT_EMAIL = 'ebelinda695@gmail.com';
const LAST_UPDATED = '3 October 2026';
const YEAR = 2026;

function Contact() {
  return <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>;
}

// ---------- Privacy ----------
const PRIVACY = {
  title: 'Privacy Notice',
  icon: ShieldIcon,
  intro: 'What Mmerℇ records about you while you work, why, who can see it and what you can ask for.',
  readTime: '8 min read',
  glance: [
    { icon: PinIcon, title: 'No exact location', text: 'Only whether you clocked in at the office is saved, never your coordinates.' },
    { icon: UsersIcon, title: 'Seen by your admins', text: 'Your records, photos and screenshots are visible to you and your organisation’s administrators only.' },
    { icon: ClockIcon, title: 'Only while clocked in', text: 'Presence checks, screenshots and activity are only recorded during a working session.' },
    { icon: MailIcon, title: 'Ask anytime', text: 'You can ask to see or correct what’s held about you.' }
  ],
  sections: [
    {
      title: 'Information we collect',
      short: 'Your account and work records, plus the checks that confirm it’s really you clocking in and that you’re at work during a session.',
      body: (
        <dl className="legal-defs">
          <div><dt>Account details</dt><dd>Your name, email address, password (stored encrypted and never visible to anyone), department and, if you add them, your phone number and profile photo.</dd></div>
          <div><dt>Work records</dt><dd>Clock in and clock out times, each break you take, hours worked and any changes an administrator makes to them.</dd></div>
          <div><dt>Location check</dt><dd>When you clock in, your device's location is compared with the office location. Only the result is saved: authorised, unauthorised or unavailable. Your exact coordinates are not stored.</dd></div>
          <div><dt>Work laptop</dt><dd>When you register your work laptop, a passkey is created on it. Mmerℇ keeps only the passkey's public part, a name for the laptop and when it was last used. Your fingerprint, face or PIN for Windows Hello or Touch ID never leave the laptop and are never seen by Mmerℇ.</dd></div>
          <div><dt>Face check</dt><dd>Only with your consent. You take a photo when you set it up, and it is turned into a face template (a list of 128 numbers). At clock-in and during presence checks, a webcam photo is compared with that template on your own computer, along with a quick blink check. See “Face data and consent” below.</dd></div>
          <div><dt>Check photos</dt><dd>The webcam photo taken at clock-in and at each presence check, and whether it matched.</dd></div>
          <div><dt>Presence checks</dt><dd>A few times during each working session (about four) you'll be asked to show your face within five minutes. The time you answered, the result and the photo are saved.</dd></div>
          <div><dt>Screenshots</dt><dd>If your organisation uses the Mmerℇ desktop app, it takes two or three screenshots of your screen an hour, only while you're clocked in. They show whatever is on screen at that moment, so close anything personal while you're clocked in. You can see your own screenshots on My Activity.</dd></div>
          <div><dt>Network and device</dt><dd>At clock-in: your internet address, compared with your office's internet connection; the browser and laptop you used; and, from the desktop app, the name of the Wi-Fi network and the ID of its router (to tell whether it's the office's). Your location from the Wi-Fi isn't saved. A random code saved in your browser shows when two accounts are used on the same laptop.</dd></div>
          <div><dt>Activity</dt><dd>While you're clocked in: whether your computer is in use, idle or locked, and when the app last had contact. Not what you type, which websites you visit or what you work on.</dd></div>
          <div><dt>Sign-in attempts</dt><dd>The email address and time of each sign-in attempt, used to lock an account for a short time after too many wrong passwords.</dd></div>
          <div><dt>Time off</dt><dd>The type, dates and any reason you give, plus the administrator's response.</dd></div>
          <div><dt>Reminders</dt><dd>Which reminders you switch on and, if you turn on desktop notifications, a technical address your browser provides so notifications can reach that device.</dd></div>
          <div><dt>Assistant requests</dt><dd>If you use the AI assistant features, the text you type and the work details needed to answer you.</dd></div>
          <div><dt>On your device</dt><dd>A few display choices, such as dark mode and a collapsed sidebar, are remembered in your browser and never sent anywhere.</dd></div>
        </dl>
      )
    },
    {
      title: 'Why we use it',
      short: 'To keep accurate working-time records, make sure nobody clocks in for someone else, and send the reminders you choose.',
      body: (
        <ul className="legal-list">
          <li>Keeping accurate attendance and working-time records for your organisation.</li>
          <li>Letting administrators review, correct and approve timesheets and time off.</li>
          <li>Making sure the person clocking in is the employee the account belongs to, on their own work laptop, so nobody can clock in for someone else.</li>
          <li>Checking that you're still at work during a session, through presence checks, activity and, with the desktop app, screenshots.</li>
          <li>Flagging clock-ins and sessions that need a second look (away from the office, a face that didn't match, a missed presence check) so an administrator can review them.</li>
          <li>Sending the reminders and summaries you switch on, and account emails such as password resets.</li>
          <li>Keeping the service secure and working properly.</li>
        </ul>
      )
    },
    {
      title: 'Face data and consent',
      short: 'Your face is only used to confirm it’s you clocking in, and only after you agree.',
      body: (
        <>
          <ul className="legal-list">
            <li>The face check is set up only after you tick the consent box. The date you agreed and the version of this notice are saved.</li>
            <li>Your face template is used for one thing: confirming it's you clocking in and answering presence checks. It is not used to identify you anywhere else, and it is never shared or sold.</li>
            <li>Your face is turned into numbers on your own computer and compared on Mmerℇ's own server. Photos and templates are not sent to any outside face-recognition service.</li>
            <li>One face per person. A face that is already registered to another account can't be registered again.</li>
            <li>A new face is accepted automatically once the photo passes the checks (one face, facing the camera, good light). An administrator can see the photo and ask for a new one.</li>
            <li>Clocking in needs the face check. If it doesn't recognise you after three tries, you can still clock in, and the photos go to an administrator to look at.</li>
          </ul>
          <p>You can withdraw your consent at any time from Devices &amp; Security or by contacting <Contact />. Your face template and setup photo are then deleted, and your organisation will agree another way for you to confirm your clock-ins.</p>
        </>
      )
    },
    {
      title: 'Who can see it',
      short: 'You and your organisation’s administrators. A few trusted services help run the app.',
      body: (
        <>
          <p>You can see your own records, check photos, presence checks and screenshots. Administrators of your organisation can see and manage everyone's, including flagged sessions and the evidence behind them. Other employees cannot see your information.</p>
          <div className="legal-providers">
            <div><strong>Supabase</strong><span>Database, sign-in, photos and screenshots</span></div>
            <div><strong>Render</strong><span>Hosts the website</span></div>
            <div><strong>EmailJS &amp; Gmail</strong><span>Reminder and account emails</span></div>
            <div><strong>Google</strong><span>Sign-in, if you choose it</span></div>
            <div><strong>Google Gemini</strong><span>Assistant features, only when used</span></div>
          </div>
          <p>These services only process information to provide their part of Mmerℇ, and some may store it outside Ghana. Your information is never sold.</p>
        </>
      )
    },
    {
      title: 'How long we keep it',
      short: 'Work records stay with your organisation. Photos and screenshots are deleted after a short time.',
      body: (
        <dl className="legal-defs">
          <div><dt>Work records</dt><dd>Clock-ins, breaks, time off, flags and the administrator's decisions are kept for as long as your organisation needs them, including after your account is deleted, so past timesheets stay complete.</dd></div>
          <div><dt>Screenshots</dt><dd>Deleted after 14 days.</dd></div>
          <div><dt>Check photos</dt><dd>Clock-in and presence check photos are deleted after 30 days.</dd></div>
          <div><dt>Face template</dt><dd>Kept until you withdraw consent or your account is deleted, then deleted with its setup photo.</dd></div>
          <div><dt>Work laptop</dt><dd>Kept until you or an administrator remove the laptop, or your account is deleted.</dd></div>
          <div><dt>Sign-in attempts</dt><dd>Deleted after 30 days.</dd></div>
          <div><dt>Sign-in account</dt><dd>Removed when an administrator deletes it.</dd></div>
        </dl>
      )
    },
    {
      title: 'Keeping it safe',
      short: 'Encrypted connections and strict access rules. Keep your password to yourself.',
      body: (
        <p>Information travels over encrypted connections, and database rules limit each person to the records they're allowed to see. No system is completely secure, so keep your password private and tell us straight away if you think your account has been misused.</p>
      )
    },
    {
      title: 'Your rights',
      short: 'See, correct or object to how your information is used, under Ghanaian law.',
      body: (
        <>
          <p>Under Ghana's Data Protection Act, 2012 (Act 843) you can:</p>
          <ul className="legal-list">
            <li>ask to see the information held about you</li>
            <li>ask for it to be corrected</li>
            <li>object to how it is used</li>
            <li>withdraw your consent to the face check</li>
          </ul>
          <p>Your name, phone number, photo and password can be changed from your Profile page. Your check photos, presence checks and screenshots are on My Activity, and your registered laptop and face check are under Devices &amp; Security. For anything else, contact <Contact />. If you're not happy with the response, you can complain to the Data Protection Commission of Ghana.</p>
        </>
      )
    },
    {
      title: 'Changes and contact',
      short: 'If this notice changes, the date at the top changes too.',
      body: (
        <p>Important changes will be shown in the app. Questions about this notice or your information: <Contact />.</p>
      )
    }
  ]
};

// ---------- Terms ----------
const TERMS = {
  title: 'Terms of Use',
  icon: FileTextIcon,
  intro: 'The rules for using Mmerℇ. Creating an account or signing in means you agree to them.',
  readTime: '5 min read',
  glance: [
    { icon: CheckCircleIcon, title: 'Approval first', text: 'New accounts are approved by an administrator before use.' },
    { icon: ClockIcon, title: 'Honest records', text: 'Clock in and out for yourself, from your own work laptop.' },
    { icon: AlertIcon, title: 'Auto clock-out', text: 'Sessions still running after 8 h 15 min end automatically.' },
    { icon: ChatIcon, title: 'Check AI suggestions', text: 'Assistant drafts can be wrong, review before submitting.' }
  ],
  sections: [
    {
      title: 'Who can use Mmerℇ',
      short: 'Employees of organisations using Mmerℇ, once an administrator approves them.',
      body: (
        <p>New accounts must be approved by an administrator before they can be used, and an administrator may decline or remove any account.</p>
      )
    },
    {
      title: 'Your account',
      short: 'Use your real details and keep your password to yourself.',
      body: (
        <ul className="legal-list">
          <li>Give your real name and an email address you use.</li>
          <li>Keep your password private and don't share your account.</li>
          <li>You're responsible for what happens under your account. Tell us straight away if someone else has used it.</li>
        </ul>
      )
    },
    {
      title: 'Recording your time',
      short: 'Clock in, take breaks and clock out honestly, for yourself only.',
      body: (
        <ul className="legal-list">
          <li>Don't clock in or out for someone else, fake your location, or change records in ways the app doesn't allow.</li>
          <li>Clock in from your own registered work laptop, and don't let anyone else use your laptop's passkey or your account.</li>
          <li>Don't try to fool the face check, for example with a photo or video of someone else.</li>
          <li>Allow location access when you clock in. If it's unavailable or outside the office area, the clock-in still counts but is flagged for review.</li>
          <li>Sessions still running after 8 hours 15 minutes are clocked out automatically.</li>
          <li>Administrators can review, correct, authorise, decline and approve records and time off. Every change an administrator makes to a saved session keeps the original and the reason.</li>
        </ul>
      )
    },
    {
      title: 'Checks during your session',
      short: 'Answer presence checks and keep the desktop app running while you’re clocked in.',
      body: (
        <>
          <ul className="legal-list">
            <li>Clock in from your own registered work laptop, with the face check. A laptop registered away from the office network is approved by an administrator; until then your hours are held and count once it's approved.</li>
            <li>Answer presence checks within five minutes. If you miss one, your time is paused from when it was asked until you do a face check to carry on. After an hour you're clocked out at the time of the missed check.</li>
            <li>If your organisation uses the desktop app, keep it running while you're clocked in. Long gaps with no contact from the app are recorded.</li>
            <li>Time when your computer is idle or locked for a long stretch is recorded.</li>
          </ul>
          <p>Most of this is just recorded on your session. Only face checks that don't match are sent to an administrator to authorise or decline. How these checks work, and what is saved, is explained in the Privacy Notice.</p>
        </>
      )
    },
    {
      title: 'Acceptable use',
      short: 'No snooping, tampering or anything unlawful.',
      body: (
        <p>Don't try to access other people's information, interfere with how Mmerℇ works, get around its security, or use it for anything unlawful.</p>
      )
    },
    {
      title: 'Assistant features',
      short: 'AI suggestions help, but they can be wrong.',
      body: (
        <p>Some features use AI to draft text or fill in forms. Always check the result before you submit anything.</p>
      )
    },
    {
      title: 'Availability',
      short: 'Mmerℇ is provided as it is. Your organisation’s official records come first.',
      body: (
        <p>We work to keep Mmerℇ running and accurate, but it may sometimes be unavailable or contain mistakes. Your organisation's official records and policies take priority over anything shown in the app.</p>
      )
    },
    {
      title: 'Ending your use',
      short: 'Accounts that break these terms or are no longer needed can be removed.',
      body: (
        <p>An administrator may suspend or delete an account. Work records may be kept afterwards, as described in the Privacy Notice.</p>
      )
    },
    {
      title: 'Changes, law and contact',
      short: 'Governed by the laws of Ghana. The date at the top shows the latest version.',
      body: (
        <p>These terms may be updated, and continuing to use Mmerℇ after a change means you accept it. Questions: <Contact />.</p>
      )
    }
  ]
};

function Legal({ doc }) {
  const page = doc === 'terms' ? TERMS : PRIVACY;
  const PageIcon = page.icon;
  const [activeId, setActiveId] = useState('s1');

  useEffect(() => {
    document.title = `${page.title} · Mmerℇ`;
  }, [page.title]);

  // highlight the section being read in the contents list
  useEffect(() => {
    const els = page.sections.map((_, i) => document.getElementById(`s${i + 1}`)).filter(Boolean);
    const observer = new IntersectionObserver(entries => {
      const visible = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (visible[0]) setActiveId(visible[0].target.id);
    }, { rootMargin: '-90px 0px -60% 0px' });
    els.forEach(el => observer.observe(el));
    return () => observer.disconnect();
  }, [page]);

  return (
    <div className="legal-page">
      <header className="legal-bar">
        <a className="legal-brand" href="/">
          <HourglassIcon width={20} height={20} />
          <span>Mmerℇ</span>
        </a>
        <nav className="legal-tabs">
          <a href="/privacy" className={doc !== 'terms' ? 'active' : ''}>Privacy</a>
          <a href="/terms" className={doc === 'terms' ? 'active' : ''}>Terms</a>
        </nav>
      </header>

      <section className="legal-hero">
        <div className="legal-hero-inner">
          <div className="legal-hero-icon"><PageIcon width={22} height={22} /></div>
          <p className="legal-eyebrow">Legal</p>
          <h1>{page.title}</h1>
          <p className="legal-intro">{page.intro}</p>
          <div className="legal-meta">
            <span>Last updated {LAST_UPDATED}</span>
            <span>{page.readTime}</span>
          </div>
        </div>
      </section>

      <main className="legal-main">
        <section className="legal-glance" aria-label="At a glance">
          {page.glance.map(item => {
            const Icon = item.icon;
            return (
              <div className="legal-glance-card" key={item.title}>
                <div className="legal-glance-icon"><Icon width={18} height={18} /></div>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </div>
            );
          })}
        </section>

        <div className="legal-layout">
          <aside className="legal-toc">
            <p className="legal-toc-title">On this page</p>
            <ol>
              {page.sections.map((section, i) => (
                <li key={section.title}>
                  <a href={`#s${i + 1}`} className={activeId === `s${i + 1}` ? 'active' : ''}>
                    <span>{String(i + 1).padStart(2, '0')}</span>{section.title}
                  </a>
                </li>
              ))}
            </ol>
          </aside>

          <div className="legal-sections">
            {page.sections.map((section, i) => (
              <article className="legal-section" id={`s${i + 1}`} key={section.title}>
                <div className="legal-section-head">
                  <span className="legal-num">{String(i + 1).padStart(2, '0')}</span>
                  <h2>{section.title}</h2>
                </div>
                <p className="legal-short"><strong>In short:</strong> {section.short}</p>
                <div className="legal-body">{section.body}</div>
              </article>
            ))}

            <a className="legal-next" href={doc === 'terms' ? '/privacy' : '/terms'}>
              <span>Also read</span>
              <strong>{doc === 'terms' ? 'Privacy Notice' : 'Terms of Use'}</strong>
              <ArrowUpRightIcon width={18} height={18} />
            </a>
          </div>
        </div>
      </main>

      <footer className="legal-footer">
        <div className="legal-footer-inner">
          <div className="legal-footer-brand">
            <HourglassIcon width={18} height={18} />
            <span>Mmerℇ</span>
            <p>Track your time. Work smarter.</p>
          </div>
          <div className="legal-footer-links">
            <a href="/privacy">Privacy Notice</a>
            <a href="/terms">Terms of Use</a>
            <a href={`mailto:${CONTACT_EMAIL}`}>Contact</a>
          </div>
        </div>
        <p className="legal-footer-copy">© {YEAR} Mmerℇ. Designed and built by Belinda Ewusi.</p>
      </footer>
    </div>
  );
}

export default Legal;

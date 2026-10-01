import { useState, useEffect, useRef } from 'react';
import emailjs from '@emailjs/browser';
import { supabase } from '../supabase';
import { getPublicHolidays } from '../lib/holidays';
import { callAI } from '../lib/ai';
import { dateToHHMM, formatClock, parseClockTime, minutesToHHMM, formatDuration } from '../lib/time';
import {
  isPushSupported, getNotificationPermission, isDesktopPushEnabled,
  enableDesktopPush, disableDesktopPush
} from '../lib/push';
import './Dashboard.css';
import Profile from './Profile';
import AIChatWidget from '../components/AIChatWidget';
import SessionTimeline from '../components/SessionTimeline';
import { PieChart, Pie, Cell, Tooltip } from 'recharts';
import {
  HourglassIcon, DashboardIcon, TimesheetIcon, BellIcon,
  ClockIcon, CoffeeIcon, CalendarIcon, PinIcon, MoonIcon, SunIcon,
  ChevronDownIcon, SuitcaseIcon, AlertIcon, RefreshIcon, HelpIcon, CheckCircleIcon,
  MenuIcon, XIcon, PanelLeftIcon, LogoutIcon
} from '../icons';
import { loadPref, savePref } from '../lib/prefs';

const TIME_OFF_TYPES = ['Annual Leave', 'Sick Leave', 'Unpaid Leave', 'Emergency Leave', 'Compassionate Leave'];

// Employee FAQ. Same list goes to the support chat so both give the same
// answers.
const EMPLOYEE_FAQ_ITEMS = [
  {
    q: 'How do I clock in or out?',
    a: 'Use the Clock In button on the Clock In card on your Dashboard. When you’re done for the day, press Clock Out on the same card.'
  },
  {
    q: 'What happens if I clock in away from the office?',
    a: 'You can still clock in, but the session is marked "Unauthorised" and sent to your admin for review. They can either authorise it or decline it. A declined session isn’t counted towards your hours.'
  },
  {
    q: 'Why does my location show N/A?',
    a: 'Your browser didn’t share your location when you clocked in. Allow location access for this site in your browser settings so your next clock-in can be checked properly.'
  },
  {
    q: 'How do breaks work?',
    a: 'Press Break on the Clock In card to pause your work timer, then press Resume when you’re back. Your break time is saved separately from your worked hours.'
  },
  {
    q: 'What if I forget to clock out?',
    a: 'You get reminders at 2 and 3 hours (to take a break) and at 8 hours (to clock out). If you’re still clocked in at 8 hours 15 minutes, you’re clocked out automatically.'
  },
  {
    q: 'How do I request time off?',
    a: 'Go to the Time Off tab and fill in the form, or describe it in plain English and press "Fill form" to have it filled in for you. Check the details, then press Submit Request.'
  },
  {
    q: 'How do I know if my time off was approved?',
    a: 'Check "Your requests" on the Time Off tab. It shows the status of each request and any note your admin left when approving or rejecting it. You can cancel a request while it’s still pending.'
  },
  {
    q: 'Can I edit my timesheet?',
    a: 'No, only an admin can correct a timesheet entry. If something looks wrong, let your admin know which day it is.'
  },
  {
    q: 'How do I change my profile picture or details?',
    a: 'Click your name at the bottom of the menu to open your Profile, then click the pencil icon on your picture. Your email and department can only be changed by an admin.'
  },
  {
    q: 'How do I switch to dark mode?',
    a: 'Use the Dark/Light toggle at the top right of the Dashboard page.'
  }
];

const EMPLOYEE_FAQ_TEXT = EMPLOYEE_FAQ_ITEMS.map(item => `- ${item.q} ${item.a}`).join('\n');

function locationLabel(status) {
  if (status === 'authorised') return 'Authorised';
  if (status === 'unauthorised') return 'Unauthorised';
  if (status === 'declined') return 'Declined';
  return 'N/A';
}

// Declined sessions don't count towards totals.
function isCounted(record) {
  return record.location_status !== 'declined';
}

// tooltip text for the collapsed sidebar
const NAV_TITLES = { dashboard: 'Dashboard', timesheet: 'Timesheet', timeoff: 'Time Off', reminders: 'Reminders', faq: 'FAQ' };

function Dashboard({ user, onLogout }) {
  const [profile, setProfile] = useState(null);
  const [isClockedIn, setIsClockedIn] = useState(false);
  const [isOnBreak, setIsOnBreak] = useState(false);
  const [seconds, setSeconds] = useState(0);
  // Reminders already fired this session. Ref so it doesn't re-render. Using
  // >= since seconds can jump past the exact value on a resync or refresh.
  const remindersFiredRef = useRef({
    break2h: false,
    break3h: false,
    clockOut8h: false,
    autoClockOut: false
  });
  // clock_in_at the reminder flags were last reset for. Admin clock-ins come
  // in through the 30s sync, not handleClockIn(), so this is how a new session
  // gets picked up.
  const lastRemindersResetForRef = useRef(null);
  // Stops a double-click on Clock Out saving the session twice.
  const clockOutInProgressRef = useRef(false);
  const [breakSeconds, setBreakSeconds] = useState(0);
  // finished breaks this session (breakSeconds is only the current break)
  const [breakAccumSeconds, setBreakAccumSeconds] = useState(0);
  const [breakList, setBreakList] = useState([]);
  const [reminder, setReminder] = useState('');
  const [clockInTime, setClockInTime] = useState(null);
  const [records, setRecords] = useState([]);
  const [activePage, setActivePage] = useState('dashboard');
  const [showBreakConfirm, setShowBreakConfirm] = useState(false);
  const [timesheetViewMode, setTimesheetViewMode] = useState('monthly');
  const [timesheetMonthDate, setTimesheetMonthDate] = useState(() => {
    const d = new Date();
    d.setDate(1);
    d.setHours(0, 0, 0, 0);
    return d;
  });
  const [timesheetSelectedDate, setTimesheetSelectedDate] = useState(null);
  const [activitiesFilter, setActivitiesFilter] = useState('daily');
  const [isDarkMode, setIsDarkMode] = useState(() => loadPref('employeeDark', false));
  const [locationStatus, setLocationStatus] = useState(null);
  const [locationName, setLocationName] = useState('');
  const [avatarUrl, setAvatarUrl] = useState(null);
  const [isNavOpen, setIsNavOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(() => loadPref('employeeSidebarCollapsed', false));
  const [openFaqIndex, setOpenFaqIndex] = useState(null);
  const [timeOffRefreshState, setTimeOffRefreshState] = useState('idle');
  const dayDetailRef = useRef(null);
  const scrollToDetailRef = useRef(false);

  // Time off
  const [timeOffRequests, setTimeOffRequests] = useState([]);
  const [timeOffType, setTimeOffType] = useState('');
  const [timeOffStart, setTimeOffStart] = useState('');
  const [timeOffEnd, setTimeOffEnd] = useState('');
  const [timeOffReason, setTimeOffReason] = useState('');
  const [timeOffError, setTimeOffError] = useState('');
  const [timeOffSuccess, setTimeOffSuccess] = useState('');
  const [timeOffSubmitting, setTimeOffSubmitting] = useState(false);
  const [cancellingId, setCancellingId] = useState(null);
  const [showQuickFill, setShowQuickFill] = useState(false);

  // AI features
  const [weeklySummaryText, setWeeklySummaryText] = useState('');
  const [weeklySummaryLoading, setWeeklySummaryLoading] = useState(false);
  const [quickTimeOffText, setQuickTimeOffText] = useState('');
  const [quickFillLoading, setQuickFillLoading] = useState(false);
  const [quickFillError, setQuickFillError] = useState('');

  // Optional reminders. The three fixed ones are on the Reminders page.
  // Location Alerts is an admin setting.
  const [optionalReminders, setOptionalReminders] = useState({
    weeklySummary: false,
    missedClockIn: false
  });

  // Desktop push. Separate from optionalReminders since it depends on this
  // browser's subscription and permission.
  const [pushSupported, setPushSupported] = useState(true);
  const [pushPermission, setPushPermission] = useState('default');
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [pushError, setPushError] = useState('');

  const OFFICE_LAT = 5.5965681;
  const OFFICE_LNG = -0.2240833;
  // 50m from the office. GPS can be a few metres off indoors, so the reading's
  // own accuracy is allowed for, capped at 25m so a rough fix can't pass.
  const ALLOWED_RADIUS_METERS = 50;
  const MAX_ACCURACY_ALLOWANCE = 25;

  function getCurrentTime() {
    return new Date().toLocaleTimeString([], {
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  const [currentTime, setCurrentTime] = useState(getCurrentTime());

  function getUsername() {
    if (profile?.full_name) {
      return profile.full_name;
    }
    if (user?.user_metadata?.full_name) {
      return user.user_metadata.full_name;
    }
    return user?.email?.split('@')[0] || 'User';
  }

  function getFirstName() {
    return getUsername().split(' ')[0];
  }

  function getUserRole() {
    // profiles.department is set on approval. user_metadata.department is a
    // fallback for older accounts.
    return profile?.department || user?.user_metadata?.department || 'Employee';
  }

  function getUserCountry() {
    return user?.user_metadata?.country || 'Ghana';
  }

  useEffect(() => {
    if (user) {
      loadRecords();
      loadTimeOff();
      loadProfile();
      syncClockStateFromServer();
      setAvatarUrl(user?.user_metadata?.avatar_url || null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function loadProfile() {
    const { data, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', user.id)
      .maybeSingle();

    if (!error && data) {
      setProfile(data);
      if (data.optional_reminders) {
        setOptionalReminders({
          weeklySummary: !!data.optional_reminders.weeklySummary,
          missedClockIn: !!data.optional_reminders.missedClockIn
        });
      }
    }
  }

  function applyLocationStatus(value) {
    if (!value) {
      setLocationStatus(null);
      setLocationName('');
      return;
    }
    setLocationStatus(value);
    if (value === 'authorised') setLocationName('Authorised location');
    else if (value === 'unauthorised') setLocationName('Unauthorised location');
    else if (value === 'declined') setLocationName('Clock-in declined by admin');
    else setLocationName('Location unavailable');
  }

  // Syncs local clock/break state with the employee_status row. Runs on load
  // (so a refresh keeps the session) and every 30s (picks up admin changes).
  // Location comes back from here too so a refresh doesn't lose it.
  function applyServerClockState(status) {
    if (!status || status.status === 'not_clocked_in' || status.status === 'clocked_out') {
      setIsClockedIn(false);
      setIsOnBreak(false);
      setSeconds(0);
      setBreakSeconds(0);
      setBreakAccumSeconds(0);
      applyLocationStatus(null);
      // Next clock-in counts as a new session so the reminder flags reset.
      lastRemindersResetForRef.current = null;
      return;
    }

    const clockInAt = status.clock_in_at ? new Date(status.clock_in_at).getTime() : Date.now();
    const breakAccum = status.break_accum_seconds || 0;

    // New clock_in_at = new session (own or admin-started), reset the reminder
    // flags.
    if (lastRemindersResetForRef.current !== clockInAt) {
      lastRemindersResetForRef.current = clockInAt;
      remindersFiredRef.current = {
        break2h: false,
        break3h: false,
        clockOut8h: false,
        autoClockOut: false
      };
    }

    setIsClockedIn(true);
    setClockInTime(dateToHHMM(new Date(clockInAt)));
    setBreakAccumSeconds(breakAccum);
    applyLocationStatus(status.location_status || null);

    if (status.status === 'on_break' && status.break_started_at) {
      const breakStartAt = new Date(status.break_started_at).getTime();
      setIsOnBreak(true);
      setSeconds(Math.max(0, Math.round((breakStartAt - clockInAt) / 1000) - breakAccum));
      setBreakSeconds(Math.max(0, Math.round((Date.now() - breakStartAt) / 1000)));
    } else {
      setIsOnBreak(false);
      setBreakSeconds(0);
      setSeconds(Math.max(0, Math.round((Date.now() - clockInAt) / 1000) - breakAccum));
    }
  }

  async function syncClockStateFromServer() {
    const status = await readEmployeeStatus();
    applyServerClockState(status);
  }

  // Realtime on my own employee_status row: admin edits, authorise/decline,
  // clock-outs and auto clock-out show straight away. The 30s poll below
  // is the backup.
  useEffect(() => {
    if (!user) return undefined;
    const channel = supabase
      .channel(`employee-status-${user.id}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'employee_status',
        filter: `user_id=eq.${user.id}`
      }, () => {
        syncClockStateFromServer();
        loadRecords();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // Every 30s: sign out if the account was deleted, refresh time off and
  // records, resync clock state.
  useEffect(() => {
    if (!user) return;

    const interval = setInterval(async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('id')
        .eq('id', user.id)
        .maybeSingle();

      if (!error && !data) {
        clearInterval(interval);
        await supabase.auth.signOut();
        alert('Your account access has been removed by an admin.');
        onLogout();
        return;
      }

      loadTimeOff();
      loadRecords();
      syncClockStateFromServer();
    }, 30000);

    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function loadRecords() {
    loadBreaks();
    const { data, error } = await supabase
      .from('records')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setRecords(data);
    }
  }

  // Own breaks, one row each (supabase/breaks.sql). Empty if not set up yet.
  async function loadBreaks() {
    const { data, error } = await supabase
      .from('breaks')
      .select('*')
      .eq('user_id', user.id)
      .order('started_at', { ascending: true });
    setBreakList(error ? [] : (data || []));
  }

  async function loadTimeOff() {
    const { data, error } = await supabase
      .from('time_off_requests')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false });

    if (!error && data) {
      setTimeOffRequests(data);
    }
  }

  useEffect(() => {
    let timer;
    if (isClockedIn && !isOnBreak) {
      timer = setInterval(() => {
        setSeconds(prev => prev + 1);
      }, 1000);
    }
    if (isOnBreak) {
      timer = setInterval(() => {
        setBreakSeconds(prev => prev + 1);
      }, 1000);
    }
    return () => clearInterval(timer);
  }, [isClockedIn, isOnBreak]);

  useEffect(() => {
    const clock = setInterval(() => {
      setCurrentTime(getCurrentTime());
    }, 1000);
    return () => clearInterval(clock);
  }, []);

  useEffect(() => {
    if (!isClockedIn) return;

    const fired = remindersFiredRef.current;

    if (seconds >= 7200 && !fired.break2h) {
      fired.break2h = true;
      setReminder('You have been working for 2 hours. A short break can help.');
      sendBrowserNotification('Break Nudge — Mmerℇ', 'You have been working for 2 hours. A short break can help.');
    }
    if (seconds >= 10800 && !fired.break3h) {
      fired.break3h = true;
      setReminder('You have been working for 3 hours. Time to take a break.');
      sendBrowserNotification('Break Reminder — Mmerℇ', 'You have been working for 3 hours. Time to take a break.');
      sendEmailNotification('Break Reminder — Mmerℇ', 'You have been working for 3 hours. Time to take a break.');
    }
    if (seconds >= 28800 && !fired.clockOut8h) {
      fired.clockOut8h = true;
      setReminder('You have worked 8 hours. Please clock out.');
      sendBrowserNotification('Clock Out Reminder — Mmerℇ', 'You have worked 8 hours. Please clock out.');
      sendEmailNotification('Clock Out Reminder — Mmerℇ', 'You have worked 8 hours. Please clock out.');
    }
    if (seconds >= 29700 && !fired.autoClockOut) {
      fired.autoClockOut = true;
      // On-screen notice only. The actual auto clock-out happens in reminder-
      // sweep and the 30s sync picks it up.
      setReminder('You are being automatically clocked out.');
      sendBrowserNotification('Auto Clock Out — Mmerℇ', 'You are being automatically clocked out after 8 hours 15 minutes.');
      sendEmailNotification('Auto Clock Out — Mmerℇ', 'You are being automatically clocked out after 8 hours 15 minutes.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seconds, isClockedIn]);

  function getCurrentDate() {
    return new Date().toLocaleDateString('en-GB', {
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric'
    });
  }

  function formatDisplayDate(dateStr) {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function formatTime(secs) {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}`;
  }

  function hmsToSeconds(str) {
    if (!str) return 0;
    const parts = str.split(':').map(Number);
    return (parts[0] || 0) * 3600 + (parts[1] || 0) * 60 + (parts[2] || 0);
  }

  // Finished sessions today + the one still running (same as Activities)
  function getTotalHoursToday() {
    const today = new Date().toLocaleDateString('en-GB');
    const todayRecords = records.filter(r => r.date === today && isCounted(r));
    let totalSeconds = isClockedIn ? seconds : 0;
    todayRecords.forEach(record => {
      totalSeconds += hmsToSeconds(record.hours_worked);
    });
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = totalSeconds % 60;
    return { h, m, s };
  }

  function getDistanceMeters(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a =
      Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) *
      Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  function checkLocation() {
    return new Promise((resolve) => {
      if (!navigator.geolocation) {
        applyLocationStatus('unavailable');
        resolve('unavailable');
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (position) => {
          const { latitude, longitude, accuracy } = position.coords;
          const distance = getDistanceMeters(latitude, longitude, OFFICE_LAT, OFFICE_LNG);
          const allowance = Math.min(accuracy || 0, MAX_ACCURACY_ALLOWANCE);
          const result = distance - allowance <= ALLOWED_RADIUS_METERS ? 'authorised' : 'unauthorised';
          applyLocationStatus(result);
          resolve(result);
        },
        () => {
          applyLocationStatus('unavailable');
          resolve('unavailable');
        },
        // Timeout so Clock In doesn't hang if the location prompt is ignored.
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  }

  async function saveRecord() {
    // Location from employee_status first (survives a refresh and holds the
    // admin's authorise/decline), local state as fallback.
    // Hours and break from the server's clock_in_at + break total, so an
    // admin edit to a live session is picked up and the local timer isn't trusted.
    const serverStatus = await readEmployeeStatus();
    const now = new Date();
    const clockInAt = serverStatus?.clock_in_at ? new Date(serverStatus.clock_in_at) : null;
    const breakTotal = clockInAt ? (serverStatus.break_accum_seconds || 0) : breakAccumSeconds;
    const workedSeconds = clockInAt
      ? Math.max(0, Math.round((now - clockInAt) / 1000) - breakTotal)
      : seconds;
    const newRecord = {
      user_id: user.id,
      date: now.toLocaleDateString('en-GB'),
      clock_in: clockInAt ? dateToHHMM(clockInAt) : clockInTime,
      clock_out: dateToHHMM(now),
      hours_worked: formatTime(workedSeconds),
      break_time: formatTime(breakTotal),
      location_status: serverStatus?.location_status || locationStatus || 'unavailable'
    };

    const { data, error } = await supabase
      .from('records')
      .insert([newRecord])
      .select();
    if (!error && data) {
      await loadRecords();
    } else {
      console.log('Failed to save:', error);
    }
  }

  function requestNotificationPermission() {
    if ('Notification' in window) {
      Notification.requestPermission();
    }
  }

  function sendBrowserNotification(title, message) {
    if ('Notification' in window && Notification.permission === 'granted') {
      new Notification(title, { body: message });
    }
  }

  function sendEmailNotification(title, message) {
    emailjs.send('service_qo5r5ol', 'template_iyjajm8', {
      title: title,
      to_name: getUsername(),
      to_email: user.email,
      message: message
    }, 'EWbasKvfwG1WXLCuA')
    .then(() => console.log('Email sent successfully!'))
    .catch((error) => console.log('Email error:', error));
  }

  // employee_status read/write. The admin dashboard reads this live.
  async function readEmployeeStatus() {
    const { data } = await supabase
      .from('employee_status')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();
    return data || { status: 'not_clocked_in', clock_in_at: null, break_started_at: null, break_accum_seconds: 0, location_status: null };
  }

  async function syncEmployeeStatus(status) {
    const row = { user_id: user.id, ...status, updated_at: new Date().toISOString() };
    const { error } = await supabase.from('employee_status').upsert(row);

    // Retry without location_status if the column isn't there yet
    // (supabase/location_status.sql).
    if (error && String(error.message || '').includes('location_status')) {
      const withoutLocation = { ...row };
      delete withoutLocation.location_status;
      await supabase.from('employee_status').upsert(withoutLocation);
    }
  }

  async function handleClockIn() {
    const location = await checkLocation();

    setIsClockedIn(true);
    setIsOnBreak(false);
    setSeconds(0);
    setBreakSeconds(0);
    setClockInTime(dateToHHMM(new Date()));
    setBreakAccumSeconds(0);
    requestNotificationPermission();
    // New session, reset the reminder flags.
    remindersFiredRef.current = {
      break2h: false,
      break3h: false,
      clockOut8h: false,
      autoClockOut: false
    };

    // Unauthorised location doesn't block clock-in. It's flagged for the admin
    // to authorise or decline.
    if (location === 'unauthorised') {
      setReminder('You have been clocked in, but your location could not be verified as authorised. This has been flagged for admin review.');
    }

    // Written to employee_status so the admin sees the clock-in and location
    // straight away. Reminder-sent flags reset for reminder-sweep.
    await syncEmployeeStatus({
      status: 'clocked_in',
      clock_in_at: new Date().toISOString(),
      break_started_at: null,
      break_accum_seconds: 0,
      location_status: location,
      break_2h_sent: false,
      break_3h_sent: false,
      clock_out_8h_sent: false,
      auto_clock_out_sent: false
    });
  }

  async function handleClockOut() {
    if (clockOutInProgressRef.current) return;
    clockOutInProgressRef.current = true;

    // Save the record before clearing employee_status, otherwise the location
    // is already gone.
    await saveRecord();
    setIsClockedIn(false);
    setIsOnBreak(false);
    setTimeout(() => {
      setSeconds(0);
      setBreakSeconds(0);
    }, 500);
    setReminder('');

    await syncEmployeeStatus({
      status: 'clocked_out',
      clock_in_at: null,
      break_started_at: null,
      break_accum_seconds: 0,
      location_status: null
    });
    clockOutInProgressRef.current = false;
  }

  async function handleBreak() {
    if (!isClockedIn) return;
    if (!isOnBreak) {
      setShowBreakConfirm(true);
    } else {
      setIsOnBreak(false);
      setReminder('Break ended. Welcome back.');

      const current = await readEmployeeStatus();
      const newAccum = (current.break_accum_seconds || 0) + breakSeconds;
      setBreakAccumSeconds(newAccum);
      await syncEmployeeStatus({
        ...current,
        status: 'clocked_in',
        break_started_at: null,
        break_accum_seconds: newAccum
      });
    }
  }

  async function confirmBreak() {
    setShowBreakConfirm(false);
    setIsOnBreak(true);
    setBreakSeconds(0);
    setReminder('You are now on a break. Timer paused.');

    const current = await readEmployeeStatus();
    await syncEmployeeStatus({
      ...current,
      status: 'on_break',
      break_started_at: new Date().toISOString()
    });
  }

  function cancelBreak() {
    setShowBreakConfirm(false);
  }

  function getStatus() {
    if (!isClockedIn) return { text: 'Not Clocked In', tone: 'neutral' };
    if (isOnBreak) return { text: 'On Break', tone: 'warning' };
    return { text: 'Clocked In', tone: 'success' };
  }

  function getRecordsForPeriod(period) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    if (period === 'today') {
      return records.filter(r => {
        const parts = r.date.split('/');
        const recordDate = new Date(parts[2], parts[1] - 1, parts[0]);
        recordDate.setHours(0, 0, 0, 0);
        return recordDate.getTime() === today.getTime();
      });
    }
    if (period === 'week') {
      const startOfWeek = new Date(today);
      const day = today.getDay();
      const diff = today.getDate() - day + (day === 0 ? -6 : 1);
      startOfWeek.setDate(diff);
      startOfWeek.setHours(0, 0, 0, 0);
      return records.filter(r => {
        const parts = r.date.split('/');
        const recordDate = new Date(parts[2], parts[1] - 1, parts[0]);
        return recordDate >= startOfWeek;
      });
    }
    if (period === 'month') {
      const startOfMonth = new Date(today.getFullYear(), today.getMonth(), 1);
      return records.filter(r => {
        const parts = r.date.split('/');
        const recordDate = new Date(parts[2], parts[1] - 1, parts[0]);
        return recordDate >= startOfMonth;
      });
    }
    return records;
  }

  function filteredRecords() {
    return getRecordsForPeriod('all');
  }

  // ---------- Timesheet page: calendar view ----------

  function parseRecordDate(dateStr) {
    if (!dateStr) return null;
    const [d, m, y] = dateStr.split('/').map(Number);
    if (!d || !m || !y) return null;
    return new Date(y, m - 1, d);
  }

  function isSameCalendarDay(a, b) {
    return !!a && !!b &&
      a.getFullYear() === b.getFullYear() &&
      a.getMonth() === b.getMonth() &&
      a.getDate() === b.getDate();
  }

  function getRecordsForDay(day) {
    if (!day) return [];
    return records.filter(r => isSameCalendarDay(parseRecordDate(r.date), day));
  }

  function getRecordsForCalendarMonth(monthDate) {
    return records.filter(r => {
      const d = parseRecordDate(r.date);
      return d && d.getFullYear() === monthDate.getFullYear() && d.getMonth() === monthDate.getMonth();
    });
  }

  function getCalendarWeekRange(date) {
    const start = new Date(date);
    start.setHours(0, 0, 0, 0);
    // weeks run Monday to Sunday
    start.setDate(start.getDate() - ((start.getDay() + 6) % 7));
    const end = new Date(start);
    end.setDate(start.getDate() + 6);
    end.setHours(23, 59, 59, 999);
    return [start, end];
  }

  function sumRecordsSeconds(recs) {
    return recs.filter(isCounted).reduce((sum, r) => sum + hmsToSeconds(r.hours_worked), 0);
  }

  function buildMonthCells(monthDate) {
    const year = monthDate.getFullYear();
    const month = monthDate.getMonth();
    const startWeekday = (new Date(year, month, 1).getDay() + 6) % 7; // Monday first
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startWeekday; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
    return cells;
  }

  function getActiveTimesheetDate() {
    return timesheetSelectedDate || new Date();
  }

  function shiftTimesheetMonth(delta) {
    setTimesheetMonthDate(prev => {
      const next = new Date(prev);
      next.setMonth(next.getMonth() + delta);
      return next;
    });
    setTimesheetSelectedDate(null);
  }

  function shiftTimesheetPeriod(delta) {
    if (timesheetViewMode === 'monthly') {
      shiftTimesheetMonth(delta);
      return;
    }
    const base = getActiveTimesheetDate();
    const next = new Date(base);
    next.setDate(next.getDate() + delta * (timesheetViewMode === 'weekly' ? 7 : 1));
    setTimesheetSelectedDate(next);
    setTimesheetMonthDate(new Date(next.getFullYear(), next.getMonth(), 1));
  }

  function getTimesheetPeriodLabel() {
    if (timesheetViewMode === 'monthly') {
      return timesheetMonthDate.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    }
    const base = getActiveTimesheetDate();
    if (timesheetViewMode === 'weekly') {
      const [start, end] = getCalendarWeekRange(base);
      return `${start.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} – ${end.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}`;
    }
    return base.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  function selectTimesheetMode(mode) {
    setTimesheetViewMode(mode);
    if (mode !== 'all' && !timesheetSelectedDate) setTimesheetSelectedDate(new Date());
  }

  // Session still running: counted as today everywhere, same as Activities
  function getLiveBreakSeconds() {
    return breakAccumSeconds + (isOnBreak ? breakSeconds : 0);
  }

  function liveSessionIn(start, end) {
    if (!isClockedIn) return false;
    const today = new Date();
    return today >= start && today <= end;
  }

  function getTimesheetPeriodTotal() {
    const active = getActiveTimesheetDate();
    let total;
    let start;
    let end;
    if (timesheetViewMode === 'daily') {
      total = sumRecordsSeconds(getRecordsForDay(active));
      start = new Date(active); start.setHours(0, 0, 0, 0);
      end = new Date(active); end.setHours(23, 59, 59, 999);
    } else if (timesheetViewMode === 'weekly') {
      [start, end] = getCalendarWeekRange(active);
      total = sumRecordsSeconds(records.filter(r => {
        const d = parseRecordDate(r.date);
        return d && d >= start && d <= end;
      }));
    } else if (timesheetViewMode === 'monthly') {
      total = sumRecordsSeconds(getRecordsForCalendarMonth(timesheetMonthDate));
      start = new Date(timesheetMonthDate.getFullYear(), timesheetMonthDate.getMonth(), 1);
      end = new Date(timesheetMonthDate.getFullYear(), timesheetMonthDate.getMonth() + 1, 0, 23, 59, 59, 999);
    } else {
      return sumRecordsSeconds(filteredRecords()) + (isClockedIn ? seconds : 0);
    }
    return total + (liveSessionIn(start, end) ? seconds : 0);
  }

  // Activities card. Daily = sessions finished today + the one running now.
  // Weekly/Monthly = saved records.
  function getActivitiesStats() {
    if (activitiesFilter === 'daily') {
      const todayRecs = getRecordsForPeriod('today');
      let completedWorked = 0;
      let completedBreak = 0;
      todayRecs.filter(isCounted).forEach(r => {
        completedWorked += hmsToSeconds(r.hours_worked);
        completedBreak += hmsToSeconds(r.break_time);
      });

      return {
        workedSeconds: completedWorked + seconds,
        breakSecondsVal: completedBreak + (isClockedIn ? getLiveBreakSeconds() : 0),
        targetSeconds: 28800,
        sessions: todayRecs.length + (isClockedIn ? 1 : 0),
        label: "Today's Summary"
      };
    }

    const period = activitiesFilter === 'weekly' ? 'week' : 'month';
    const recs = getRecordsForPeriod(period);
    let workedSecondsVal = 0;
    let breakSecondsVal = 0;
    recs.filter(isCounted).forEach(r => {
      workedSecondsVal += hmsToSeconds(r.hours_worked);
      breakSecondsVal += hmsToSeconds(r.break_time);
    });

    return {
      workedSeconds: workedSecondsVal + (isClockedIn ? seconds : 0),
      breakSecondsVal: breakSecondsVal + (isClockedIn ? getLiveBreakSeconds() : 0),
      targetSeconds: activitiesFilter === 'weekly' ? 40 * 3600 : 160 * 3600,
      sessions: recs.length + (isClockedIn ? 1 : 0),
      label: activitiesFilter === 'weekly' ? "This Week's Summary" : "This Month's Summary"
    };
  }

  // Public holidays + the employee's time off (upcoming and taken) for the
  // holidays card.
  function getHolidaysAndTimeOff() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const holidayItems = getPublicHolidays(getUserCountry()).map(h => ({
      date: h.date,
      label: h.name,
      kind: 'holiday'
    }));

    const timeOffItems = timeOffRequests
      .filter(t => t.status !== 'rejected')
      .map(t => ({
        date: t.start_date,
        label: t.type,
        kind: 'timeoff',
        status: t.status
      }));

    const all = [...holidayItems, ...timeOffItems].map(item => ({
      ...item,
      dateObj: new Date(item.date)
    }));

    const upcoming = all
      .filter(i => i.dateObj >= today)
      .sort((a, b) => a.dateObj - b.dateObj)
      .slice(0, 5);

    const taken = all
      .filter(i => i.kind === 'timeoff' && i.dateObj < today)
      .sort((a, b) => b.dateObj - a.dateObj)
      .slice(0, 3);

    return { upcoming, taken };
  }

  // ---------- Time off: day counts ----------

  function toIsoDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  // Mon-Fri, public holidays don't count. `until` stops the count early
  // (used for "taken this year" so future days aren't counted yet).
  function countWorkingDays(startIso, endIso, from = null, until = null) {
    if (!startIso || !endIso) return 0;
    const holidays = new Set(getPublicHolidays(getUserCountry()).map(h => h.date));
    const day = new Date(`${startIso}T00:00:00`);
    const end = new Date(`${endIso}T00:00:00`);
    if (from && day < from) day.setTime(from.getTime());
    let count = 0;
    while (day <= end && (!until || day <= until)) {
      const weekday = day.getDay();
      if (weekday !== 0 && weekday !== 6 && !holidays.has(toIsoDate(day))) count += 1;
      day.setDate(day.getDate() + 1);
    }
    return count;
  }

  function dayLabel(n) {
    return `${n} working day${n === 1 ? '' : 's'}`;
  }

  // "14 Oct", "5–7 Oct", "30 Sep – 2 Oct" (year added when it isn't this year)
  function formatDateRange(startIso, endIso) {
    const start = new Date(`${startIso}T00:00:00`);
    const end = new Date(`${(endIso || startIso)}T00:00:00`);
    const thisYear = new Date().getFullYear();
    const year = end.getFullYear() !== thisYear ? ` ${end.getFullYear()}` : '';
    const month = d => d.toLocaleDateString('en-GB', { month: 'short' });
    if (startIso === (endIso || startIso)) return `${start.getDate()} ${month(start)}${year}`;
    if (start.getMonth() === end.getMonth() && start.getFullYear() === end.getFullYear()) {
      return `${start.getDate()}\u2013${end.getDate()} ${month(end)}${year}`;
    }
    return `${start.getDate()} ${month(start)} \u2013 ${end.getDate()} ${month(end)}${year}`;
  }

  function getTimeOffSummary() {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = toIsoDate(today);
    const yearStart = new Date(today.getFullYear(), 0, 1);

    const pending = timeOffRequests.filter(t => t.status === 'pending').length;
    const takenDays = timeOffRequests
      .filter(t => t.status === 'approved' && t.start_date <= todayIso)
      .reduce((sum, t) => sum + countWorkingDays(t.start_date, t.end_date, yearStart, today), 0);
    const next = timeOffRequests
      .filter(t => t.status === 'approved' && (t.end_date || t.start_date) >= todayIso)
      .sort((a, b) => a.start_date.localeCompare(b.start_date))[0];

    let nextLabel = 'None booked';
    if (next) nextLabel = next.start_date <= todayIso ? 'On leave now' : formatDateRange(next.start_date, next.start_date);

    return { pending, takenDays, nextLabel };
  }

  // Pending / Upcoming (approved, not over yet) / History (taken or rejected)
  function getGroupedTimeOff() {
    const todayIso = toIsoDate(new Date());
    const byStart = (a, b) => a.start_date.localeCompare(b.start_date);
    return {
      pending: timeOffRequests.filter(t => t.status === 'pending').sort(byStart),
      upcoming: timeOffRequests.filter(t => t.status === 'approved' && (t.end_date || t.start_date) >= todayIso).sort(byStart),
      history: timeOffRequests
        .filter(t => t.status === 'rejected' || (t.status === 'approved' && (t.end_date || t.start_date) < todayIso))
        .sort((a, b) => byStart(b, a))
    };
  }

  async function handleTimeOffSubmit() {
    if (!timeOffType || !timeOffStart || !timeOffEnd) {
      setTimeOffError('Please choose a leave type and both dates.');
      setTimeOffSuccess('');
      return;
    }
    if (new Date(timeOffEnd) < new Date(timeOffStart)) {
      setTimeOffError('The end date cannot be before the start date.');
      setTimeOffSuccess('');
      return;
    }
    if (timeOffStart < toIsoDate(new Date())) {
      setTimeOffError('Time off can\u2019t start in the past.');
      setTimeOffSuccess('');
      return;
    }
    if (countWorkingDays(timeOffStart, timeOffEnd) === 0) {
      setTimeOffError('These dates don\u2019t include any working days.');
      setTimeOffSuccess('');
      return;
    }

    setTimeOffSubmitting(true);
    setTimeOffError('');
    setTimeOffSuccess('');

    const request = {
      user_id: user.id,
      type: timeOffType,
      start_date: timeOffStart,
      end_date: timeOffEnd,
      reason: timeOffReason
    };

    const { error } = await supabase
      .from('time_off_requests')
      .insert([{ ...request, status: 'pending' }]);

    setTimeOffSubmitting(false);
    if (error) {
      setTimeOffError('Could not submit your request. Please try again.');
    } else {
      setTimeOffSuccess('Your time off request has been submitted for approval.');
      setTimeOffType('');
      setTimeOffStart('');
      setTimeOffEnd('');
      setTimeOffReason('');
      await loadTimeOff();
    }
  }

  async function handleCancelTimeOff(requestId) {
    setCancellingId(requestId);

    // Deleted instead of marked cancelled, the admin doesn't need to see it.
    await supabase
      .from('time_off_requests')
      .delete()
      .eq('id', requestId)
      .eq('user_id', user.id)
      .eq('status', 'pending');

    await loadTimeOff();
    setCancellingId(null);
  }

  function toggleOptionalReminder(key) {
    setOptionalReminders(prev => {
      const next = { ...prev, [key]: !prev[key] };

      supabase
        .from('profiles')
        .update({ optional_reminders: next })
        .eq('id', user.id)
        .then(({ error }) => {
          if (error) console.log('Failed to save reminder preference:', error);
        });

      return next;
    });
  }

  // Check push state on load so the toggle shows the right state first time.
  useEffect(() => {
    if (!user) return;
    setPushSupported(isPushSupported());
    if (isPushSupported()) {
      setPushPermission(getNotificationPermission());
      isDesktopPushEnabled().then(setPushEnabled);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  async function handleEnableDesktopPush() {
    setPushLoading(true);
    setPushError('');
    try {
      const result = await enableDesktopPush(user.id);
      setPushPermission(result.permission);
      setPushEnabled(result.enabled);
      if (!result.enabled) {
        // Permission denied or prompt closed.
        setPushError('Notifications are blocked for this site. You can allow them in your browser\u2019s site settings, then try again.');
      }
    } catch (err) {
      setPushError('Something went wrong turning notifications on. Please try again.');
    }
    setPushLoading(false);
  }

  async function handleDisableDesktopPush() {
    setPushLoading(true);
    setPushError('');
    try {
      await disableDesktopPush(user.id);
      setPushEnabled(false);
    } catch (err) {
      setPushError('Something went wrong turning notifications off. Please try again.');
    }
    setPushLoading(false);
  }

  // ---------- AI: natural-language time off ----------
  // Fills the form from a plain-English sentence. Still needs checking and
  // Submit.
  async function handleQuickFillTimeOff() {
    if (!quickTimeOffText.trim()) return;
    setQuickFillLoading(true);
    setQuickFillError('');
    try {
      const today = new Date().toISOString().split('T')[0];
      const result = await callAI('parse_time_off', { text: quickTimeOffText, today });
      if (result.type) setTimeOffType(result.type);
      if (result.start_date) setTimeOffStart(result.start_date);
      if (result.end_date) setTimeOffEnd(result.end_date);
      if (result.reason) setTimeOffReason(result.reason);
    } catch (err) {
      setQuickFillError("Couldn't read that — please fill the form in below instead.");
    }
    setQuickFillLoading(false);
  }

  // ---------- AI: weekly summary ----------
  // On demand for now. Weekly email needs a scheduled job on the backend
  // (todo).
  async function handleGenerateWeeklySummary() {
    setWeeklySummaryLoading(true);
    setWeeklySummaryText('');
    try {
      const weekRecords = getRecordsForPeriod('week');
      let workedSecondsTotal = 0;
      let breakSecondsTotal = 0;
      weekRecords.filter(isCounted).forEach(r => {
        workedSecondsTotal += hmsToSeconds(r.hours_worked);
        breakSecondsTotal += hmsToSeconds(r.break_time);
      });
      const approvedTimeOffCount = timeOffRequests.filter(t => t.status === 'approved').length;

      const result = await callAI('weekly_summary', {
        employeeName: getFirstName(),
        weekLabel: 'this week',
        hoursWorked: `${Math.floor(workedSecondsTotal / 3600)}h ${Math.floor((workedSecondsTotal % 3600) / 60)}m`,
        breakHours: `${Math.floor(breakSecondsTotal / 3600)}h ${Math.floor((breakSecondsTotal % 3600) / 60)}m`,
        sessionsCount: weekRecords.length,
        timeOffDays: approvedTimeOffCount
      });
      setWeeklySummaryText(result.message);
    } catch (err) {
      setWeeklySummaryText("Couldn't generate a summary right now — please try again shortly.");
    }
    setWeeklySummaryLoading(false);
  }

  function buildChatContext() {
    const stats = getActivitiesStats();
    const pendingCount = timeOffRequests.filter(t => t.status === 'pending').length;
    return {
      faq: EMPLOYEE_FAQ_TEXT,
      employeeData: `Name: ${getUsername()}. Currently: ${getStatus().text}. ` +
        `Hours worked today: ${Math.floor(stats.workedSeconds / 3600)}h ${Math.floor((stats.workedSeconds % 3600) / 60)}m. ` +
        `Pending time off requests: ${pendingCount}. Country: ${getUserCountry()}.`
    };
  }

  // Spinner on the Time Off refresh button, then "Updated" for a moment.
  async function handleTimeOffRefresh() {
    if (timeOffRefreshState === 'refreshing') return;
    setTimeOffRefreshState('refreshing');
    await Promise.all([loadTimeOff(), new Promise(resolve => setTimeout(resolve, 600))]);
    setTimeOffRefreshState('done');
    setTimeout(() => setTimeOffRefreshState('idle'), 1500);
  }

  // Sessions for the timeline (components/SessionTimeline), read only here
  function breakToModel(b) {
    return {
      id: b.id,
      start: dateToHHMM(new Date(b.started_at)),
      end: b.ended_at ? dateToHHMM(new Date(b.ended_at)) : null
    };
  }

  function recordToSession(record) {
    const inMinutes = parseClockTime(record.clock_in);
    const outMinutes = parseClockTime(record.clock_out);
    return {
      clockIn: inMinutes === null ? '' : minutesToHHMM(inMinutes),
      clockOut: outMinutes === null ? '' : minutesToHHMM(outMinutes),
      breaks: breakList.filter(b => b.record_id === String(record.id)).map(breakToModel),
      breakTotal: record.break_time || '00:00:00',
      declined: record.location_status === 'declined'
    };
  }

  function liveSession() {
    return {
      clockIn: clockInTime,
      clockOut: null,
      breaks: breakList.filter(b => !b.record_id).map(breakToModel),
      breakTotal: formatTime(getLiveBreakSeconds()),
      declined: locationStatus === 'declined'
    };
  }

  // Day click on the calendar/week: scroll down to that day's entries.
  function selectTimesheetDay(day) {
    scrollToDetailRef.current = true;
    setTimesheetSelectedDate(day);
  }

  useEffect(() => {
    if (!scrollToDetailRef.current) return;
    scrollToDetailRef.current = false;
    requestAnimationFrame(() => {
      if (dayDetailRef.current) dayDetailRef.current.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [timesheetSelectedDate]);

  // Close the mobile menu after picking a page.
  // remembered per browser
  useEffect(() => { savePref('employeeDark', isDarkMode); }, [isDarkMode]);
  useEffect(() => { savePref('employeeSidebarCollapsed', isSidebarCollapsed); }, [isSidebarCollapsed]);

  function goToPage(page) {
    setActivePage(page);
    setIsNavOpen(false);
  }

  const status = getStatus();
  const activityStats = getActivitiesStats();
  const holidaysData = getHolidaysAndTimeOff();

  return (
    <div className={`dashboard-layout ${isDarkMode ? 'dark' : ''}`}>

      {/* Break Confirmation Popup */}
      {showBreakConfirm && (
        <div className="popup-overlay">
          <div className="popup-box">
            <h3>Going on break?</h3>
            <p>Are you sure you want to go on break? Your work timer will be paused.</p>
            <div className="popup-buttons">
              <button className="popup-cancel" onClick={cancelBreak}>Cancel</button>
              <button className="popup-confirm" onClick={confirmBreak}>Yes, go on break</button>
            </div>
          </div>
        </div>
      )}

      {/* Sidebar (top bar + menu button on smaller screens) */}
      {isNavOpen && <div className="sidebar-backdrop" onClick={() => setIsNavOpen(false)} />}
      <div className={`sidebar ${isNavOpen ? 'nav-open' : ''} ${isSidebarCollapsed ? 'is-collapsed' : ''}`}>
        <div className="sidebar-top">
          <div className="sidebar-brand">
            <HourglassIcon width={20} height={20} />
            <span className="brand-name">Mmerℇ</span>
          </div>
          <button
            className="sidebar-menu-toggle"
            onClick={() => setIsNavOpen(prev => !prev)}
            aria-label={isNavOpen ? 'Close menu' : 'Open menu'}
            aria-expanded={isNavOpen}>
            {isNavOpen ? <XIcon width={18} height={18} /> : <MenuIcon width={18} height={18} />}
          </button>
        </div>
        <div className="sidebar-collapsible">
          <nav className="sidebar-nav">
            <button
              className={`nav-item ${activePage === 'dashboard' ? 'active' : ''}`}
              onClick={() => goToPage('dashboard')}
              title={isSidebarCollapsed ? NAV_TITLES.dashboard : undefined}>
              <DashboardIcon width={17} height={17} /> <span className="nav-label">Dashboard</span>
            </button>
            <button
              className={`nav-item ${activePage === 'timesheet' ? 'active' : ''}`}
              onClick={() => goToPage('timesheet')}
              title={isSidebarCollapsed ? NAV_TITLES.timesheet : undefined}>
              <TimesheetIcon width={17} height={17} /> <span className="nav-label">Timesheet</span>
            </button>
            <button
              className={`nav-item ${activePage === 'timeoff' ? 'active' : ''}`}
              onClick={() => goToPage('timeoff')}
              title={isSidebarCollapsed ? NAV_TITLES.timeoff : undefined}>
              <SuitcaseIcon width={17} height={17} /> <span className="nav-label">Time Off</span>
            </button>
            <button
              className={`nav-item ${activePage === 'reminders' ? 'active' : ''}`}
              onClick={() => goToPage('reminders')}
              title={isSidebarCollapsed ? NAV_TITLES.reminders : undefined}>
              <BellIcon width={17} height={17} /> <span className="nav-label">Reminders</span>
            </button>
            <button
              className={`nav-item ${activePage === 'faq' ? 'active' : ''}`}
              onClick={() => goToPage('faq')}
              title={isSidebarCollapsed ? NAV_TITLES.faq : undefined}>
              <HelpIcon width={17} height={17} /> <span className="nav-label">FAQ</span>
            </button>
          </nav>
          <button
            className="nav-item sidebar-collapse-btn"
            onClick={() => setIsSidebarCollapsed(prev => !prev)}
            title={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={isSidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}>
            <PanelLeftIcon width={17} height={17} /> <span className="nav-label">Collapse</span>
          </button>
          <div
            className="sidebar-user"
            onClick={() => goToPage('profile')}
            title="Click to view profile">
            {avatarUrl ? (
              <img src={avatarUrl} alt="" className="user-avatar user-avatar-img" />
            ) : (
              <div className="user-avatar">{getFirstName()[0]}</div>
            )}
            <div className="user-info">
              <p className="user-name">{getUsername()}</p>
              <p className="user-role">View profile</p>
            </div>
          </div>
          <button className="sidebar-signout" onClick={onLogout} title={isSidebarCollapsed ? 'Sign Out' : undefined}>
            <LogoutIcon width={15} height={15} /> <span className="nav-label">Sign Out</span>
          </button>
        </div>
      </div>

      {/* Main Content */}
      <div className="main-content">

        {/* ===== DASHBOARD PAGE ===== */}
        {activePage === 'dashboard' && (
          <div className="page">

            {/* Header */}
            <div className="page-header">
              <div className="header-welcome">
                {avatarUrl ? (
                  <img src={avatarUrl} alt="" className="header-avatar header-avatar-img" />
                ) : (
                  <div className="header-avatar">{getFirstName()[0]}</div>
                )}
                <div>
                  <h1>Welcome, {getUsername()}</h1>
                  <p className="page-date">{getUserRole()} · {getCurrentDate()} · {currentTime}</p>
                </div>
              </div>
              <div className="header-right">
                <button
                  className="dark-mode-toggle"
                  onClick={() => setIsDarkMode(prev => !prev)}>
                  {isDarkMode ? <SunIcon width={16} height={16} /> : <MoonIcon width={16} height={16} />}
                  {isDarkMode ? 'Light' : 'Dark'}
                </button>
              </div>
            </div>

            {/* Reminder Banner */}
            {reminder && (
              <div className="reminder-banner">
                {reminder}
                <button onClick={() => setReminder('')}>✕</button>
              </div>
            )}

            {/* Three Cards Row */}
            <div className="three-cards-row">

              {/* Card 1: Clock In */}
              <div className="main-card clock-card">
                <div className="card-header">
                  <ClockIcon width={17} height={17} className="card-icon" />
                  <span className="card-title">Clock In</span>
                  <span className={`card-status-badge status-${status.tone}`}>
                    {isClockedIn ? (isOnBreak ? 'On Break' : 'Ongoing') : 'Inactive'}
                  </span>
                </div>
                {locationStatus && (
                  <div className={`location-badge location-${locationStatus}`}>
                    <PinIcon width={13} height={13} /> {locationName}
                  </div>
                )}
                <div className="card-timer">{formatTime(seconds)}</div>
                {isOnBreak && (
                  <div className="break-timer"><CoffeeIcon width={13} height={13} /> Break: {formatTime(breakSeconds)}</div>
                )}
                <div className="card-buttons">
                  <button className="btn-clockin" onClick={handleClockIn} disabled={isClockedIn}>
                    Clock In
                  </button>
                  <button className="btn-break" onClick={handleBreak} disabled={!isClockedIn}>
                    {isOnBreak ? 'Resume' : 'Break'}
                  </button>
                  {!isOnBreak && isClockedIn && (
                    <button className="btn-clockout" onClick={handleClockOut}>Clock Out</button>
                  )}
                </div>
              </div>

              {/* Card 2: Planned Hours */}
              <div className="main-card planned-card">
                <div className="card-header">
                  <CalendarIcon width={17} height={17} className="card-icon" />
                  <span className="card-title">Planned Hours</span>
                </div>
                <div className="planned-hours-display">
                  <div className="planned-big">
                    <span className="planned-num">40</span>
                    <span className="planned-unit">hrs</span>
                    <span className="planned-num">00</span>
                    <span className="planned-unit">mins</span>
                  </div>
                  <p className="planned-label">Total hours (Weekly)</p>
                  <div className="planned-divider"></div>
                  <div className="planned-big" style={{marginTop: '12px'}}>
                    <span className="planned-num">8</span>
                    <span className="planned-unit">hrs</span>
                    <span className="planned-num">00</span>
                    <span className="planned-unit">mins</span>
                  </div>
                  <p className="planned-label">Total hours (Daily)</p>
                  <div className="planned-divider"></div>
                  <p className="planned-note">Each employee should complete their total daily and weekly planned hours.</p>
                </div>
              </div>

              {/* Card 3: Worked Hours */}
              <div className="main-card worked-card">
                <div className="card-header">
                  <ClockIcon width={17} height={17} className="card-icon" />
                  <span className="card-title">Worked Hours</span>
                </div>
                <div className="worked-hours-display">
                  <p className="worked-label">Total hours (Today)</p>
                  <div className="worked-big">
                    <span className="worked-num">{getTotalHoursToday().h}</span>
                    <span className="worked-unit">hrs</span>
                    <span className="worked-num">{String(getTotalHoursToday().m).padStart(2,'0')}</span>
                    <span className="worked-unit">mins</span>
                    <span className="worked-num">{String(getTotalHoursToday().s).padStart(2,'0')}</span>
                    <span className="worked-unit">secs</span>
                  </div>
                  <div className="planned-divider"></div>
                  <p className="worked-label">Sessions Today</p>
                  <div className="worked-sessions">
                    {getRecordsForPeriod('today').length + (isClockedIn ? 1 : 0)}
                  </div>
                  <div className="planned-divider"></div>
                  <p className="planned-note">Total time worked today, not including break time.</p>
                </div>
              </div>

            </div>
            {/* END Three Cards Row */}

            {/* Bottom Cards Row */}
            <div className="bottom-cards-row">

              {/* Holidays Card */}
              <div className="bottom-card">
                <h3 className="bottom-card-title">Upcoming holidays and time off</h3>
                {holidaysData.upcoming.length === 0 && holidaysData.taken.length === 0 ? (
                  <div className="holidays-empty">
                    <p>No upcoming holidays</p>
                  </div>
                ) : (
                  <div className="holidays-list">
                    {holidaysData.upcoming.map((item, i) => (
                      <div className="holiday-row" key={`u-${i}`}>
                        <div className="holiday-date">{formatDisplayDate(item.date)}</div>
                        <div className="holiday-info">
                          <span className="holiday-label">{item.label}</span>
                          <span className={`holiday-tag ${item.kind === 'holiday' ? 'holiday-tag-holiday' : `holiday-tag-${item.status}`}`}>
                            {item.kind === 'holiday' ? 'Public holiday' : item.status === 'approved' ? 'Approved' : 'Pending'}
                          </span>
                        </div>
                      </div>
                    ))}
                    {holidaysData.taken.length > 0 && (
                      <>
                        <p className="holidays-subheading">Recently taken</p>
                        {holidaysData.taken.map((item, i) => (
                          <div className="holiday-row" key={`t-${i}`}>
                            <div className="holiday-date">{formatDisplayDate(item.date)}</div>
                            <div className="holiday-info">
                              <span className="holiday-label">{item.label}</span>
                              <span className="holiday-tag holiday-tag-taken">Taken</span>
                            </div>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                )}
              </div>

              {/* Activities Card */}
              <div className="bottom-card">
                <div className="bottom-card-header-row">
                  <h3 className="bottom-card-title">Activities</h3>
                  <div className="activities-filter">
                    <select
                      value={activitiesFilter}
                      onChange={e => setActivitiesFilter(e.target.value)}
                      aria-label="Filter activities by period">
                      <option value="daily">Daily</option>
                      <option value="weekly">Weekly</option>
                      <option value="monthly">Monthly</option>
                    </select>
                    <ChevronDownIcon width={13} height={13} className="activities-filter-caret" />
                  </div>
                </div>
                <div className="activities-content">
                  <div className="donut-wrapper">
                    <PieChart width={180} height={180}>
                      <Pie
                        data={[
                          { name: 'Worked', value: activityStats.workedSeconds > 0 ? activityStats.workedSeconds : 1 },
                          { name: 'Remaining', value: activityStats.workedSeconds > 0 ? Math.max(activityStats.targetSeconds - activityStats.workedSeconds, 0) : activityStats.targetSeconds }
                        ]}
                        cx={85}
                        cy={85}
                        innerRadius={55}
                        outerRadius={80}
                        dataKey="value"
                        startAngle={90}
                        endAngle={-270}>
                        <Cell fill="#2563EB" stroke={isDarkMode ? '#1E293B' : '#FFFFFF'} />
                        <Cell fill={isDarkMode ? '#334155' : '#E2E8F0'} stroke={isDarkMode ? '#1E293B' : '#FFFFFF'} />
                      </Pie>
                      <Tooltip
                        formatter={(value) => {
                          const h = Math.floor(value / 3600);
                          const m = Math.floor((value % 3600) / 60);
                          return `${h}h ${m}m`;
                        }}
                      />
                    </PieChart>
                    <div className="donut-center">
                      <p className="donut-label">clocked</p>
                      <p className="donut-value">
                        {Math.floor(activityStats.workedSeconds / 3600)}h {Math.floor((activityStats.workedSeconds % 3600) / 60)}m
                      </p>
                    </div>
                  </div>
                  <div className="activities-legend">
                    <p className="activities-subtitle">{activityStats.label}</p>
                    <div className="legend-item">
                      <span className="legend-dot" style={{backgroundColor: '#2563EB'}}></span>
                      <span>Working time — {Math.floor(activityStats.workedSeconds / 3600)}h {Math.floor((activityStats.workedSeconds % 3600) / 60)}m</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-dot" style={{backgroundColor: '#B45309'}}></span>
                      <span>Break time — {Math.floor(activityStats.breakSecondsVal / 3600)}h {Math.floor((activityStats.breakSecondsVal % 3600) / 60)}m</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-dot" style={{backgroundColor: isDarkMode ? '#475569' : '#E2E8F0'}}></span>
                      <span>Remaining — {Math.floor(Math.max(activityStats.targetSeconds - activityStats.workedSeconds, 0) / 3600)}h {Math.floor((Math.max(activityStats.targetSeconds - activityStats.workedSeconds, 0) % 3600) / 60)}m</span>
                    </div>
                    <div className="legend-item">
                      <span className="legend-dot" style={{backgroundColor: '#15803D'}}></span>
                      <span>Sessions — {activityStats.sessions}</span>
                    </div>
                  </div>
                </div>
              </div>

            </div>
            {/* END Bottom Cards Row */}

          </div>
        )}
        {/* ===== END DASHBOARD PAGE ===== */}

        {/* ===== TIMESHEET PAGE ===== */}
        {activePage === 'timesheet' && (
          <div className="page">
            <div className="page-header">
              <h1>Timesheet</h1>
              <p className="page-date">{getCurrentDate()}</p>
            </div>

            <div className="timesheet-controls">
              <div className="timesheet-view-toggle">
                {['daily', 'weekly', 'monthly', 'all'].map(mode => (
                  <button
                    key={mode}
                    className={`timesheet-view-btn ${timesheetViewMode === mode ? 'active' : ''}`}
                    onClick={() => selectTimesheetMode(mode)}>
                    {mode === 'daily' ? 'Daily' : mode === 'weekly' ? 'Weekly' : mode === 'monthly' ? 'Monthly' : 'All Records'}
                  </button>
                ))}
              </div>

              {timesheetViewMode !== 'all' && (
                <div className="timesheet-month-nav">
                  <button className="timesheet-month-btn" onClick={() => shiftTimesheetPeriod(-1)} aria-label="Previous period">‹</button>
                  <span className="timesheet-month-label">{getTimesheetPeriodLabel()}</span>
                  <button className="timesheet-month-btn" onClick={() => shiftTimesheetPeriod(1)} aria-label="Next period">›</button>
                </div>
              )}
            </div>

            {timesheetViewMode !== 'all' && (
              <div className="timesheet-period-total">
                <span>Total: <strong>{formatTime(getTimesheetPeriodTotal())}</strong></span>
              </div>
            )}

            {timesheetViewMode === 'monthly' && (
              <div className="timesheet-calendar-card">
                <div className="timesheet-calendar-weekdays">
                  {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map(d => (
                    <span key={d}>{d}</span>
                  ))}
                </div>
                <div className="timesheet-calendar-grid">
                  {buildMonthCells(timesheetMonthDate).map((day, i) => {
                    if (!day) return <div key={`blank-${i}`} className="timesheet-day-cell empty" />;
                    const dayRecs = getRecordsForDay(day);
                    const totalSecs = sumRecordsSeconds(dayRecs);
                    const isSelected = isSameCalendarDay(day, timesheetSelectedDate);
                    const isToday = isSameCalendarDay(day, new Date());

                    return (
                      <button
                        key={day.toISOString()}
                        className={`timesheet-day-cell ${dayRecs.length ? 'has-records' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`}
                        onClick={() => selectTimesheetDay(day)}>
                        <span className="timesheet-day-number">{day.getDate()}</span>
                        {dayRecs.length > 0 && (
                          <span className="timesheet-day-hours">{formatTime(totalSecs).slice(0, 5)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {timesheetViewMode === 'weekly' && (() => {
              const [weekStart] = getCalendarWeekRange(getActiveTimesheetDate());
              const weekDays = Array.from({ length: 7 }, (_, i) => {
                const d = new Date(weekStart);
                d.setDate(weekStart.getDate() + i);
                return d;
              });
              return (
                <div className="timesheet-week-card">
                  {weekDays.map(day => {
                    const dayRecs = getRecordsForDay(day);
                    const totalSecs = sumRecordsSeconds(dayRecs);
                    const isSelected = isSameCalendarDay(day, timesheetSelectedDate);
                    const isToday = isSameCalendarDay(day, new Date());

                    return (
                      <button
                        key={day.toISOString()}
                        className={`timesheet-week-cell ${dayRecs.length ? 'has-records' : ''} ${isSelected ? 'selected' : ''} ${isToday ? 'today' : ''}`}
                        onClick={() => selectTimesheetDay(day)}>
                        <span className="timesheet-week-dayname">{day.toLocaleDateString('en-GB', { weekday: 'short' })}</span>
                        <span className="timesheet-week-daynum">{day.getDate()}</span>
                        {dayRecs.length > 0 && (
                          <span className="timesheet-day-hours">{formatTime(totalSecs).slice(0, 5)}</span>
                        )}
                      </button>
                    );
                  })}
                </div>
              );
            })()}

            {timesheetViewMode !== 'all' && (timesheetViewMode !== 'monthly' || timesheetSelectedDate) && (() => {
              const activeDay = getActiveTimesheetDate();
              const dayRecs = [...getRecordsForDay(activeDay)]
                .sort((a, b) => (parseClockTime(a.clock_in) ?? 0) - (parseClockTime(b.clock_in) ?? 0));
              const showLive = isClockedIn && isSameCalendarDay(activeDay, new Date());
              const workedTotal = sumRecordsSeconds(dayRecs) + (showLive ? seconds : 0);
              const breakTotal = dayRecs.filter(isCounted).reduce((sum, r) => sum + hmsToSeconds(r.break_time), 0)
                + (showLive ? getLiveBreakSeconds() : 0);
              const sessionCount = dayRecs.length + (showLive ? 1 : 0);

              return (
                <div className="timesheet-day-detail" ref={dayDetailRef}>
                  <h3>
                    {activeDay.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
                  </h3>
                  {sessionCount === 0 ? (
                    <p className="timesheet-day-empty">No session recorded this day.</p>
                  ) : (
                    <>
                      <div className="day-summary">
                        <div className="day-summary-item">
                          <span className="timesheet-field-label">Worked</span>
                          <strong>{formatDuration(workedTotal)}</strong>
                        </div>
                        <div className="day-summary-item">
                          <span className="timesheet-field-label">Breaks</span>
                          <strong>{formatDuration(breakTotal)}</strong>
                        </div>
                        <div className="day-summary-item">
                          <span className="timesheet-field-label">Sessions</span>
                          <strong>{sessionCount}</strong>
                        </div>
                      </div>

                      {dayRecs.map((record, i) => (
                        <div className="day-session" key={record.id || i}>
                          <div className="day-session-head">
                            <span className="day-session-title">Session {i + 1}</span>
                            <span className={`location-tag location-tag-${record.location_status || 'unavailable'}`}>
                              {locationLabel(record.location_status)}
                            </span>
                          </div>
                          <SessionTimeline session={recordToSession(record)} />
                        </div>
                      ))}

                      {showLive && (
                        <div className="day-session">
                          <div className="day-session-head">
                            <span className="day-session-title">
                              Session {dayRecs.length + 1} {'\u00b7'} {isOnBreak ? 'On break' : 'In progress'}
                            </span>
                            <span className={`location-tag location-tag-${locationStatus || 'unavailable'}`}>
                              {locationLabel(locationStatus)}
                            </span>
                          </div>
                          <SessionTimeline session={liveSession()} />
                        </div>
                      )}
                    </>
                  )}
                </div>
              );
            })()}

            {timesheetViewMode === 'all' && (
              filteredRecords().length === 0 ? (
                <div className="empty-state">
                  <p>No sessions recorded yet.</p>
                  <p>Clock in to start tracking your time.</p>
                </div>
              ) : (
                <div className="table-card">
                  <table className="timesheet-table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Clock In</th>
                        <th>Clock Out</th>
                        <th>Break Time</th>
                        <th>Hours Worked</th>
                        <th>Location</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredRecords().map((record, index) => (
                        <tr key={index}>
                          <td>{record.date}</td>
                          <td>{formatClock(record.clock_in)}</td>
                          <td>{formatClock(record.clock_out)}</td>
                          <td className="cell-warning">{record.break_time}</td>
                          <td className="cell-success">{record.hours_worked}</td>
                          <td>
                            <span className={`location-tag location-tag-${record.location_status || 'unavailable'}`}>
                              {locationLabel(record.location_status)}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            )}
          </div>
        )}

        {/* ===== TIME OFF PAGE ===== */}
        {activePage === 'timeoff' && (() => {
          const summary = getTimeOffSummary();
          const groups = getGroupedTimeOff();
          const requestedDays = timeOffStart && timeOffEnd && timeOffEnd >= timeOffStart
            ? countWorkingDays(timeOffStart, timeOffEnd)
            : null;

          const renderRequest = req => {
            const todayIso = toIsoDate(new Date());
            const days = countWorkingDays(req.start_date, req.end_date || req.start_date);
            const taken = req.status === 'approved' && (req.end_date || req.start_date) < todayIso;
            const tag = req.status === 'pending' ? 'pending' : req.status === 'rejected' ? 'rejected' : taken ? 'taken' : 'approved';
            const tagLabel = { pending: 'Pending', rejected: 'Rejected', taken: 'Taken', approved: 'Approved' }[tag];
            return (
              <div className="to-req" key={req.id}>
                <div className="to-req-main">
                  <span className="to-req-type">{req.type}</span>
                  <span className="to-req-meta">{formatDateRange(req.start_date, req.end_date)} {'\u00b7'} {days} day{days === 1 ? '' : 's'}</span>
                  {req.reason && <span className="to-req-reason">{req.reason}</span>}
                </div>
                <div className="to-req-side">
                  <span className={`holiday-tag holiday-tag-${tag}`}>{tagLabel}</span>
                  {req.status === 'pending' && (
                    <button
                      className="timeoff-cancel-btn"
                      disabled={cancellingId === req.id}
                      onClick={() => handleCancelTimeOff(req.id)}>
                      {cancellingId === req.id ? 'Cancelling...' : 'Cancel'}
                    </button>
                  )}
                </div>
                {req.admin_message && (
                  <p className="to-req-reply"><span>Admin:</span> {req.admin_message}</p>
                )}
              </div>
            );
          };

          return (
            <div className="page">
              <div className="page-header">
                <div>
                  <h1>Time Off</h1>
                  <p className="page-date">Request leave and track your requests</p>
                </div>
              </div>

              <div className="to-summary">
                <div className="to-summary-item">
                  <span className="timesheet-field-label">Pending</span>
                  <strong>{summary.pending} request{summary.pending === 1 ? '' : 's'}</strong>
                </div>
                <div className="to-summary-item">
                  <span className="timesheet-field-label">Taken this year</span>
                  <strong>{summary.takenDays} day{summary.takenDays === 1 ? '' : 's'}</strong>
                </div>
                <div className="to-summary-item">
                  <span className="timesheet-field-label">Next time off</span>
                  <strong>{summary.nextLabel}</strong>
                </div>
              </div>

              <div className="timeoff-layout">
                <div className="timeoff-form-card">
                  <div className="to-form-head">
                    <h3>Request time off</h3>
                    <button type="button" className="to-describe-toggle" onClick={() => setShowQuickFill(prev => !prev)}>
                      {showQuickFill ? 'Fill in the form instead' : 'Describe it instead'}
                    </button>
                  </div>

                  {showQuickFill && (
                    <div className="to-describe">
                      <input
                        type="text"
                        placeholder="Next Friday off for a doctor's appointment"
                        value={quickTimeOffText}
                        onChange={e => setQuickTimeOffText(e.target.value)}
                      />
                      <button
                        type="button"
                        className="btn-secondary"
                        onClick={handleQuickFillTimeOff}
                        disabled={quickFillLoading || !quickTimeOffText.trim()}>
                        {quickFillLoading ? 'Reading...' : 'Fill form'}
                      </button>
                      {quickFillError && <p className="to-describe-error">{quickFillError}</p>}
                    </div>
                  )}

                  {timeOffError && <p className="form-alert">{timeOffError}</p>}
                  {timeOffSuccess && <p className="form-success">{timeOffSuccess}</p>}

                  <div className="input-group">
                    <label>Type</label>
                    <select
                      value={timeOffType}
                      onChange={e => { setTimeOffType(e.target.value); setTimeOffError(''); }}>
                      <option value="">Select a type</option>
                      {TIME_OFF_TYPES.map(t => (
                        <option key={t} value={t}>{t}</option>
                      ))}
                    </select>
                  </div>

                  <div className="timeoff-dates-row">
                    <div className="input-group">
                      <label>From</label>
                      <input
                        type="date"
                        value={timeOffStart}
                        min={toIsoDate(new Date())}
                        onChange={e => {
                          setTimeOffStart(e.target.value);
                          setTimeOffError('');
                          if (!timeOffEnd || timeOffEnd < e.target.value) setTimeOffEnd(e.target.value);
                        }}
                      />
                    </div>
                    <div className="input-group">
                      <label>To</label>
                      <input
                        type="date"
                        value={timeOffEnd}
                        min={timeOffStart || toIsoDate(new Date())}
                        onChange={e => { setTimeOffEnd(e.target.value); setTimeOffError(''); }}
                      />
                    </div>
                  </div>

                  {requestedDays !== null && (
                    <p className={`to-day-count ${requestedDays === 0 ? 'is-zero' : ''}`}>
                      {requestedDays === 0 ? 'No working days in these dates (weekend or public holiday)' : dayLabel(requestedDays)}
                    </p>
                  )}

                  <div className="input-group">
                    <label>Reason (optional)</label>
                    <textarea
                      rows={2}
                      placeholder="Anything your manager should know"
                      value={timeOffReason}
                      onChange={e => setTimeOffReason(e.target.value)}
                    />
                  </div>

                  <button
                    className="btn-primary"
                    onClick={handleTimeOffSubmit}
                    disabled={timeOffSubmitting}>
                    {timeOffSubmitting ? 'Submitting...' : 'Submit request'}
                  </button>
                </div>

                <div className="timeoff-history-card">
                  <div className="timeoff-history-header">
                    <h3>Your requests</h3>
                    <button
                      type="button"
                      className={`timeoff-refresh-btn ${timeOffRefreshState === 'refreshing' ? 'is-refreshing' : ''}`}
                      onClick={handleTimeOffRefresh}
                      disabled={timeOffRefreshState === 'refreshing'}
                      title="Check for updates">
                      {timeOffRefreshState === 'done'
                        ? <CheckCircleIcon width={14} height={14} />
                        : <RefreshIcon width={14} height={14} />}
                      {timeOffRefreshState === 'refreshing' ? 'Refreshing...' : timeOffRefreshState === 'done' ? 'Updated' : 'Refresh'}
                    </button>
                  </div>

                  {timeOffRequests.length === 0 ? (
                    <div className="empty-state">
                      <p>No time off requested yet.</p>
                    </div>
                  ) : (
                    <>
                      {groups.pending.length > 0 && (
                        <div className="to-group">
                          <span className="to-group-title">Pending</span>
                          {groups.pending.map(renderRequest)}
                        </div>
                      )}
                      {groups.upcoming.length > 0 && (
                        <div className="to-group">
                          <span className="to-group-title">Upcoming</span>
                          {groups.upcoming.map(renderRequest)}
                        </div>
                      )}
                      {groups.history.length > 0 && (
                        <div className="to-group">
                          <span className="to-group-title">History</span>
                          {groups.history.map(renderRequest)}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })()}

        {/* ===== REMINDERS PAGE ===== */}
        {activePage === 'reminders' && (
          <div className="page">
            <div className="page-header">
              <h1>Smart Reminders</h1>
              <p className="page-date">Your automated reminder settings</p>
            </div>
            <div className="reminders-list">
              <div className="reminder-item">
                <div className="reminder-icon"><ClockIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>Break Reminder</h3>
                  <p>You will be reminded to take a break after 3 hours of work</p>
                </div>
                <div className="reminder-badge active">Active</div>
              </div>
              <div className="reminder-item">
                <div className="reminder-icon"><BellIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>Clock Out Reminder</h3>
                  <p>You will be reminded to clock out after 8 hours of work</p>
                </div>
                <div className="reminder-badge active">Active</div>
              </div>
              <div className="reminder-item">
                <div className="reminder-icon"><CoffeeIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>Auto Clock Out</h3>
                  <p>You will be automatically clocked out after 8 hours 15 minutes</p>
                </div>
                <div className="reminder-badge active">Active</div>
              </div>
            </div>

            <h2 className="reminders-subheading">Optional reminders</h2>
            <p className="page-date reminders-subnote">Switch these on or off to suit how you like to work</p>
            <div className="reminders-list">
              <div className="reminder-item">
                <div className="reminder-icon"><BellIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>Desktop Notifications</h3>
                  <p>
                    {!pushSupported && 'This browser doesn\u2019t support desktop notifications.'}
                    {pushSupported && pushPermission === 'denied' && 'Blocked in this browser\u2019s settings for this site.'}
                    {pushSupported && pushPermission !== 'denied' && 'Get these reminders on this device, even with the tab closed'}
                  </p>
                  {pushError && <p style={{ color: '#e5484d' }}>{pushError}</p>}
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={pushEnabled}
                    disabled={!pushSupported || pushPermission === 'denied' || pushLoading}
                    onChange={() => (pushEnabled ? handleDisableDesktopPush() : handleEnableDesktopPush())}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              <div className="reminder-item">
                <div className="reminder-icon"><CalendarIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>Weekly Summary Email</h3>
                  <p>Get a weekly email summarising your hours, breaks and time off</p>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={optionalReminders.weeklySummary}
                    onChange={() => toggleOptionalReminder('weeklySummary')}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>

              {optionalReminders.weeklySummary && (
                <div className="ai-summary-preview">
                  <div className="ai-summary-preview-header">
                    <p>Automated weekly emails need a scheduled job on the backend, which isn't set up yet — in the meantime, generate a preview any time:</p>
                    <button className="btn-secondary" onClick={handleGenerateWeeklySummary} disabled={weeklySummaryLoading}>
                      {weeklySummaryLoading ? 'Writing...' : 'Preview this week\u2019s summary'}
                    </button>
                  </div>
                  {weeklySummaryText && <p className="ai-summary-text">{weeklySummaryText}</p>}
                </div>
              )}
              <div className="reminder-item">
                <div className="reminder-icon"><AlertIcon width={18} height={18} /></div>
                <div className="reminder-info">
                  <h3>Missed Clock-In Reminder</h3>
                  <p>Get a nudge if you haven't clocked in by your usual start time</p>
                </div>
                <label className="toggle-switch">
                  <input
                    type="checkbox"
                    checked={optionalReminders.missedClockIn}
                    onChange={() => toggleOptionalReminder('missedClockIn')}
                  />
                  <span className="toggle-slider"></span>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* ===== FAQ PAGE ===== */}
        {activePage === 'faq' && (
          <div className="page">
            <div className="page-header">
              <div>
                <h1>FAQ</h1>
                <p className="page-date">Quick answers to common questions</p>
              </div>
            </div>

            <div className="faq-list">
              {EMPLOYEE_FAQ_ITEMS.map((item, i) => (
                <div className="faq-item" key={i}>
                  <button
                    className="faq-question"
                    onClick={() => setOpenFaqIndex(openFaqIndex === i ? null : i)}>
                    {item.q}
                    <span className="faq-toggle">{openFaqIndex === i ? '−' : '+'}</span>
                  </button>
                  {openFaqIndex === i && (
                    <p className="faq-answer">{item.a}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===== PROFILE PAGE ===== */}
        {activePage === 'profile' && (
          <Profile
            user={user}
            profile={profile}
            onProfileUpdate={loadProfile}
            onBack={() => setActivePage('dashboard')}
            isDarkMode={isDarkMode}
            avatarUrl={avatarUrl}
            onAvatarChange={setAvatarUrl}
          />
        )}

      </div>

      <AIChatWidget context={buildChatContext()} />
    </div>
  );
}

export default Dashboard;

// Desktop app installers (Google Drive, shared "anyone with the link").
// New version: upload the new files, put their links here.
const driveDownload = id => `https://drive.google.com/uc?export=download&id=${id}`;

export const DESKTOP_VERSION = '1.0.1';
export const DESKTOP_DOWNLOADS = {
  windows: { label: 'Download for Windows', url: driveDownload('17GqYswksm3hdqOoP8-w1o7Q6Sp-slEOW') },
  mac: { label: 'Download for Mac', url: driveDownload('1NA9mImCebMOVh-uQw4eRobT91bf_kuKW') }
};

// the laptop this page is open on, so its button comes first
export function thisComputer() {
  const ua = typeof navigator !== 'undefined' ? `${navigator.userAgent} ${navigator.platform}` : '';
  if (/Mac/i.test(ua)) return 'mac';
  if (/Win/i.test(ua)) return 'windows';
  return null;
}

import { useEffect, useRef, useState } from 'react';
import { loadFaceApi, openCamera, stopCamera, readFrame, snapshot, toPlainArray } from '../lib/face';
import { faceMatches, faceRegisteredToOther } from '../lib/security';
import { XIcon } from '../icons';
import './FaceCheck.css';

// Camera check used for registering a face, clocking in and presence checks.
//   mode 'register'  3 good frames, averaged, duplicate check (blink asked for
//                    but not required: the admin checks the photo)
//   mode 'clockin'   eyes close + open, one frame, up to 3 tries. Face seen but not
//                    matching after 3: "Continue" (goes to Review). No face seen: no way past.
//   mode 'resume'    same as clockin, back from a pause after a missed presence check
//   mode 'presence'  same, "send anyway" after 3 tries
// onDone({ descriptor, blink, attempts, photoBlob, noFace, matched, error })

const MAX_TRIES = 3;
const BLINK_WAIT_MS = 10000;
const STEADY_MS = 1500;       // facing the camera this long before the eyes step
const SAMPLE_GAP_MS = 400;    // registration samples spread out a little
const NO_FACE_GIVE_UP_MS = 25000;

function averageDescriptors(list) {
  const out = new Array(128).fill(0);
  list.forEach(d => d.forEach((n, i) => { out[i] += n / list.length; }));
  return out;
}

function distance(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

function FaceCheck({ mode = 'clockin', title, onDone, onCancel }) {
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const faceapiRef = useRef(null);
  const cancelledRef = useRef(false);
  const [phase, setPhase] = useState('starting');      // starting | looking | checking | retry | failed | error | done
  const [hint, setHint] = useState('Getting the camera ready…');
  const [attempts, setAttempts] = useState(0);
  const [errorText, setErrorText] = useState('');
  const lastRef = useRef(null);                         // last result, for "clock in anyway"
  const [previewUrl, setPreviewUrl] = useState(null);
  const [debug, setDebug] = useState('');               // localhost only: eye numbers while testing

  useEffect(() => {
    cancelledRef.current = false;
    (async () => {
      try {
        const [stream, faceapi] = await Promise.all([openCamera(), loadFaceApi()]);
        if (cancelledRef.current) { stopCamera(stream); return; }
        streamRef.current = stream;
        faceapiRef.current = faceapi;
        const video = videoRef.current;
        video.srcObject = stream;
        await video.play();
        runAttempt(1);
      } catch (err) {
        if (cancelledRef.current) return;
        setPhase('error');
        setErrorText(err?.message || 'The camera check couldn’t start.');
      }
    })();
    return () => {
      cancelledRef.current = true;
      stopCamera(streamRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const wait = ms => new Promise(r => setTimeout(r, ms));

  async function runAttempt(tryNumber) {
    setAttempts(tryNumber);
    setPhase('looking');
    setHint('Look straight at the camera.');
    const faceapi = faceapiRef.current;
    const video = videoRef.current;
    const started = Date.now();
    // 1. face the camera, still, for a moment (also gives how open the eyes are)
    // 2. close the eyes for a second and open them (slow on purpose: a quick
    //    blink can fall between frames on a slow laptop)
    // 3. face the camera again; samples + photo only from frames that face it
    const openReadings = [];
    const contrastReadings = [];
    let steadySince = null;
    let baseline = 0;
    let baseContrast = 0;
    let closedSeen = false;
    let blink = false;
    let sawFace = false;
    let blinkStarted = null;
    let photoBlob = null;
    let lastSampleAt = 0;
    const samples = [];
    const needSamples = mode === 'register' ? 3 : 1;

    while (!cancelledRef.current) {
      const elapsed = Date.now() - started;
      const watchingEyes = !!baseline && !blink && Date.now() - blinkStarted <= BLINK_WAIT_MS;
      const frame = await readFrame(faceapi, video, false, watchingEyes ? 224 : 320, watchingEyes);
      if (cancelledRef.current) return;

      if (!frame.ok) {
        // eyes shut can make the face harder to read; keep going mid-blink
        if (!closedSeen || blink) setHint(frame.problem);
        if (!baseline) { openReadings.length = 0; contrastReadings.length = 0; steadySince = null; }
        if (!sawFace && elapsed > NO_FACE_GIVE_UP_MS) {
          // clocking in / coming back can't go on without a face
          if (mode === 'clockin' || mode === 'resume') {
            return retry(tryNumber, 'No face was seen. Make sure the camera is on and you’re facing it in good light.', null);
          }
          return finish({ noFace: true, attempts: tryNumber, blink: false });
        }
        await wait(60);
        continue;
      }
      sawFace = true;

      // 1. steady and facing the camera
      if (!baseline) {
        if (!steadySince) steadySince = Date.now();
        openReadings.push(frame.ratio);
        contrastReadings.push(frame.contrast);
        if (openReadings.length >= 4 && Date.now() - steadySince >= STEADY_MS) {
          const middle = list => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];
          baseline = middle(openReadings);
          baseContrast = middle(contrastReadings);
          blinkStarted = Date.now();
          setHint('Close your eyes for a second, then open them.');
        } else {
          setHint('Good. Hold still…');
        }
        await wait(60);
        continue;
      }

      // 2. eyes close and open
      const waited = Date.now() - blinkStarted;
      if (!blink && waited <= BLINK_WAIT_MS) {
        // shut: eye points close up, or the eye area goes flat (no white/iris)
        const shut = frame.ratio < baseline * 0.8 || frame.ratio < 0.19 || frame.contrast < baseContrast * 0.65;
        const open = frame.ratio > baseline * 0.88 && frame.contrast > baseContrast * 0.8;
        if (process.env.NODE_ENV === 'development') {
          setDebug(`eyes ${(frame.ratio / baseline).toFixed(2)} · contrast ${(frame.contrast / baseContrast).toFixed(2)}`);
        }
        if (!closedSeen && shut) closedSeen = true;
        if (closedSeen && open) blink = true;
        setHint(blink ? 'Look straight at the camera…' : closedSeen ? 'Now open your eyes.' : 'Close your eyes for a second, then open them.');
        await wait(40);
        continue;
      }

      // 3. eyes open, facing the camera: samples a moment apart, photo with the first
      setHint(mode === 'register' ? 'Look straight at the camera and hold still…' : 'Look straight at the camera…');
      if (frame.ratio > baseline * 0.85 && Date.now() - lastSampleAt >= SAMPLE_GAP_MS) {
        const full = await readFrame(faceapi, video, true);
        if (full.ok) {
          if (!photoBlob) photoBlob = await snapshot(video);
          samples.push(toPlainArray(full.detection.descriptor));
          lastSampleAt = Date.now();
          if (samples.length >= needSamples) break;
        } else {
          setHint(full.problem);
        }
      }
      await wait(60);
    }
    if (cancelledRef.current) return;

    setPhase('checking');

    if (mode === 'register') {
      // the three samples should agree, or the picture wasn't steady enough
      const descriptor = averageDescriptors(samples);
      const spread = Math.max(...samples.map(s => distance(s, descriptor)));
      if (spread > 0.35) return retry(tryNumber, 'The picture wasn’t steady enough. Hold still and try again.', { descriptor, photoBlob });
      try {
        const other = await faceRegisteredToOther(descriptor);
        if (other) {
          setPhase('failed');
          setErrorText(`This face is already registered to another account (${other}). Each person can only register their own face. Speak to your admin if this is wrong.`);
          return;
        }
      } catch {
        // check unavailable, the admin still approves the face
      }
      // show the photo first: retake if it's not a clear, straight-on picture
      lastRef.current = { descriptor, photoBlob, blink, attempts: tryNumber };
      setPreviewUrl(URL.createObjectURL(photoBlob));
      setPhase('preview');
      return;
    }

    const descriptor = samples[0];
    let matched = false;
    try {
      matched = await faceMatches(descriptor);
    } catch {
      matched = false;
    }
    const result = { descriptor, photoBlob, blink, attempts: tryNumber, matched };
    if (matched && blink) return finish(result);
    if (matched && !blink) return retry(tryNumber, 'Your eyes weren’t seen closing. Close them for a second, then open them.', result);
    return retry(tryNumber, 'That didn’t look like the face registered to this account. Take off any cap, hat or sunglasses, face the light and try again.', result);
  }

  function retry(tryNumber, text, result) {
    // a try with no face doesn't wipe a face seen on an earlier try
    if (result) lastRef.current = result;
    setErrorText(text);
    setPhase(tryNumber >= MAX_TRIES && mode !== 'register' ? 'failed' : 'retry');
  }

  function finish(result) {
    if (cancelledRef.current) return;
    setPhase('done');
    stopCamera(streamRef.current);
    onDone(result);
  }

  function handleCancel() {
    cancelledRef.current = true;
    stopCamera(streamRef.current);
    onCancel();
  }

  function goAnyway() {
    const last = lastRef.current || { noFace: true, blink: false };
    finish({ ...last, attempts, error: errorText });
  }

  // clocking in / coming back: a face has to have been seen to carry on
  const strict = mode === 'clockin' || mode === 'resume';
  const canGoOn = !strict || !!lastRef.current?.descriptor;
  const anywayLabel = mode === 'presence' ? 'Send anyway' : 'Continue';
  const heading = title || (mode === 'register' ? 'Set up your face check' : mode === 'presence' ? 'Presence check' : 'Face check');

  return (
    <div className="popup-overlay">
      <div className="popup-box face-check-box" role="dialog" aria-label={heading}>
        <div className="face-check-head">
          <h3>{heading}</h3>
          <button className="face-check-close" onClick={handleCancel} aria-label="Cancel">
            <XIcon width={16} height={16} />
          </button>
        </div>

        <div className={`face-check-video ${phase === 'looking' ? 'is-looking' : ''}`} hidden={phase === 'preview'}>
          <video ref={videoRef} playsInline muted />
          <div className="face-check-oval" />
          {phase === 'starting' && <div className="face-check-cover">Getting the camera ready…</div>}
          {phase === 'error' && <div className="face-check-cover">Camera unavailable</div>}
        </div>

        {(phase === 'looking' || phase === 'starting' || phase === 'checking') && (
          <p className="face-check-hint">{phase === 'checking' ? 'Checking…' : hint}</p>
        )}
        {debug && phase === 'looking' && <p className="face-check-sub">{debug}</p>}
        {mode !== 'register' && phase === 'looking' && attempts > 1 && (
          <p className="face-check-sub">Try {attempts} of {MAX_TRIES}</p>
        )}

        {phase === 'preview' && previewUrl && (
          <>
            <img className="face-check-preview" src={previewUrl} alt="Your face, as your admin will see it" />
            <p className="face-check-sub">Your admin sees this photo. It should be you alone, facing the camera, in good light.</p>
            <div className="popup-buttons">
              <button className="popup-cancel" onClick={() => { setPreviewUrl(null); runAttempt(attempts + 1); }}>Retake</button>
              <button className="popup-confirm" onClick={() => finish(lastRef.current)}>Use this photo</button>
            </div>
          </>
        )}

        {phase === 'retry' && (
          <>
            <p className="face-check-error">{errorText}</p>
            <div className="popup-buttons">
              <button className="popup-cancel" onClick={handleCancel}>Cancel</button>
              <button className="popup-confirm" onClick={() => runAttempt(attempts + 1)}>Try again</button>
            </div>
          </>
        )}

        {phase === 'failed' && (
          <>
            <p className="face-check-error">{errorText}</p>
            {mode !== 'register' && canGoOn && (
              <p className="face-check-sub">You can still carry on. Your admin will be asked to look at the photos.</p>
            )}
            {strict && !canGoOn && (
              <p className="face-check-sub">The face check is needed to {mode === 'resume' ? 'carry on' : 'clock in'}. Turn the camera on, face it in good light and try again.</p>
            )}
            <div className="popup-buttons">
              <button className="popup-cancel" onClick={handleCancel}>{strict && !canGoOn ? 'Close' : 'Cancel'}</button>
              {mode !== 'register' && canGoOn && <button className="popup-confirm" onClick={goAnyway}>{anywayLabel}</button>}
            </div>
          </>
        )}

        {phase === 'error' && (
          <>
            <p className="face-check-error">{errorText}</p>
            {mode === 'presence' && (
              <p className="face-check-sub">You can still carry on. Your admin will be asked to look at it.</p>
            )}
            {strict && (
              <p className="face-check-sub">The face check is needed to {mode === 'resume' ? 'carry on' : 'clock in'}.</p>
            )}
            <div className="popup-buttons">
              <button className="popup-cancel" onClick={handleCancel}>{strict ? 'Close' : 'Cancel'}</button>
              {mode === 'presence' && (
                <button className="popup-confirm" onClick={() => finish({ noFace: true, blink: false, attempts: 0, error: errorText })}>
                  {anywayLabel}
                </button>
              )}
            </div>
          </>
        )}

        {mode === 'register' && phase === 'looking' && (
          <p className="face-check-sub">No cap, hat, sunglasses or mask. Clear glasses are fine. Face a light.</p>
        )}
      </div>
    </div>
  );
}

export default FaceCheck;

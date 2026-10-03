// Face check helpers. face-api (with TensorFlow inside it) is in
// public/vendor and only loaded when a camera check opens, so the dashboard
// doesn't get heavier. (Bundling it breaks the build: it uses require() in a
// way webpack can't follow.)
// Models are in public/models: tiny face detector, 68-point landmarks and the
// recognition model that turns a face into 128 numbers.

let faceapiPromise = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.faceapi) return resolve();
    const tag = document.createElement('script');
    tag.src = src;
    tag.async = true;
    tag.onload = () => resolve();
    tag.onerror = () => reject(new Error('The face check couldn’t load. Check your connection and try again.'));
    document.head.appendChild(tag);
  });
}

export function loadFaceApi() {
  if (!faceapiPromise) {
    faceapiPromise = (async () => {
      const root = process.env.PUBLIC_URL || '';
      await loadScript(`${root}/vendor/face-api.js`);
      const faceapi = window.faceapi;
      // WebGL on any normal laptop; plain CPU if the graphics can't be used
      // (slower but works). The WASM option needs extra files, so it's skipped.
      const tf = faceapi.tf;
      let ready = false;
      for (const backend of ['webgl', 'cpu']) {
        try {
          if (await tf.setBackend(backend)) {
            await tf.ready();
            ready = true;
            break;
          }
        } catch {
          // try the next one
        }
      }
      if (!ready) throw new Error('The face check can’t run in this browser.');
      const base = `${root}/models`;
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(base),
        faceapi.nets.faceLandmark68Net.loadFromUri(base),
        faceapi.nets.faceRecognitionNet.loadFromUri(base)
      ]);
      return faceapi;
    })().catch(err => {
      faceapiPromise = null;
      throw err;
    });
  }
  return faceapiPromise;
}

export async function openCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('This browser can’t use the camera.');
  }
  try {
    return await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: 'user' },
      audio: false
    });
  } catch (err) {
    if (err?.name === 'NotAllowedError') throw new Error('Camera access is blocked. Allow the camera for this site and try again.');
    if (err?.name === 'NotFoundError') throw new Error('No camera found on this computer.');
    throw new Error('The camera couldn’t be started. Close other apps using it and try again.');
  }
}

export function stopCamera(stream) {
  stream?.getTracks().forEach(t => t.stop());
}

// eye aspect ratio: drops sharply when the eye closes
function eyeRatio(eye) {
  const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  return (d(eye[1], eye[5]) + d(eye[2], eye[4])) / (2 * d(eye[0], eye[3]));
}

export function eyesOpenRatio(landmarks) {
  return (eyeRatio(landmarks.getLeftEye()) + eyeRatio(landmarks.getRightEye())) / 2;
}

// Light/dark spread inside both eyes. Open: white of the eye + dark iris, so
// a big spread. Shut: just eyelid skin, flat. Works where the eye points
// barely move when the eyes close.
const eyeCanvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
export function eyeContrast(video, landmarks) {
  if (!eyeCanvas) return 0;
  eyeCanvas.width = 32;
  eyeCanvas.height = 16;
  const ctx = eyeCanvas.getContext('2d', { willReadFrequently: true });
  let total = 0;
  for (const eye of [landmarks.getLeftEye(), landmarks.getRightEye()]) {
    const xs = eye.map(p => p.x);
    const ys = eye.map(p => p.y);
    const w = Math.max(...xs) - Math.min(...xs);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2;
    const cy = (Math.max(...ys) + Math.min(...ys)) / 2;
    // fixed shape from the eye width, so a shut eye is cropped the same as an open one
    const cw = w * 1.1;
    const ch = w * 0.55;
    ctx.drawImage(video, cx - cw / 2, cy - ch / 2, cw, ch, 0, 0, 32, 16);
    const { data } = ctx.getImageData(0, 0, 32, 16);
    const vals = [];
    for (let i = 0; i < data.length; i += 4) vals.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    const mean = vals.reduce((a, v) => a + v, 0) / vals.length;
    total += Math.sqrt(vals.reduce((a, v) => a + (v - mean) ** 2, 0) / vals.length);
  }
  return total / 2;
}

// average brightness of the face area, 0-255
function brightness(video, box) {
  const c = document.createElement('canvas');
  c.width = 40;
  c.height = 40;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(video, box.x, box.y, box.width, box.height, 0, 0, 40, 40);
  const { data } = ctx.getImageData(0, 0, 40, 40);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  return sum / (data.length / 4);
}

// Facing the camera? From the 68 points: nose half-way between the sides of
// the jaw (not turned), eyes level (not tilted), nose not too close to the
// eyes or the chin (not looking up or down).
export function facingProblem(landmarks) {
  const jaw = landmarks.getJawOutline();
  const nose = landmarks.getNose()[3];
  const eyeL = landmarks.getLeftEye();
  const eyeR = landmarks.getRightEye();
  const mid = pts => ({ x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length });
  const l = mid(eyeL);
  const r = mid(eyeR);

  const toLeft = nose.x - jaw[0].x;
  const toRight = jaw[16].x - nose.x;
  if (toLeft <= 0 || toRight <= 0 || Math.min(toLeft, toRight) / Math.max(toLeft, toRight) < 0.72) {
    return 'Turn your face straight towards the camera.';
  }
  const tilt = Math.abs(Math.atan2(r.y - l.y, r.x - l.x) * 180 / Math.PI);
  if (tilt > 12) return 'Keep your head level.';
  const eyesY = (l.y + r.y) / 2;
  const chin = jaw[8];
  const upper = nose.y - eyesY;
  const lower = chin.y - nose.y;
  const pitch = lower > 0 ? upper / lower : 0;
  if (pitch < 0.38) return 'Lower your chin a little and look at the screen.';
  if (pitch > 1.15) return 'Raise your chin a little and look at the screen.';
  return null;
}

// One frame: is there exactly one usable face, and how open are the eyes?
// Returns { ok, problem, ratio, detection }.
// inputSize 224 is quicker (used while watching for the eyes closing);
// 320 is sharper (used for the face numbers). lenient: only "one face", for
// frames with the eyes shut, which score lower.
export async function readFrame(faceapi, video, withDescriptor = false, inputSize = 320, lenient = false) {
  const options = new faceapi.TinyFaceDetectorOptions({ inputSize, scoreThreshold: lenient ? 0.35 : 0.5 });
  let task = faceapi.detectAllFaces(video, options).withFaceLandmarks();
  if (withDescriptor) task = task.withFaceDescriptors();
  const faces = await task;

  if (!faces.length) return { ok: false, problem: 'No face found. Look straight at the camera.' };
  if (faces.length > 1) return { ok: false, problem: 'More than one face in view. Only you should be in the picture.' };

  const face = faces[0];
  if (lenient) return { ok: true, ratio: eyesOpenRatio(face.landmarks), contrast: eyeContrast(video, face.landmarks), detection: face };
  const box = face.detection.box;
  const frameWidth = video.videoWidth || 640;
  if (box.width < frameWidth * 0.22) return { ok: false, problem: 'Move a little closer to the camera.' };
  if (face.detection.score < 0.6) return { ok: false, problem: 'Hold still and face the camera.' };
  const light = brightness(video, box);
  if (light < 55) return { ok: false, problem: 'It’s too dark. Turn towards a light.' };
  if (light > 235) return { ok: false, problem: 'Too much light behind or on you. Move out of the glare.' };
  const pose = facingProblem(face.landmarks);
  if (pose) return { ok: false, problem: pose };

  return { ok: true, ratio: eyesOpenRatio(face.landmarks), contrast: eyeContrast(video, face.landmarks), detection: face };
}

// small JPEG of the current frame, for the admin to look at
export function snapshot(video, width = 360) {
  const w = width;
  const h = Math.round((video.videoHeight / video.videoWidth) * w) || 270;
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d').drawImage(video, 0, 0, w, h);
  return new Promise(resolve => c.toBlob(b => resolve(b), 'image/jpeg', 0.72));
}

export function toPlainArray(descriptor) {
  return Array.from(descriptor, n => Math.round(n * 1e6) / 1e6);
}

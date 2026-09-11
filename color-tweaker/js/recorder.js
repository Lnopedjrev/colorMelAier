import { RECORDING_SCORE_ENDPOINT } from "./config.js";

const MAX_RECORDING_MS = 5000;
const DEFAULT_FRAME_RATE = 30;
const MIN_FRAME_RATE = 1;
const MAX_FRAME_RATE = 60;

function selectedFrameRate(input) {
  const requested = input.value.trim()
    ? Math.round(Number(input.value))
    : Number.NaN;
  const frameRate = Number.isFinite(requested)
    ? Math.min(MAX_FRAME_RATE, Math.max(MIN_FRAME_RATE, requested))
    : DEFAULT_FRAME_RATE;
  input.value = String(frameRate);
  return frameRate;
}

function recordingFormat() {
  const formats = [
    { mimeType: "video/webm;codecs=vp9", extension: "webm" },
    { mimeType: "video/webm;codecs=vp8", extension: "webm" },
    { mimeType: "video/webm", extension: "webm" },
    { mimeType: "video/mp4", extension: "mp4" },
  ];
  if (typeof MediaRecorder.isTypeSupported !== "function") {
    return { mimeType: "", extension: "webm" };
  }
  return (
    formats.find(({ mimeType }) => MediaRecorder.isTypeSupported(mimeType)) ||
    { mimeType: "", extension: "webm" }
  );
}

function recordingFilename(extension) {
  return `color-tweaker-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.${extension}`;
}

function saveRecording(blob, filename) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
}

function scoreFromPayload(payload) {
  let score = payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    if ("score" in payload) score = payload.score;
    else if ("vector" in payload) score = payload.vector;
  }

  if (typeof score === "number" && Number.isFinite(score)) return score;
  if (
    Array.isArray(score) &&
    score.length > 0 &&
    score.every((value) => typeof value === "number" && Number.isFinite(value))
  ) {
    return score;
  }
  throw new TypeError(
    "The scoring endpoint must return a JSON number, numeric array, score, or vector.",
  );
}

// POST multipart/form-data with `video` and `fps`. The response may be a JSON
export async function requestVideoScore(endpoint, blob, filename, frameRate) {
  const body = new FormData();
  body.append("video", blob, filename);
  body.append("fps", String(frameRate));

  const response = await fetch(new URL(endpoint, window.location.href), {
    method: "POST",
    body,
  });
  if (!response.ok) {
    throw new Error(`Scoring endpoint returned HTTP ${response.status}.`);
  }
  return scoreFromPayload(await response.json());
}

function showScoreStatus(output, text, state, fullText = text) {
  output.hidden = false;
  output.dataset.state = state;
  output.textContent = text;
  output.title = fullText;
}

function showScore(output, score) {
  const value = Array.isArray(score) ? `[${score.join(", ")}]` : String(score);
  const abbreviated = value.length > 64 ? `${value.slice(0, 61)}…` : value;
  showScoreStatus(output, `Score: ${abbreviated}`, "success", `Score: ${value}`);
}

function delay(milliseconds) {
  return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
}

async function waitForPreviewPaint() {
  await Promise.race([
    new Promise((resolve) => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    }),
    delay(100),
  ]);
}

async function waitForCapturedFrame(stream) {
  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;

  try {
    await Promise.race([video.play().catch(() => {}), delay(500)]);
    if (typeof video.requestVideoFrameCallback === "function") {
      await Promise.race([
        new Promise((resolve) => video.requestVideoFrameCallback(resolve)),
        delay(500),
      ]);
    } else {
      await delay(100);
    }
  } finally {
    video.pause();
    video.srcObject = null;
  }
}

let stopActiveRecording = null;

async function recordPreview(
  button,
  stopButton,
  fpsInput,
  scoreOutput,
  beforeRecording,
) {
  if (
    !navigator.mediaDevices?.getDisplayMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    window.alert("This browser does not support preview recording.");
    return;
  }

  const frameRate = selectedFrameRate(fpsInput);
  fpsInput.closest("details")?.removeAttribute("open");
  scoreOutput.hidden = true;
  button.disabled = true;

  let stream = null;
  let stopTimer = null;
  let recording = null;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: frameRate, max: frameRate } },
      audio: false,
      preferCurrentTab: true,
    });

    beforeRecording();
    document.body.classList.add("recording-preview-mode");
    await waitForPreviewPaint();
    await waitForCapturedFrame(stream);

    const format = recordingFormat();
    const recorder = format.mimeType
      ? new MediaRecorder(stream, { mimeType: format.mimeType })
      : new MediaRecorder(stream);
    const chunks = [];

    const stopped = new Promise((resolve, reject) => {
      recorder.addEventListener("dataavailable", (event) => {
        if (event.data.size) chunks.push(event.data);
      });
      recorder.addEventListener("stop", resolve, { once: true });
      recorder.addEventListener(
        "error",
        (event) => reject(event.error || new Error("Recording failed.")),
        { once: true },
      );
    });

    const stopRecorder = () => {
      if (recorder.state !== "inactive") recorder.stop();
    };
    stream.getVideoTracks()[0]?.addEventListener("ended", stopRecorder, {
      once: true,
    });

    recorder.start();
    stopActiveRecording = stopRecorder;
    stopButton.hidden = false;
    stopTimer = window.setTimeout(stopRecorder, MAX_RECORDING_MS);
    await stopped;

    if (chunks.length) {
      const mimeType = recorder.mimeType || format.mimeType || "video/webm";
      const extension = mimeType.includes("mp4") ? "mp4" : format.extension;
      recording = {
        blob: new Blob(chunks, { type: mimeType }),
        filename: recordingFilename(extension),
      };
    }
  } catch (error) {
    if (error.name !== "NotAllowedError" && error.name !== "AbortError") {
      console.error(error);
      window.alert(error.message || "The preview could not be recorded.");
    }
  } finally {
    if (stopTimer !== null) window.clearTimeout(stopTimer);
    stopActiveRecording = null;
    stopButton.hidden = true;
    stream?.getTracks().forEach((track) => track.stop());
    document.body.classList.remove("recording-preview-mode");
    button.disabled = false;
  }

  if (!recording) return;
  saveRecording(recording.blob, recording.filename);

  const endpoint = RECORDING_SCORE_ENDPOINT.trim();
  if (!endpoint) return;
  showScoreStatus(scoreOutput, "Scoring…", "pending");
  try {
    const score = await requestVideoScore(
      endpoint,
      recording.blob,
      recording.filename,
      frameRate,
    );
    showScore(scoreOutput, score);
  } catch (error) {
    console.error(error);
    showScoreStatus(
      scoreOutput,
      "Scoring failed",
      "error",
      error.message || "Scoring failed",
    );
  }
}

export function initPreviewRecorder(
  button,
  stopButton,
  fpsInput,
  scoreOutput,
  beforeRecording = () => {},
) {
  fpsInput.addEventListener("change", () => selectedFrameRate(fpsInput));
  button.addEventListener("click", () => {
    recordPreview(
      button,
      stopButton,
      fpsInput,
      scoreOutput,
      beforeRecording,
    );
  });
  stopButton.addEventListener("click", () => {
    stopActiveRecording?.();
  });
}

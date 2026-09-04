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

function saveRecording(blob, extension) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `color-tweaker-${new Date()
    .toISOString()
    .replace(/[:.]/g, "-")}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 0);
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

async function recordPreview(button, stopButton, fpsInput, beforeRecording) {
  if (
    !navigator.mediaDevices?.getDisplayMedia ||
    typeof MediaRecorder === "undefined"
  ) {
    window.alert("This browser does not support preview recording.");
    return;
  }

  const frameRate = selectedFrameRate(fpsInput);
  fpsInput.closest("details")?.removeAttribute("open");
  button.disabled = true;

  let stream = null;
  let stopTimer = null;
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
      saveRecording(new Blob(chunks, { type: mimeType }), extension);
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
}

export function initPreviewRecorder(
  button,
  stopButton,
  fpsInput,
  beforeRecording = () => {},
) {
  fpsInput.addEventListener("change", () => selectedFrameRate(fpsInput));
  button.addEventListener("click", () => {
    recordPreview(button, stopButton, fpsInput, beforeRecording);
  });
  stopButton.addEventListener("click", () => {
    stopActiveRecording?.();
  });
}

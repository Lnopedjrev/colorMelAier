const TYPES = Object.freeze({
  HOST_READY: "ct:build-preview-host-ready",
  CLEAR: "ct:build-preview-clear",
  READY: "ct:sandbox-ready",
  LOADED: "ct:build-loaded",
  ERROR: "ct:build-error",
  WARNING: "ct:build-warning",
  SOURCES: "ct:build-sources",
});

const sessionId = new URL(location.href).searchParams.get("session");
const frame = document.getElementById("sandbox-preview");
const status = document.getElementById("preview-status");
const channel = sessionId
  ? new BroadcastChannel(`ct-build-preview:${sessionId}`)
  : null;
const hostInstanceId = crypto.randomUUID();
let currentTabId = null;
let sandboxReady = false;
let queuedMessages = [];

function showStatus(message, error = false) {
  status.hidden = !message;
  status.textContent = message || "";
  status.classList.toggle("error", error);
}

function sendToSandbox(message) {
  if (!sandboxReady || !frame.contentWindow) {
    queuedMessages.push(message);
    return;
  }
  const transfer =
    message.type === "ct:sandbox-load-build"
      ? (message.files || []).map((file) => file.buffer).filter(Boolean)
      : [];
  frame.contentWindow.postMessage(message, "*", transfer);
}

function flushQueue() {
  const messages = queuedMessages;
  queuedMessages = [];
  for (const message of messages) sendToSandbox(message);
}

function resetSandbox() {
  sandboxReady = false;
  queuedMessages = [];
  showStatus("Waiting for a build from the ColorTweaker side panel…");
  frame.src = "../sandbox/preview.html";
}

if (!channel) {
  showStatus("This preview tab was opened without a ColorTweaker session.", true);
} else {
  channel.addEventListener("message", (event) => {
    if (!event.data?.type) return;
    if (event.data.type === TYPES.CLEAR) {
      resetSandbox();
      return;
    }
    sendToSandbox(event.data);
  });

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow || !event.data?.type) return;
    if (event.data.type === TYPES.READY) {
      sandboxReady = true;
      flushQueue();
    } else if (event.data.type === TYPES.LOADED) {
      showStatus(`Starting ${event.data.entryPath}…`);
    } else if (event.data.type === TYPES.SOURCES) {
      showStatus("");
    } else if (event.data.type === TYPES.WARNING) {
      showStatus(event.data.message || "The build reported a runtime error.", true);
    } else if (event.data.type === TYPES.ERROR) {
      showStatus(event.data.error || "Unable to load the build.", true);
    }
    channel.postMessage(event.data);
  });

  // Start the sandbox only after the message listener exists. Otherwise the
  // sandbox can post its one-time READY message before this host can receive it.
  resetSandbox();

  chrome.tabs.getCurrent().then((tab) => {
    currentTabId = tab?.id ?? null;
    channel.postMessage({
      type: TYPES.HOST_READY,
      tabId: currentTabId,
      hostInstanceId,
    });
  });
  window.addEventListener("beforeunload", () => {
    channel.close();
  });
}

export const MESSAGE_TYPES = Object.freeze({
  PING: "ct:ping",
  ATTACH_REQUEST: "ct:attach-request",
  DETACH_REQUEST: "ct:detach-request",
  GET_ACTIVE_SESSION: "ct:get-active-session",
  SESSION_STATE: "ct:session-state",
  SCAN_REQUEST: "ct:scan-request",
  SOURCES_SNAPSHOT: "ct:sources-snapshot",
  SOURCES_CHANGED: "ct:sources-changed",
  REGISTER_REMOTE_SOURCES: "ct:register-remote-sources",
  APPLY_SOURCE_UPDATES: "ct:apply-source-updates",
  INSPECT_START: "ct:inspect-start",
  INSPECT_STOP: "ct:inspect-stop",
  INSPECT_RESULT: "ct:inspect-result",
  ERROR: "ct:error",
});

const KNOWN_MESSAGE_TYPES = new Set(Object.values(MESSAGE_TYPES));

export function createMessage(type, payload = {}) {
  if (!KNOWN_MESSAGE_TYPES.has(type)) {
    throw new TypeError(`Unknown ColorTweaker message type: ${type}`);
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("ColorTweaker message payload must be an object");
  }
  return { type, ...payload };
}

export function isColorTweakerMessage(value, type = null) {
  if (!value || typeof value !== "object") return false;
  if (!KNOWN_MESSAGE_TYPES.has(value.type)) return false;
  return type === null || value.type === type;
}

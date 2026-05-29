import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

let MAX_EVENTS = 2000;
let RETENTION_DAYS = 30;
let storeFilePath = path.resolve(process.cwd(), "data", "auth-events.json");
let events = [];

function ensureStoreDirectoryExists(filePath) {
  const dirPath = path.dirname(filePath);
  if (!existsSync(dirPath)) {
    mkdirSync(dirPath, { recursive: true });
  }
}

function parseStoreFile(rawText) {
  try {
    const parsed = JSON.parse(String(rawText || ""));
    if (Array.isArray(parsed)) {
      return parsed;
    }
    if (Array.isArray(parsed?.events)) {
      return parsed.events;
    }
    return [];
  } catch {
    return [];
  }
}

function sanitizeText(value, max = 300) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  return text.length > max ? `${text.slice(0, max)}...` : text;
}

function sanitizeNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function parseTimestampMs(value) {
  const ms = Date.parse(String(value || ""));
  return Number.isFinite(ms) ? ms : 0;
}

function eventIsExpired(event, nowMs = Date.now()) {
  const retentionMs = Math.max(1, RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const ts = parseTimestampMs(event?.timestamp);
  if (!ts) {
    return false;
  }
  return nowMs - ts > retentionMs;
}

function trimExpiredEvents(nowMs = Date.now()) {
  events = events.filter((event) => !eventIsExpired(event, nowMs));
}

function persistEvents() {
  ensureStoreDirectoryExists(storeFilePath);
  writeFileSync(
    storeFilePath,
    JSON.stringify(
      {
        version: 1,
        updated_at: new Date().toISOString(),
        retention_days: RETENTION_DAYS,
        total: events.length,
        events,
      },
      null,
      2,
    ),
    "utf8",
  );
}

function loadPersistedEvents() {
  try {
    if (!existsSync(storeFilePath)) {
      events = [];
      return;
    }

    const raw = readFileSync(storeFilePath, "utf8");
    const parsed = parseStoreFile(raw)
      .filter((item) => item && typeof item === "object")
      .slice(0, MAX_EVENTS);
    events = parsed;
    trimExpiredEvents();
  } catch {
    events = [];
  }
}

function buildEvent(payload) {
  const nowIso = new Date().toISOString();
  const timestamp = sanitizeText(payload?.timestamp || nowIso, 40) || nowIso;
  return {
    id: sanitizeText(payload?.id, 80) || `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    timestamp,
    event_type: sanitizeText(payload?.event_type, 60) || "auth_event",
    outcome: sanitizeText(payload?.outcome, 60) || "unknown",
    reason: sanitizeText(payload?.reason, 120) || null,
    email: sanitizeText(payload?.email, 160).toLowerCase() || null,
    role: sanitizeText(payload?.role, 40) || null,
    session_id: sanitizeText(payload?.session_id, 120) || null,
    ip: sanitizeText(payload?.ip, 80) || null,
    user_agent: sanitizeText(payload?.user_agent, 360) || null,
    request_path: sanitizeText(payload?.request_path, 240) || null,
    request_method: sanitizeText(payload?.request_method, 20) || null,
    details: payload?.details && typeof payload.details === "object" ? payload.details : null,
  };
}

export function configureAuthAuditStore({ filePath, maxEvents, retentionDays } = {}) {
  if (filePath) {
    storeFilePath = path.resolve(process.cwd(), String(filePath));
  }

  const parsedMaxEvents = Number(maxEvents);
  if (Number.isInteger(parsedMaxEvents) && parsedMaxEvents > 0) {
    MAX_EVENTS = parsedMaxEvents;
  }

  const parsedRetentionDays = Number(retentionDays);
  if (Number.isInteger(parsedRetentionDays) && parsedRetentionDays > 0) {
    RETENTION_DAYS = parsedRetentionDays;
  }

  loadPersistedEvents();
}

export function registerAuthAuditEvent(payload = {}) {
  trimExpiredEvents();
  const event = buildEvent(payload);
  events.unshift(event);
  if (events.length > MAX_EVENTS) {
    events.length = MAX_EVENTS;
  }
  persistEvents();
  return event;
}

export function listAuthAuditEvents({ limit = 50, eventType, outcome, email } = {}) {
  trimExpiredEvents();
  const safeLimit = Math.max(1, Math.min(sanitizeNumber(limit, 50), 300));
  const filterEventType = sanitizeText(eventType, 60).toLowerCase();
  const filterOutcome = sanitizeText(outcome, 60).toLowerCase();
  const filterEmail = sanitizeText(email, 160).toLowerCase();

  const filtered = events.filter((event) => {
    if (filterEventType && String(event?.event_type || "").toLowerCase() !== filterEventType) {
      return false;
    }

    if (filterOutcome && String(event?.outcome || "").toLowerCase() !== filterOutcome) {
      return false;
    }

    if (filterEmail && String(event?.email || "").toLowerCase() !== filterEmail) {
      return false;
    }

    return true;
  });

  return filtered.slice(0, safeLimit);
}

export function getAuthAuditStats() {
  trimExpiredEvents();
  let loginSuccess = 0;
  let loginFailed = 0;
  let logoutTotal = 0;
  let revokedTotal = 0;

  for (const event of events) {
    const type = String(event?.event_type || "").toLowerCase();
    const outcome = String(event?.outcome || "").toLowerCase();
    if (type === "login" && outcome === "success") {
      loginSuccess += 1;
    }
    if (type === "login" && outcome === "failed") {
      loginFailed += 1;
    }
    if (type === "logout") {
      logoutTotal += 1;
    }
    if (type === "session_revoked") {
      revokedTotal += 1;
    }
  }

  return {
    total_events: events.length,
    login_success: loginSuccess,
    login_failed: loginFailed,
    logout_total: logoutTotal,
    session_revoked_total: revokedTotal,
    retention_days: RETENTION_DAYS,
  };
}

configureAuthAuditStore();

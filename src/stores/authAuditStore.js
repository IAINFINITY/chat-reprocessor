import { prisma } from "../clients/prismaClient.js";

let MAX_EVENTS = 2000;
let RETENTION_DAYS = 30;

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

function toDate(value) {
  const raw = Date.parse(String(value || ""));
  if (Number.isFinite(raw)) {
    return new Date(raw);
  }
  return new Date();
}

function mapFromRow(row) {
  return {
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    event_type: row.eventType,
    outcome: row.outcome,
    reason: row.reason,
    email: row.email,
    role: row.role,
    session_id: row.sessionId,
    ip: row.ip,
    user_agent: row.userAgent,
    request_path: row.requestPath,
    request_method: row.requestMethod,
    details: row.details,
  };
}

async function trimOldEvents() {
  const cutoffDate = new Date(Date.now() - Math.max(1, RETENTION_DAYS) * 24 * 60 * 60 * 1000);
  await prisma.authAuditEvent.deleteMany({
    where: {
      createdAt: {
        lt: cutoffDate,
      },
    },
  });

  const rows = await prisma.authAuditEvent.findMany({
    orderBy: { createdAt: "desc" },
    select: { id: true },
    skip: MAX_EVENTS,
  });

  if (rows.length > 0) {
    await prisma.authAuditEvent.deleteMany({
      where: {
        id: {
          in: rows.map((item) => item.id),
        },
      },
    });
  }
}

export function configureAuthAuditStore({ maxEvents, retentionDays } = {}) {
  const parsedMaxEvents = Number(maxEvents);
  if (Number.isInteger(parsedMaxEvents) && parsedMaxEvents > 0) {
    MAX_EVENTS = parsedMaxEvents;
  }

  const parsedRetentionDays = Number(retentionDays);
  if (Number.isInteger(parsedRetentionDays) && parsedRetentionDays > 0) {
    RETENTION_DAYS = parsedRetentionDays;
  }
}

export async function registerAuthAuditEvent(payload = {}) {
  const created = await prisma.authAuditEvent.create({
    data: {
      eventType: sanitizeText(payload?.event_type, 60) || "auth_event",
      outcome: sanitizeText(payload?.outcome, 60) || "unknown",
      reason: sanitizeText(payload?.reason, 120) || null,
      email: sanitizeText(payload?.email, 160).toLowerCase() || null,
      role: sanitizeText(payload?.role, 40) || null,
      sessionId: sanitizeText(payload?.session_id, 120) || null,
      ip: sanitizeText(payload?.ip, 80) || null,
      userAgent: sanitizeText(payload?.user_agent, 360) || null,
      requestPath: sanitizeText(payload?.request_path, 240) || null,
      requestMethod: sanitizeText(payload?.request_method, 20) || null,
      details: payload?.details && typeof payload.details === "object" ? payload.details : null,
      createdAt: toDate(payload?.timestamp),
    },
  });

  await trimOldEvents();
  return mapFromRow(created);
}

export async function listAuthAuditEvents({ limit = 50, eventType, outcome, email } = {}) {
  const safeLimit = Math.max(1, Math.min(sanitizeNumber(limit, 50), 300));
  const filterEventType = sanitizeText(eventType, 60).toLowerCase();
  const filterOutcome = sanitizeText(outcome, 60).toLowerCase();
  const filterEmail = sanitizeText(email, 160).toLowerCase();

  const rows = await prisma.authAuditEvent.findMany({
    where: {
      ...(filterEventType ? { eventType: filterEventType } : {}),
      ...(filterOutcome ? { outcome: filterOutcome } : {}),
      ...(filterEmail ? { email: filterEmail } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: safeLimit,
  });

  return rows.map(mapFromRow);
}

export async function getAuthAuditStats() {
  const grouped = await prisma.authAuditEvent.groupBy({
    by: ["eventType", "outcome"],
    _count: {
      _all: true,
    },
  });

  const total = await prisma.authAuditEvent.count();
  let loginSuccess = 0;
  let loginFailed = 0;
  let logoutTotal = 0;
  let revokedTotal = 0;

  for (const item of grouped) {
    const type = String(item?.eventType || "").toLowerCase();
    const result = String(item?.outcome || "").toLowerCase();
    const count = Number(item?._count?._all || 0);
    if (type === "login" && result === "success") {
      loginSuccess += count;
    }
    if (type === "login" && result === "failed") {
      loginFailed += count;
    }
    if (type === "logout") {
      logoutTotal += count;
    }
    if (type === "session_revoked") {
      revokedTotal += count;
    }
  }

  return {
    total_events: total,
    login_success: loginSuccess,
    login_failed: loginFailed,
    logout_total: logoutTotal,
    session_revoked_total: revokedTotal,
    retention_days: RETENTION_DAYS,
  };
}


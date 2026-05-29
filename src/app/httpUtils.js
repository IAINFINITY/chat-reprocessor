import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

const STATIC_CONTENT_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
};

const MAX_JSON_BODY_BYTES = 1024 * 1024;

export function json(res, statusCode, body) {
  const payload = JSON.stringify(body, null, 2);

  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(payload),
  });

  res.end(payload);
}

export function html(res, statusCode, content) {
  res.writeHead(statusCode, {
    "Content-Type": "text/html; charset=utf-8",
    "Content-Length": Buffer.byteLength(content),
  });

  res.end(content);
}

function getStaticContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  return STATIC_CONTENT_TYPES[extension] || "application/octet-stream";
}

export function tryServeStaticAsset(req, res, pathname, publicDirPath) {
  if (req.method !== "GET" || pathname === "/") {
    return false;
  }

  let decodedPathname = pathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return false;
  }

  const relativePath = decodedPathname.replace(/^\/+/, "");
  if (!relativePath || relativePath.includes("\0")) {
    return false;
  }

  const absolutePath = path.resolve(publicDirPath, relativePath);
  const publicPrefix = `${publicDirPath}${path.sep}`;
  if (!absolutePath.startsWith(publicPrefix)) {
    return false;
  }

  if (!existsSync(absolutePath)) {
    return false;
  }

  let stats;
  try {
    stats = statSync(absolutePath);
  } catch {
    return false;
  }

  if (!stats.isFile()) {
    return false;
  }

  const buffer = readFileSync(absolutePath);
  res.writeHead(200, {
    "Content-Type": getStaticContentType(absolutePath),
    "Content-Length": buffer.length,
    "Cache-Control": "no-store",
  });
  res.end(buffer);
  return true;
}

export function getRequestUrl(req) {
  const host = req.headers.host || "localhost";
  const rawPath = req.url || "/";
  return new URL(rawPath, `http://${host}`);
}

export function resolveSafeNextPath(rawNext) {
  const next = String(rawNext || "").trim();
  if (!next) {
    return "/reprocessador";
  }

  if (!next.startsWith("/") || next.startsWith("//")) {
    return "/reprocessador";
  }

  if (next.startsWith("/login")) {
    return "/reprocessador";
  }

  return next;
}

export async function readJsonBody(req) {
  const chunks = [];
  let totalBytes = 0;

  for await (const chunk of req) {
    totalBytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
    if (totalBytes > MAX_JSON_BODY_BYTES) {
      const error = new Error("Payload JSON excede o limite de 1MB.");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Body JSON inválido.");
    error.statusCode = 400;
    throw error;
  }
}

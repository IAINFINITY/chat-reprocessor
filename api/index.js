import { requestHandler } from "../src/app/server.js";

export default async function handler(req, res) {
  const requestUrl = new URL(String(req.url || "/"), "http://localhost");
  const forwardedPath = requestUrl.searchParams.get("__path");

  if (forwardedPath !== null) {
    requestUrl.searchParams.delete("__path");
    const normalizedPath = `/${String(forwardedPath || "").replace(/^\/+/, "")}`;
    const normalizedQuery = requestUrl.searchParams.toString();
    req.url = normalizedQuery ? `${normalizedPath}?${normalizedQuery}` : normalizedPath;
  }

  return requestHandler(req, res);
}

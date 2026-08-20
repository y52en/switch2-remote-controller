const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

export function allowedLocalControlOrigin(origin, port) {
  // Native diagnostic clients do not send Origin. Browser clients do, so a
  // cross-site page cannot drive the loopback WebSocket merely because the
  // bridge itself listens on 127.0.0.1.
  if (origin === undefined || origin === null || origin === "") return true;
  try {
    const url = new URL(origin);
    const effectivePort = url.port ? Number(url.port) : 80;
    return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname) &&
      Number.isInteger(port) && effectivePort === port &&
      !url.username && !url.password && url.pathname === "/" &&
      !url.search && !url.hash;
  } catch {
    return false;
  }
}

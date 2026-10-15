/**
 * The session sends the user's ID token to this URL, so a link must never
 * choose it. The `?gateway=` override is honored in dev builds only.
 */
export function gatewayUrl(location: Pick<Location, "protocol" | "host" | "search">, dev: boolean): string {
  if (dev) {
    const override = new URLSearchParams(location.search).get("gateway");
    if (override) return override;
  }
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${location.host}/ws`;
}

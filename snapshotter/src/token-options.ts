/** Asks for a new Felix token; `signal` aborts the request. */
export type TokenProvider = (signal: AbortSignal) => Promise<string>;

/**
 * The credential half of the client's connect options: the provider when the
 * snapshotter signs itself in, else the fixed token it was given.
 */
export function credentialOptions(
  token: string,
  provider: TokenProvider | null,
): { tokenProvider: TokenProvider } | { token: string } {
  return provider ? { tokenProvider: provider } : { token };
}

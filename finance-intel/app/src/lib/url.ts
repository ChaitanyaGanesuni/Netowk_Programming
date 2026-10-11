/**
 * Minimal URL helpers. React Native's global URL has historically lacked `searchParams` and
 * `origin`, so app code parses the few URLs it handles itself.
 */

export function queryParams(url: string): Record<string, string> {
  const query = url.split('?')[1]?.split('#')[0] ?? '';
  const params: Record<string, string> = {};
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const [key = '', value = ''] = pair.split('=');
    params[decodeURIComponent(key.replace(/\+/g, ' '))] = decodeURIComponent(value.replace(/\+/g, ' '));
  }
  return params;
}

/** Accepts "https://host[:port][/...]" and returns "https://host[:port]". */
export function normalizeBackendUrl(input: string): string {
  const match = /^(https:\/\/[a-z0-9.-]+(?::\d{1,5})?)(?:\/.*)?$/i.exec(input.trim());
  if (!match?.[1]) throw new Error('Enter the backend URL starting with https://');
  return match[1].toLowerCase();
}

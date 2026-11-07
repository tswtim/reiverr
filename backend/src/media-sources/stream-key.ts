/**
 * Express decodes a matched path parameter once before Nest exposes it.
 * A second decodeURIComponent() would turn a title containing "%20" into a
 * different key and break the plugin lookup. Read the captured value as-is.
 *
 * The route is a trailing wildcard (`*`), whose capture is exposed as "0".
 * A named `:key` is accepted too so callers that already encode the segment
 * keep working if the route pattern is narrowed back to one segment.
 */
export function readStreamKey(
  params: Record<string, string | undefined> | undefined,
): string {
  if (!params) return '';
  if (typeof params.key === 'string') return params.key;
  if (typeof params['0'] === 'string') return params['0'];
  return '';
}

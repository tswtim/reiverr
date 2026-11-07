/**
 * Encode a plugin stream key once, as a single URL path segment.
 * The server decodes the matched path once. Do not decode the key here:
 * titles that already contain "%", "%20", or other escapes must survive.
 */
export function encodeStreamKey(key: string): string {
	return encodeURIComponent(key ?? '');
}

export function movieStreamPath(sourceId: string, tmdbId: string, key: string): string {
	return `/api/sources/${sourceId}/movies/tmdb/${tmdbId}/streams/${encodeStreamKey(key)}`;
}

export function episodeStreamPath(
	sourceId: string,
	tmdbId: string,
	season: number,
	episode: number,
	key: string
): string {
	return `/api/sources/${sourceId}/shows/tmdb/${tmdbId}/season/${season}/episode/${episode}/streams/${encodeStreamKey(
		key
	)}`;
}

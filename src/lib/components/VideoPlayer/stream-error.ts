/** Show a server-provided stream error only when it cannot carry a secret or a URL. */
export function safeStreamErrorMessage(error: unknown): string {
	const message = (error as { response?: { data?: { message?: unknown } } } | undefined)?.response
		?.data?.message;
	if (
		typeof message === 'string' &&
		message.length > 0 &&
		message.length <= 180 &&
		!/api[_-]?key|magnet:|https?:\/\//i.test(message)
	) {
		return message;
	}
	return 'Could not open this release.';
}

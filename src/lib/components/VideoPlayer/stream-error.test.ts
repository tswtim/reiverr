import assert from 'node:assert/strict';
import { test } from 'node:test';
import { safeStreamErrorMessage } from './stream-error.ts';

test('shows a safe server message and hides links and keys', () => {
	assert.equal(
		safeStreamErrorMessage({
			response: {
				data: { message: 'The downloaded file is not a torrent.' }
			}
		}),
		'The downloaded file is not a torrent.'
	);
	assert.equal(
		safeStreamErrorMessage({
			response: { data: { message: 'http://jackett.local/dl?jackett_apikey=SECRET' } }
		}),
		'Could not open this release.'
	);
	assert.equal(
		safeStreamErrorMessage({
			response: { data: { message: 'magnet:?xt=urn:btih:abcd' } }
		}),
		'Could not open this release.'
	);
	assert.equal(safeStreamErrorMessage(new Error('network')), 'Could not open this release.');
});

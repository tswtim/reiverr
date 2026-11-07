import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { episodeStreamPath, encodeStreamKey, movieStreamPath } from './stream-key.ts';

const REPORTED_TITLE = 'Менталист / The Mentalist (2008-2015) WEB-DL (S1-7E1-151 of 151) ТВ3';

const KEYS = [
	'ABCDEF0123456789',
	'0',
	'1',
	REPORTED_TITLE,
	'slash/name',
	'100% real',
	'a%20b',
	'what?',
	'hash#tag',
	'paren (2008)',
	'plus+plus',
	'q?x=1&y=2',
	'mix/%?#(字)',
	'Name (2008) [foo]'
];

test('encodeStreamKey encodes once and round-trips with a single decode', () => {
	for (const key of KEYS) {
		const encoded = encodeStreamKey(key);
		assert.equal(encoded, encodeURIComponent(key));
		assert.equal(decodeURIComponent(encoded), key);
		assert.equal(encoded.includes('/'), false);
		assert.equal(encoded.includes('?'), false);
		assert.equal(encoded.includes('#'), false);
		if (key.includes('%') || key.includes('/') || key.includes('?') || key.includes('#')) {
			assert.notEqual(encoded, encodeURIComponent(encoded));
		}
	}
});

test('stream paths keep the key in one segment, including the reported title', () => {
	for (const key of KEYS) {
		const movie = movieStreamPath('source-uuid', '550', key);
		const episode = episodeStreamPath('source-uuid', '5920', 1, 1, key);
		for (const path of [movie, episode]) {
			const url = new URL(path, 'http://reiverr.local');
			assert.equal(url.search, '');
			assert.equal(url.hash, '');
			const segment = url.pathname.split('/streams/')[1];
			assert.equal(segment.includes('/'), false);
			assert.equal(decodeURIComponent(segment), key);
		}
	}

	const reported = episodeStreamPath('source-uuid', '5920', 1, 1, REPORTED_TITLE);
	assert.match(reported, /\/streams\/.*%2F.*/);
	assert.equal(reported.includes('/The%20Mentalist'), false);
});

test('generated client encodes stream keys instead of interpolating them raw', () => {
	const source = readFileSync(new URL('./reiverr.openapi.ts', import.meta.url), 'utf8');
	assert.match(source, /\/movies\/tmdb\/\$\{tmdbId\}\/streams\/\$\{encodeStreamKey\(key\)\}/);
	assert.match(source, /\/episode\/\$\{episode\}\/streams\/\$\{encodeStreamKey\(key\)\}/);
	assert.equal(source.includes('/streams/${key}'), false);
});

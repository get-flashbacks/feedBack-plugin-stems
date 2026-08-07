// Unit tests for src/prefs.js — the localStorage persistence layer. Real
// ES-module import against an in-memory storage stub. prefs.js is import-pure
// (it reads localStorage only inside its functions), so the static import runs
// before the stub is installed with no ill effect.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';

const store = new Map();
globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
};

import {
    karaokeDefault, setKaraokeDefault,
    loadDefaultMuted, saveDefaultMuted,
    loadMuted, saveMuted, loadVolumes, saveVolume,
} from '../src/prefs.js';

beforeEach(() => store.clear());

test('karaoke default round-trips', () => {
    assert.equal(karaokeDefault(), false);
    setKaraokeDefault(true);
    assert.equal(karaokeDefault(), true);
    setKaraokeDefault(false);
    assert.equal(karaokeDefault(), false);
});

test('default-muted set round-trips', () => {
    assert.deepEqual([...loadDefaultMuted()], []);
    saveDefaultMuted(new Set(['bass', 'drums']));
    assert.deepEqual([...loadDefaultMuted()].sort(), ['bass', 'drums']);
});

test('per-song muted: saveMuted stores the off stems, loadMuted returns them', () => {
    assert.equal(loadMuted('song.sloppak'), null);
    saveMuted('song.sloppak', [{ id: 'vocals', on: false }, { id: 'guitar', on: true }, { id: 'bass', on: false }]);
    assert.deepEqual([...loadMuted('song.sloppak')].sort(), ['bass', 'vocals']);
    assert.equal(loadMuted(''), null);        // no filename → null
    saveMuted('', [{ id: 'x', on: false }]);  // no filename → no-op, no throw
});

test('per-song volumes round-trip and merge across saves', () => {
    assert.deepEqual(loadVolumes('s.sloppak'), {});
    saveVolume('s.sloppak', 'guitar', 0.5);
    saveVolume('s.sloppak', 'bass', 0.8);
    assert.deepEqual(loadVolumes('s.sloppak'), { guitar: 0.5, bass: 0.8 });
});

test('corrupt localStorage values degrade to safe defaults', () => {
    store.set('stemsDefaultMuted', '{not json');
    assert.deepEqual([...loadDefaultMuted()], []);
    store.set('stemsVol:x', 'nope');            // invalid JSON
    assert.deepEqual(loadVolumes('x'), {});
    store.set('stemsMute:x', '"a string not array"');
    assert.equal(loadMuted('x'), null);
});

test('loadVolumes coerces valid-but-non-object JSON to {} (guards saveVolume)', () => {
    for (const bad of ['[]', 'true', '42', '"str"', 'null']) {
        store.set('stemsVol:s', bad);
        assert.deepEqual(loadVolumes('s'), {}, `expected {} for ${bad}`);
    }
});

test('filenames are percent-encoded into the storage key, avoiding namespace collisions', () => {
    // A filename containing this module's own ':' key separator must not
    // land at the same key as a differently-named song.
    saveMuted('weird:song.sloppak', [{ id: 'vocals', on: false }]);
    assert.deepEqual([...store.keys()], ['stemsMute:weird%3Asong.sloppak']);
    assert.deepEqual([...loadMuted('weird:song.sloppak')], ['vocals']);

    saveVolume('a/b.sloppak', 'bass', 0.4);
    assert.ok(store.has('stemsVol:a%2Fb.sloppak'));
    assert.deepEqual(loadVolumes('a/b.sloppak'), { bass: 0.4 });
});

test('per-song muted falls back to and migrates legacy raw filename keys', () => {
    const filename = 'set 1/live:take#ñ.sloppak';
    const legacyKey = `stemsMute:${filename}`;
    const encodedKey = `stemsMute:${encodeURIComponent(filename)}`;
    store.set(legacyKey, JSON.stringify(['vocals', 'bass']));

    assert.deepEqual([...loadMuted(filename)].sort(), ['bass', 'vocals']);
    assert.equal(store.has(legacyKey), false);
    assert.equal(store.get(encodedKey), JSON.stringify(['vocals', 'bass']));
});

test('per-song volumes fall back to and migrate legacy raw filename keys', () => {
    const filename = 'set 1/live:take#ñ.sloppak';
    const legacyKey = `stemsVol:${filename}`;
    const encodedKey = `stemsVol:${encodeURIComponent(filename)}`;
    store.set(legacyKey, JSON.stringify({ guitar: 0.35, drums: 0.8 }));

    assert.deepEqual(loadVolumes(filename), { guitar: 0.35, drums: 0.8 });
    assert.equal(store.has(legacyKey), false);
    assert.equal(store.get(encodedKey), JSON.stringify({ guitar: 0.35, drums: 0.8 }));
});

test('encoded per-song preferences win over legacy raw filename keys', () => {
    const filename = 'set 1/live:take#ñ.sloppak';
    store.set(`stemsMute:${filename}`, JSON.stringify(['legacy']));
    store.set(`stemsMute:${encodeURIComponent(filename)}`, JSON.stringify(['encoded']));

    assert.deepEqual([...loadMuted(filename)], ['encoded']);
    assert.equal(store.has(`stemsMute:${filename}`), true);
});

test('a filename matching another song\'s encoded key is never read as that song\'s legacy data', () => {
    // Song A is legitimately named 'a/b.sloppak'; its encoded key is
    // 'stemsMute:a%2Fb.sloppak'. Song B happens to be named literally
    // 'a%2Fb.sloppak' — the exact string Song A's encoded key uses.
    // Without the ambiguity guard, loadMuted('a%2Fb.sloppak') would read
    // (and the migration path would then DELETE) Song A's live entry.
    saveMuted('a/b.sloppak', [{ id: 'vocals', on: false }]);
    assert.deepEqual([...store.keys()], ['stemsMute:a%2Fb.sloppak']);

    assert.equal(loadMuted('a%2Fb.sloppak'), null);
    // Song A's entry must survive completely untouched.
    assert.deepEqual([...store.keys()], ['stemsMute:a%2Fb.sloppak']);
    assert.deepEqual([...loadMuted('a/b.sloppak')], ['vocals']);
});

test('the same collision is avoided for volumes, not just mutes', () => {
    saveVolume('a/b.sloppak', 'bass', 0.4);
    assert.deepEqual(loadVolumes('a%2Fb.sloppak'), {});
    assert.deepEqual(loadVolumes('a/b.sloppak'), { bass: 0.4 });
});

test('plain-ASCII filenames encode as themselves (no behavior change for the common case)', () => {
    saveMuted('song.sloppak', [{ id: 'vocals', on: false }]);
    assert.ok(store.has('stemsMute:song.sloppak'));
});

test('karaokeDefault returns false when localStorage throws (blocked/privacy)', () => {
    const orig = globalThis.localStorage;
    globalThis.localStorage = { getItem: () => { throw new Error('storage blocked'); } };
    try {
        assert.equal(karaokeDefault(), false);
    } finally {
        globalThis.localStorage = orig;
    }
});

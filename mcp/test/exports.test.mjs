// The export tool's parsing and format logic, with caption bodies recorded from YouTube (no network).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { classify, fileName, googleExportUrl, inline, parseJson3, pickTrack, timestamp, transcriptText } from '../src/exports.mjs';

const fixture = (name) => JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));

test('classify: YouTube watch, Shorts and live pages', () => {
  assert.deepEqual(classify('https://www.youtube.com/watch?v=jNQXAC9IVRw&t=4s'), { kind: 'youtube', videoId: 'jNQXAC9IVRw' });
  assert.deepEqual(classify('https://youtube.com/shorts/HluANRwPyNo'), { kind: 'youtube', videoId: 'HluANRwPyNo' });
  assert.deepEqual(classify('https://m.youtube.com/live/iG9CE55wbtY?si=x'), { kind: 'youtube', videoId: 'iG9CE55wbtY' });
  assert.equal(classify('https://www.youtube.com/'), null);
  assert.equal(classify('https://www.youtube.com/watch?v=short'), null);
  assert.equal(classify('https://youtube.com.evil.example/watch?v=jNQXAC9IVRw'), null);
});

test('classify: Google apps, account prefix, sheet gid and resource key', () => {
  const id = '1BxiMVs0XRA5nFMdKvBdBZjgmUUqptlbs74OgvE2upms';
  assert.deepEqual(classify(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=0#gid=1234`),
    { kind: 'google', app: 'spreadsheets', account: '', id, gid: '1234', resourceKey: null });
  assert.deepEqual(classify(`https://docs.google.com/document/u/1/d/${id}/edit?resourcekey=0-abc`),
    { kind: 'google', app: 'document', account: '/u/1', id, gid: null, resourceKey: '0-abc' });
  assert.equal(classify(`https://docs.google.com/spreadsheets/d/${id}/edit?gid=7`).gid, '7');
  assert.equal(classify('https://docs.google.com/forms/d/1FAIpQLSexampleexampleexample/viewform'), null);
  assert.equal(classify('https://en.wikipedia.org/wiki/Ada_Lovelace'), null);
  assert.equal(classify('about:blank'), null);
});

test('googleExportUrl per app', () => {
  const doc = { app: 'document', account: '', id: 'DOCID12345678901234567', gid: null, resourceKey: null };
  assert.equal(googleExportUrl(doc, 'md'), 'https://docs.google.com/document/d/DOCID12345678901234567/export?format=md');
  assert.equal(googleExportUrl({ ...doc, account: '/u/2', resourceKey: '0-k' }, 'pdf'),
    'https://docs.google.com/document/u/2/d/DOCID12345678901234567/export?format=pdf&resourcekey=0-k');
  assert.equal(googleExportUrl({ ...doc, app: 'spreadsheets', gid: '99' }, 'csv'),
    'https://docs.google.com/spreadsheets/d/DOCID12345678901234567/export?format=csv&gid=99');
  assert.equal(googleExportUrl({ ...doc, app: 'presentation' }, 'pptx'), 'https://docs.google.com/presentation/d/DOCID12345678901234567/export?format=pptx');
  assert.equal(googleExportUrl({ ...doc, app: 'drawings' }, 'svg'), 'https://docs.google.com/drawings/d/DOCID12345678901234567/export/svg');
});

test('parseJson3: recorded manual track', () => {
  const lines = parseJson3(fixture('json3-manual.json'));
  assert.ok(lines.length >= 3);
  assert.deepEqual(lines[0], { startMs: lines[0].startMs, text: lines[0].text });
  assert.ok(lines.every((l) => l.text && !/\n/.test(l.text)));
  assert.match(lines.map((l) => l.text).join(' '), /elephants/i);
});

test('parseJson3: recorded auto-generated track, plus line-break-only and window events', () => {
  assert.deepEqual(parseJson3(fixture('json3-asr.json')), [{ startMs: 19650, text: 'god' }]);
  const asr = { events: [
    { tStartMs: 0, dDurationMs: 5000, id: 1 },
    { tStartMs: 160, segs: [{ utf8: 'so' }, { utf8: ' here', tOffsetMs: 200 }, { utf8: ' we', tOffsetMs: 400 }] },
    { tStartMs: 1500, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 1510, segs: [{ utf8: 'are\nagain' }] },
  ] };
  assert.deepEqual(parseJson3(asr), [{ startMs: 160, text: 'so here we' }, { startMs: 1510, text: 'are again' }]);
  assert.deepEqual(parseJson3({}), []);
});

test('timestamp', () => {
  assert.equal(timestamp(0), '00:00');
  assert.equal(timestamp(65_999), '01:05');
  assert.equal(timestamp(3_725_000), '1:02:05');
});

const track = (languageCode, kind, name) => ({ baseUrl: `u-${languageCode}-${kind}`, languageCode, kind, name });
const TED = [track('af', null, 'Afrikaans'), track('de', null, 'German'), track('en', 'asr', 'English (auto-generated)'), track('en', null, 'English'), track('fr', null, 'French')];

test('pickTrack: page language, then English, manual over auto-generated', () => {
  assert.equal(pickTrack(TED, { pageLanguage: 'en-GB' }).baseUrl, 'u-en-null');
  assert.equal(pickTrack(TED, { pageLanguage: 'de' }).baseUrl, 'u-de-null');
  assert.equal(pickTrack(TED, { pageLanguage: 'ja' }).baseUrl, 'u-en-null');
  // Only an auto-generated track in the spoken language (Korean), page in English
  const ko = [track('ko', 'asr', 'Korean (auto-generated)')];
  assert.equal(pickTrack(ko, { pageLanguage: 'en' }).baseUrl, 'u-ko-asr');
  // No page language or English: the spoken language's manual track
  const es = [track('pt', null, 'Portuguese'), track('es', 'asr', 'Spanish (auto-generated)'), track('es', null, 'Spanish')];
  assert.equal(pickTrack(es, { pageLanguage: 'ja' }).baseUrl, 'u-es-null');
  assert.equal(pickTrack([], {}), null);
});

test('pickTrack: asked language by code, base code or name', () => {
  assert.equal(pickTrack(TED, { language: 'fr' }).baseUrl, 'u-fr-null');
  assert.equal(pickTrack(TED, { language: 'German' }).baseUrl, 'u-de-null');
  assert.equal(pickTrack(TED, { language: 'en-US' }).baseUrl, 'u-en-null');
  assert.throws(() => pickTrack(TED, { language: 'ja' }), /No "ja" captions\. Available: af \(Afrikaans\), de \(German\), en \(English, auto-generated\)/);
});

test('transcriptText header and lines', () => {
  const info = { videoId: 'jNQXAC9IVRw', title: 'Me at the zoo', channel: 'jawed', seconds: 19, tracks: [track('en', null, 'English'), track('de', null, 'German')] };
  const text = transcriptText(info, info.tracks[1], [{ startMs: 1200, text: 'Also hier sind wir' }]);
  assert.equal(text, [
    'Title: Me at the zoo', 'Channel: jawed', 'Duration: 00:19', 'Language: de (German)',
    'Other languages: en (English) (pass language to export one)', 'URL: https://www.youtube.com/watch?v=jNQXAC9IVRw', '',
    '[00:01] Also hier sind wir',
  ].join('\n'));
});

test('inline cuts at a line break with a note, fileName is safe', () => {
  const text = Array.from({ length: 100 }, (_, i) => `line ${i}`).join('\n');
  const cut = inline(text, 100);
  assert.ok(cut.length < 200);
  assert.match(cut, /line \d+\n\.\.\. \[cut at 100 of 789 characters; the file has all of it\]$/);
  assert.equal(inline('short', 100), 'short');
  assert.equal(fileName('PSY - GANGNAM STYLE(강남스타일) M/V-9bZkp7q19f0', 'txt'), 'PSY-GANGNAM-STYLE-M-V-9bZkp7q19f0.txt');
  assert.equal(fileName('../../etc/passwd', 'md'), 'etc-passwd.md');
  assert.equal(fileName('???', 'pdf'), 'export.pdf');
});

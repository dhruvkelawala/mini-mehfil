import test from 'node:test';
import assert from 'node:assert/strict';
import { roomPage } from '../share/room-page.mjs';
import { COURTYARD_SCENE } from '../share/courtyard.mjs';

test('room page escapes data and reuses the exact courtyard',()=>{const html=roomPage('ABCD<script>','nonce-value');assert.doesNotMatch(html,/<script>ABCD/);assert.match(html,/ABCD&lt;script&gt;/);assert.match(html,/nonce="nonce-value"/);assert.ok(html.includes(COURTYARD_SCENE));});
test('room page provides join request peek player and setlist surfaces',()=>{const html=roomPage('ABCDEFGH','n');for(const text of ['Join the mehfil 🔊','id="request"','Don\'t click me','id="audio"','Setlist','aria-live="polite"'])assert.ok(html.includes(text),text);});
test('room client uses same-origin paths and session-only credentials',()=>{const html=roomPage('ABCDEFGH','n');assert.match(html,/sessionStorage/);assert.doesNotMatch(html,/localStorage/);assert.match(html,/\/rooms\/'\+roomId\+'\/ws/);assert.match(html,/\/s\/'\+song\.shareId\+'\/audio/);assert.match(html,/Date\.now\(\)-song\.startedAt/);});
test('room client reconnects and keeps playback rejection visible',()=>{const html=roomPage('ABCDEFGH','n');assert.match(html,/Math\.min\(1000\*2\*\*retry,30000\)/);assert.match(html,/Playback needs another tap/);assert.match(html,/await audio\.play\(\)/);});
test('room page contains no token or upload credential fields',()=>{const html=roomPage('ABCDEFGH','n');assert.doesNotMatch(html,/MiniMax.*token|MEHFIL_SHARE_SECRET|uploadSecret|localStorage/);});

// edge/spikes/encrypter/test.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encryptString, decryptString } from './js-encrypter.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const php = 'php';
const tool = path.join(here, 'php-tools.php');

function runPhp(args) {
  return execFileSync(php, [tool, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

// ensure key exists
runPhp(['gen', '1']);

const keyB64 = fs.readFileSync(path.join(here, 'test-key.b64'), 'utf8').trim();

let pass = 0, fail = 0;
const ok = (label) => { pass++; console.log('PASS:', label); };
const bad = (label, err) => { fail++; console.log('FAIL:', label, err && err.message ? err.message : err); };

// (a) PHP -> JS
console.log('=== (a) PHP -> JS ===');
const fixtures = JSON.parse(runPhp(['gen', '20']));
for (const f of fixtures) {
  try {
    const dec = await decryptString(f.payload, keyB64);
    if (dec === f.plaintext) ok('PHP->JS: ' + JSON.stringify(f.plaintext.slice(0, 40)));
    else bad('PHP->JS mismatch: ' + JSON.stringify(f.plaintext.slice(0, 40)), new Error('expected ' + JSON.stringify(f.plaintext) + ' got ' + JSON.stringify(dec)));
  } catch (e) {
    bad('PHP->JS throw: ' + JSON.stringify(f.plaintext.slice(0, 40)), e);
  }
}

// (b) JS -> PHP
console.log('=== (b) JS -> PHP ===');
const samples = [
  '', 'hello', 'Hello, World!', "it's a \"test\"", 'line1\nline2', 'unicode: café ☕ 🎉',
  'a'.repeat(300), 'special: <>&\'"', '0', 'false-ish', 'key=value&x=1', 'path/to/file.txt',
  'UPPER lower Mixed', '1234567890', 'end',
];
for (const s of samples) {
  try {
    const payload = await encryptString(s, keyB64);
    const out = runPhp(['decrypt', payload]).replace(/\n$/, '');
    if (out === s) ok('JS->PHP: ' + JSON.stringify(s.slice(0, 40)));
    else bad('JS->PHP mismatch: ' + JSON.stringify(s.slice(0, 40)), new Error('expected ' + JSON.stringify(s) + ' got ' + JSON.stringify(out)));
  } catch (e) {
    bad('JS->PHP throw: ' + JSON.stringify(s.slice(0, 40)), e);
  }
}

// (c) tamper
console.log('=== (c) tamper ===');
// PHP fixture tampered -> JS must reject
{
  const f = fixtures[0];
  const tamperedOut = runPhp(['tamper', f.payload, '5']).trim();
  // re-derive tampered payload by flipping byte 5 ourselves in JS
  try {
    // flip a byte in the base64 payload
    const raw = Buffer.from(f.payload, 'base64');
    // flip byte at index 10
    const idx = 10;
    const bytes = new Uint8Array(raw);
    bytes[idx] ^= 0xFF;
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    const tamperedB64 = btoa(bin);
    try {
      await decryptString(tamperedB64, keyB64);
      bad('tamper PHP-payload JS-decrypt (should reject)', new Error('did not throw'));
    } catch (e) {
      ok('tamper PHP-payload rejected by JS');
    }
  } catch (e) {
    bad('tamper setup', e);
  }
}
// JS-encrypted payload tampered -> PHP must reject
{
  const payload = await encryptString('tamper me', keyB64);
  const raw = Buffer.from(payload, 'base64');
  const bytes = new Uint8Array(raw);
  bytes[15] ^= 0xFF;
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const tamperedB64 = btoa(bin);
  try {
    runPhp(['decrypt', tamperedB64]);
    bad('tamper JS-payload PHP-decrypt (should reject)', new Error('did not fail'));
  } catch (e) {
    ok('tamper JS-payload rejected by PHP');
  }
}

// (d) wrong key
console.log('=== (d) wrong key ===');
{
  const wrongKey = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
  try {
    await decryptString(fixtures[0].payload, wrongKey);
    bad('wrong key JS-decrypt (should reject)', new Error('did not throw'));
  } catch (e) {
    ok('wrong key rejected by JS');
  }
}

console.log('');
console.log('TOTAL: pass=' + pass + ' fail=' + fail);
process.exit(fail > 0 ? 1 : 0);
"
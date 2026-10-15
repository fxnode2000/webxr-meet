// Opus tuning on an SDP with a microphone line and a shared-screen sound line: node test/sdp.test.mjs
import assert from 'node:assert/strict';
import { tuneOpus } from '../public/net.js';

const audio = (mid, withFmtp) =>
  [
    'm=audio 9 UDP/TLS/RTP/SAVPF 111 63',
    'c=IN IP4 0.0.0.0',
    `a=mid:${mid}`,
    'a=rtpmap:111 opus/48000/2',
    ...(withFmtp ? ['a=fmtp:111 minptime=10;useinbandfec=1'] : []),
    'a=rtpmap:63 red/48000/2',
  ].join('\r\n');
const sdp = ['v=0', 'o=- 1 2 IN IP4 127.0.0.1', 's=-', 't=0 0', audio(0, true), 'm=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=rtpmap:96 VP8/90000', audio(2, false)].join('\r\n') + '\r\n';

const out = tuneOpus(sdp);
const fmtp = out.split('\r\n').filter((l) => l.startsWith('a=fmtp:111'));
assert.equal(fmtp.length, 2, 'both audio lines get an fmtp line');
assert.match(fmtp[0], /maxaveragebitrate=64000/);
assert.match(fmtp[1], /maxaveragebitrate=96000/);
for (const l of fmtp) {
  assert.match(l, /stereo=0/);
  assert.match(l, /useinbandfec=1/);
  assert.match(l, /usedtx=0/);
}
assert.match(fmtp[0], /minptime=10/, 'existing parameters are kept');
assert.ok(out.includes('m=video 9 UDP/TLS/RTP/SAVPF 96\r\na=mid:1\r\na=rtpmap:96 VP8/90000'), 'the video line is untouched');
assert.ok(out.endsWith('\r\n'), 'trailing newline kept');
assert.equal(tuneOpus('v=0\r\n'), 'v=0\r\n', 'no audio, nothing changes');
console.log('ok  opus tuning covers every audio line');

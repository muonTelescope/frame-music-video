// Writes build/cues.json: the sound-effect cue list derived from the choreography, so the
// audio engine can place clinks, ratchets, whooshes and muon zaps exactly on the picture.
import fs from 'node:fs';
import { buildChoreo, SEC_PER_BEAT } from '../video/choreo.js';

const c = buildChoreo();
const cues = c.sfx.map((s) => ({ ...s, sec: s.t * SEC_PER_BEAT }));
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/cues.json', JSON.stringify({ secPerBeat: SEC_PER_BEAT, cues }, null, 0));
const counts = {};
for (const s of cues) counts[s.type] = (counts[s.type] || 0) + 1;
console.log(`wrote build/cues.json: ${cues.length} cues`, counts);

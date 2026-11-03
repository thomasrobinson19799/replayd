// @vitest-environment node
import { readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync, gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ASSET_WEBP, encodeSegment, indexRpl, parseStoredBody, RPL_FLAG_HAS_ERROR, splitSegment } from '../src/wire';

const dir = new URL('../../../../fixtures/wire/', import.meta.url);
const read = (f: string) => new Uint8Array(readFileSync(new URL(f, dir)));
const regen = process.env.REPLAYD_REGEN_FIXTURES === '1';

const metaJson = readFileSync(new URL('segment.meta.json', dir), 'utf8').trim();
const eventsJson = readFileSync(new URL('events.json', dir), 'utf8').trim();
const asset = { id: 7, type: ASSET_WEBP, data: new TextEncoder().encode('RIFFxxxxWEBP') };

describe('wire: segment body', () => {
  it('matches the committed fixture (TS → Rust)', () => {
    if (regen) {
      const gz = new Uint8Array(gzipSync(eventsJson, { level: 9 }));
      writeFileSync(new URL('segment.bin', dir), encodeSegment(metaJson, gz, [asset]));
    }
    const bin = read('segment.bin');
    const { meta, body } = splitSegment(bin);
    expect(JSON.parse(meta)).toEqual(JSON.parse(metaJson));
    const parsed = parseStoredBody(body);
    expect(gunzipSync(parsed.events).toString('utf8')).toBe(eventsJson);
    expect(parsed.assets).toHaveLength(1);
    expect(parsed.assets[0]!.id).toBe(7);
    // re-encoding is byte-identical
    expect(encodeSegment(meta, parsed.events, parsed.assets)).toEqual(bin);
  });

  it('round-trips without assets and rejects malformed bodies', () => {
    const gz = new Uint8Array([0x1f, 0x8b, 8, 0]);
    const seg = encodeSegment('{"sid":"x","seq":0,"t0":1,"t1":2}', gz);
    const { body } = splitSegment(seg);
    expect(parseStoredBody(body).events).toEqual(gz);
    expect(() => parseStoredBody(body.subarray(0, body.length - 1))).toThrow();
    expect(() => parseStoredBody(new Uint8Array([...body, 0]))).toThrow();
    expect(() => encodeSegment('x'.repeat(70000), gz)).toThrow(RangeError);
  });
});

describe('wire: .rpl reader (Rust → TS)', () => {
  it('reads the Rust-written session file', () => {
    const rpl = read('session.rpl');
    const idx = indexRpl(rpl);
    expect(idx.sid).toBe('0192f0c4-7a3e-7b1a-9c2d-3e4f5a6b7c8d');
    expect(idx.frames.map((f) => f.seq)).toEqual([0, 1]);
    expect(idx.duplicates).toBe(1);
    expect(idx.validLen).toBeLessThan(rpl.length); // truncated tail ignored
    const { body } = splitSegment(read('segment.bin'));
    for (const f of idx.frames) {
      expect(f.body).toEqual(body);
      expect(gunzipSync(parseStoredBody(f.body).events).toString('utf8')).toBe(eventsJson);
    }
    expect(idx.frames[1]!.t0).toBe(1730620000123);
    expect(idx.frames[1]!.receivedAt).toBe(1730620006);
    expect(idx.frames[0]!.flags & RPL_FLAG_HAS_ERROR).toBe(RPL_FLAG_HAS_ERROR);
  });

  it('handles streamed prefixes', () => {
    const rpl = read('session.rpl');
    expect(indexRpl(rpl.subarray(0, 22)).frames).toHaveLength(0);
    expect(() => indexRpl(rpl.subarray(0, 10))).toThrow();
  });
});

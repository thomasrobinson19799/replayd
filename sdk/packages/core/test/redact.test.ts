import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as RM from '../src/redact';
import type * as CM from '../src/config';
import { DSN } from './h';

let r: typeof RM, c: typeof CM;
beforeEach(async () => {
  vi.resetModules();
  c = await import('../src/config');
  r = await import('../src/redact');
  c.resolve({ dsn: DSN });
});
const F = '[Filtered]';

describe('headers', () => {
  it('strips Authorization, Cookie, Set-Cookie, X-Api-Key case-insensitively', () => {
    const h = new Headers({ Authorization: 'Bearer x', 'X-API-KEY': 'k', Accept: 'application/json', 'X-Trace': '1' });
    expect(r.rHeaders(h as never)).toEqual({ accept: 'application/json', 'x-trace': '1' });
    expect(r.rHeaders([['Cookie', 'a=b'], ['set-cookie', 'c'], ['Content-Type', 'text/plain']])).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('query params', () => {
  it('redacts token, key, signature (and body keys like access_token), keeps others', () => {
    expect(r.rUrl('https://a.example/x?token=abc&x=1&KEY=2&signature=zz')).toBe(`https://a.example/x?token=${F}&x=1&KEY=${F}&signature=${F}`);
    expect(r.rUrl('/cb#access_token=t0k&state=1')).toBe(`/cb#access_token=${F}&state=1`);
    expect(r.rUrl('/x?apikey=1&monkey=2&tokens=3')).toBe('/x?apikey=1&monkey=2&tokens=3');
    expect(r.rUrl('wss://h/connection/websocket?token=eyJ.a.b')).toBe(`wss://h/connection/websocket?token=${F}`);
  });
  it('honours extended lists', () => {
    c.extend({ queryParams: ['sid'] });
    expect(r.rUrl('/x?sid=1&a=2')).toBe(`/x?sid=${F}&a=2`);
  });
});

describe('JSON bodies', () => {
  it('redacts keys recursively, case-insensitively, inside nested arrays', () => {
    const v = { user: 'u', Password: 'p', nested: { ACCESS_TOKEN: 'a', list: [{ card_number: '4111', ok: 1 }, [{ cvv: 123 }]] } };
    expect(r.rJson(v)).toEqual({ user: 'u', Password: F, nested: { ACCESS_TOKEN: F, list: [{ card_number: F, ok: 1 }, [{ cvv: F }]] } });
  });
  it('replaces subtrees deeper than 8 levels instead of leaking them', () => {
    let v: Record<string, unknown> = { token: 'deep' };
    for (let i = 0; i < 9; i++) v = { a: v };
    expect(JSON.stringify(r.rJson(v))).not.toContain('deep');
    expect(JSON.stringify(r.rJson(v))).toContain('[Depth]');
    let ok: Record<string, unknown> = { token: 'x', keep: 1 };
    for (let i = 0; i < 6; i++) ok = { a: ok };
    expect(JSON.stringify(r.rJson(ok))).toContain('"keep":1');
  });
  it('leaves primitives alone', () => {
    expect(r.rJson('token')).toBe('token');
    expect(r.rJson(null)).toBe(null);
    expect(r.rJson(5)).toBe(5);
  });
});

describe('text bodies / WebSocket frames', () => {
  it('redacts the Centrifugo connect token', () => {
    const out = r.rText('{"id":1,"connect":{"token":"eyJhbGciOi.payload.sig","name":"js"}}');
    expect(JSON.parse(out)).toEqual({ id: 1, connect: { token: F, name: 'js' } });
  });
  it('handles newline-batched JSON line by line', () => {
    const out = r.rText('{"id":1,"connect":{"token":"a"}}\n{"id":2,"subscribe":{"channel":"quotes","token":"b"}}\n{"push":{"channel":"c","pub":{"data":{"otp":"123456","p":1}}}}');
    expect(out.split('\n').map((l) => JSON.parse(l))).toEqual([
      { id: 1, connect: { token: F } },
      { id: 2, subscribe: { channel: 'quotes', token: F } },
      { push: { channel: 'c', pub: { data: { otp: F, p: 1 } } } },
    ]);
  });
  it('falls back to regex for truncated JSON (sliced frames)', () => {
    const out = r.rText('{"id":1,"connect":{"name":"js","token":"eyJhbGciOiJIUzI1NiJ9.abc');
    expect(out).not.toContain('eyJ');
    expect(out).toContain(`"token":"${F}"`);
    expect(r.rText('{"x":{"pin": 1234, "refresh_token" : "r"')).toBe(`{"x":{"pin": "${F}", "refresh_token" : "${F}"`);
  });
  it('redacts form-encoded bodies and leaves plain text alone', () => {
    expect(r.rText('user=a&password=hunter2&x=1')).toBe(`user=a&password=${F}&x=1`);
    expect(r.rText('hello world')).toBe('hello world');
  });
  it('remote-extended body keys apply', () => {
    c.applyRc({ redact: { bodyKeys: ['pan'] } });
    expect(JSON.parse(r.rText('{"pan":"1","Token":"2"}'))).toEqual({ pan: F, Token: F });
  });
});

import { describe, it, expect } from 'vitest';
import { CookieJar } from '../src/cookie-jar.js';

describe('CookieJar', () => {
  it('is empty on construction', () => {
    expect(new CookieJar().toHeader()).toBeUndefined();
  });

  it('ingests a single set-cookie and emits it on toHeader', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc123; Path=/; HttpOnly']);
    expect(jar.toHeader()).toBe('OT_SESSION=abc123');
    expect(jar.has('OT_SESSION')).toBe(true);
  });

  it('ingests multiple cookies in one call', () => {
    const jar = new CookieJar();
    jar.ingest([
      'OT_SESSION=abc; Path=/',
      'otd=xyz; Secure',
    ]);
    expect(jar.toHeader()).toBe('OT_SESSION=abc; otd=xyz');
  });

  it('updates a cookie when re-ingested', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=old']);
    jar.ingest(['OT_SESSION=new']);
    expect(jar.toHeader()).toBe('OT_SESSION=new');
  });

  it('deletes a cookie on max-age=0', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc']);
    jar.ingest(['OT_SESSION=; Max-Age=0']);
    expect(jar.toHeader()).toBeUndefined();
    expect(jar.has('OT_SESSION')).toBe(false);
  });

  it('deletes a cookie on empty value', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc']);
    jar.ingest(['OT_SESSION=']);
    expect(jar.toHeader()).toBeUndefined();
  });

  it('ignores headers without an `=`', () => {
    const jar = new CookieJar();
    jar.ingest(['nonsense; Path=/']);
    expect(jar.toHeader()).toBeUndefined();
  });

  it('tolerates null / empty input', () => {
    const jar = new CookieJar();
    jar.ingest(null);
    jar.ingest([]);
    expect(jar.toHeader()).toBeUndefined();
  });

  it('clear() empties the jar', () => {
    const jar = new CookieJar();
    jar.ingest(['OT_SESSION=abc']);
    jar.clear();
    expect(jar.toHeader()).toBeUndefined();
  });
});

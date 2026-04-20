export class CookieJar {
  private jar = new Map<string, string>();

  ingest(setCookieHeaders: string[] | null | undefined): void {
    if (!setCookieHeaders || setCookieHeaders.length === 0) return;
    for (const header of setCookieHeaders) {
      const firstPart = header.split(';', 1)[0] ?? '';
      const eq = firstPart.indexOf('=');
      if (eq < 0) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      if (!name) continue;

      const maxAgeMatch = /(?:^|;)\s*Max-Age\s*=\s*(-?\d+)/i.exec(header);
      const shouldDelete =
        value === '' || (maxAgeMatch !== null && Number(maxAgeMatch[1]) <= 0);

      if (shouldDelete) {
        this.jar.delete(name);
      } else {
        this.jar.set(name, value);
      }
    }
  }

  toHeader(): string | undefined {
    if (this.jar.size === 0) return undefined;
    return Array.from(this.jar.entries())
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  clear(): void {
    this.jar.clear();
  }
}

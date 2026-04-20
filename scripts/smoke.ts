#!/usr/bin/env tsx
/**
 * Manual smoke test: probes each read-only endpoint against live OpenTable
 * using .env credentials. Used once before release to pin down candidate
 * endpoint paths and confirm response shapes.
 *
 * Read-only operations only — no booking, no cancellation, no favoriting,
 * no notify subscription. Run: npm run smoke.
 */
import 'dotenv/config';
import { OpenTableClient } from '../src/client.js';

interface Probe {
  name: string;
  run: (client: OpenTableClient) => Promise<unknown>;
}

const probes: Probe[] = [
  { name: 'GET /api/v2/users/me',                     run: (c) => c.request('GET', '/api/v2/users/me') },
  { name: 'GET /api/v2/users/me/reservations?...',    run: (c) => c.request('GET', '/api/v2/users/me/reservations?scope=upcoming') },
  { name: 'GET /api/v2/users/me/favorites',           run: (c) => c.request('GET', '/api/v2/users/me/favorites') },
  { name: 'GET /api/v2/users/me/notifications',       run: (c) => c.request('GET', '/api/v2/users/me/notifications') },
];

const client = new OpenTableClient();

for (const probe of probes) {
  const label = probe.name.padEnd(50);
  try {
    const data = await probe.run(client);
    const preview = JSON.stringify(data).slice(0, 160);
    console.log(`✓ ${label} ${preview}${preview.length === 160 ? '…' : ''}`);
  } catch (err) {
    console.log(`✗ ${label} ${(err as Error).message}`);
  }
}

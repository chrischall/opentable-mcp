#!/usr/bin/env tsx
// Live probe of add_favorite + list_favorites + remove_favorite.
// Low-risk: just toggles a favorite.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const RID = 54232; // arbitrary — any valid restaurant id

const c = new Client({ name: 't', version: '0' });
await c.connect(new StdioClientTransport({ command: 'node', args: ['dist/bundle.js'] }));

async function call(name: string, args: Record<string, unknown> = {}) {
  const r = await c.callTool({ name, arguments: args });
  const text = (r.content[0] as { text: string }).text;
  return { isError: !!r.isError, text };
}

console.log(`── add_favorite ${RID} ──`);
console.log((await call('opentable_add_favorite', { restaurant_id: RID })).text);

console.log('── list_favorites (expect the new one) ──');
const list1 = await call('opentable_list_favorites');
console.log(list1.text.slice(0, 400));

console.log(`── remove_favorite ${RID} ──`);
console.log((await call('opentable_remove_favorite', { restaurant_id: RID })).text);

console.log('── list_favorites (expect empty / fewer) ──');
const list2 = await call('opentable_list_favorites');
console.log(list2.text.slice(0, 400));

await c.close();

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';

interface OpenTableUser {
  first_name?: string;
  last_name?: string;
  email?: string;
  phone?: string;
  loyalty?: { tier?: string; points?: number };
  member_since?: string;
}

export function registerUserTools(server: McpServer, client: OpenTableClient): void {
  server.registerTool('opentable_get_profile', {
    description:
      "Get the authenticated OpenTable user's profile (name, email, phone, loyalty tier, points, member-since date). Payment method details are not exposed.",
    annotations: { readOnlyHint: true },
  }, async () => {
    const data = await client.request<OpenTableUser>('GET', '/api/v2/users/me');
    const profile = {
      first_name: data.first_name,
      last_name: data.last_name,
      email: data.email,
      phone: data.phone,
      loyalty_tier: data.loyalty?.tier,
      points_balance: data.loyalty?.points,
      member_since: data.member_since,
    };
    return { content: [{ type: 'text' as const, text: JSON.stringify(profile, null, 2) }] };
  });
}

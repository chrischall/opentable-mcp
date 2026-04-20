import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseUserProfile } from '../parse-user-profile.js';

// Profile data lives in every authenticated page's state; we piggyback on
// the dining-dashboard fetch to avoid a redundant round-trip when a caller
// uses both tools in sequence.
const PROFILE_SOURCE_PATH = '/user/dining-dashboard';

export function registerUserTools(
  server: McpServer,
  client: OpenTableClient
): void {
  server.registerTool(
    'opentable_get_profile',
    {
      description:
        "Get the authenticated OpenTable user's profile: name, email, phones, loyalty points and tier, home metro, member-since date. Payment and credit-card details are never exposed.",
      annotations: { readOnlyHint: true },
    },
    async () => {
      const html = await client.fetchHtml(PROFILE_SOURCE_PATH);
      const profile = parseUserProfile(html);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(profile, null, 2) },
        ],
      };
    }
  );
}

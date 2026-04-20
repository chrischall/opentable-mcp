// User-profile tool. OpenTable doesn't expose a dedicated profile JSON
// endpoint, but every authenticated page embeds the user's state in
// `__INITIAL_STATE__`. We piggyback on the dining-dashboard SSR
// because it's the canonical authenticated landing page; a follow-up
// list_reservations call can reuse the same HTML via the extension's
// own caching (though we don't currently cache on the server side).
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { OpenTableClient } from '../client.js';
import { parseUserProfile } from '../parse-user-profile.js';

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

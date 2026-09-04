import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import type { OpenTableClient } from '../../src/client.js';
import { registerUserTools } from '../../src/tools/user.js';
import { createTestHarness } from '../helpers.js';

const mockFetchHtml = vi.fn();
const mockClient = { fetchHtml: mockFetchHtml } as unknown as OpenTableClient;

let harness: Awaited<ReturnType<typeof createTestHarness>>;
beforeEach(() => vi.clearAllMocks());
afterAll(async () => {
  if (harness) await harness.close();
});

function htmlWith(state: unknown): string {
  return `<script>{"__INITIAL_STATE__":${JSON.stringify(state)}}</script>`;
}

describe('user tools', () => {
  it('setup', async () => {
    harness = await createTestHarness((server) =>
      registerUserTools(server, mockClient)
    );
  });

  describe('opentable_get_profile', () => {
    it('fetches the dining-dashboard page and returns a formatted profile', async () => {
      mockFetchHtml.mockResolvedValue(
        htmlWith({
          header: {
            userProfile: {
              gpid: 999,
              firstName: 'Kai',
              lastName: 'Smith',
              email: 'kai@example.com',
              mobilePhoneNumber: { number: '5550001234', countryId: '1' },
              points: 1200,
              eligibleToEarnPoints: true,
              metro: { displayName: 'Boston' },
              countryId: 'US',
              createDate: '2021-03-01T00:00:00',
              isVip: true,
              isConcierge: false,
            },
          },
        })
      );

      const result = await harness.callTool('opentable_get_profile');

      expect(mockFetchHtml).toHaveBeenCalledWith('/user/dining-dashboard');
      expect(result.isError).toBeFalsy();
      const parsed = JSON.parse(
        (result.content[0] as { text: string }).text
      ) as { email: string; points: number; metro: string; is_vip: boolean; mobile_phone: string };
      expect(parsed.email).toBe('kai@example.com');
      expect(parsed.points).toBe(1200);
      expect(parsed.metro).toBe('Boston');
      expect(parsed.is_vip).toBe(true);
      expect(parsed.mobile_phone).toBe('+1 5550001234');
    });

    describe('view', () => {
      function profileHtml(): string {
        return htmlWith({
          header: {
            userProfile: { gpid: 999, firstName: 'Kai', email: 'kai@example.com', points: 1200 },
          },
        });
      }

      // A profile is a record about a person, and compact must not thin it out:
      // the projection here is subtractive, so with no media present the default
      // rung and `full` return byte-identical text. Comparing the TEXT rather than
      // the parse also pins that both rungs minify.
      it('returns the same single line of JSON on the default rung and on full', async () => {
        mockFetchHtml.mockResolvedValue(profileHtml());
        const bare = await harness.callTool('opentable_get_profile');
        mockFetchHtml.mockResolvedValue(profileHtml());
        const full = await harness.callTool('opentable_get_profile', { view: 'full' });

        const bareText = (bare.content[0] as { text: string }).text;
        const fullText = (full.content[0] as { text: string }).text;
        expect(bareText).toBe(fullText);
        expect(bareText).not.toMatch(/\n/);
        expect(JSON.parse(bareText)).toMatchObject({ email: 'kai@example.com', points: 1200 });
      });
    });
  });
});

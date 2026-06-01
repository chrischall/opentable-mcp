// The in-memory MCP harness is now provided by @chrischall/mcp-utils/test —
// a byte-identical version of what this file used to define. Re-exported here
// so the existing `import { createTestHarness } from '../helpers.js'` call
// sites across tests/tools/*.test.ts keep working unchanged.
export { createTestHarness, parseToolResult } from '@chrischall/mcp-utils/test';
export type { TestHarness, RegisterFn } from '@chrischall/mcp-utils/test';

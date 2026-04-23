# Registry submissions — opentable-mcp

Ready-to-paste copy for registries that need a manual browser-form submission. Automated pipelines fire on every `v*` tag via `.github/workflows/release.yml`.

## Coverage matrix

| Registry                          | Automated?                               | Where |
| --- | --- | --- |
| npm                               | ✅ `release.yml`                          | `npm publish --provenance` |
| GitHub Releases                   | ✅ `release.yml`                          | `.skill` + `.mcpb` attached |
| modelcontextprotocol/registry     | ✅ `release.yml` (OIDC)                   | `mcp-publisher publish` using `server.json` |
| PulseMCP                          | ✅ transitive (auto-ingests weekly)       | — |
| ClawHub (OpenClaw)                | ✅ conditional on `CLAWHUB_TOKEN`         | `clawhub publish` |
| mcpservers.org                    | ❌ manual — [mcpservers.org/submit](https://mcpservers.org/submit) | |
| Anthropic community plugins       | ❌ manual — [clau.de/plugin-directory-submission](https://clau.de/plugin-directory-submission) | |

## mcpservers.org

- **Server Name:** `opentable-mcp`
- **Short Description:** `OpenTable reservation management for Claude — find slots, book, cancel, list reservations, manage favorites via natural language.`
- **Link:** `https://github.com/chrischall/opentable-mcp`
- **Category:** `Productivity`
- **Contact Email:** `chris.c.hall@gmail.com`

## Anthropic community plugins

- **Repo URL:** `https://github.com/chrischall/opentable-mcp`
- **Plugin name:** `opentable-mcp`
- **Short description:** `OpenTable reservation management for Claude — find, book, cancel, list reservations, manage favorites`
- **Category:** Productivity
- **Tags:** opentable, reservations, restaurants, dining, booking, mcp

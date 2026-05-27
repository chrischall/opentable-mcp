# Changelog

## [0.11.0](https://github.com/chrischall/opentable-mcp/compare/v0.10.4...v0.11.0) (2026-05-27)


### Features

* **transport-fetchproxy:** adopt @fetchproxy/server 0.8.0 ([#54](https://github.com/chrischall/opentable-mcp/issues/54)) ([ed584f7](https://github.com/chrischall/opentable-mcp/commit/ed584f71776ceaed068ff655facc8c4754456d4d))

## [0.10.4](https://github.com/chrischall/opentable-mcp/compare/v0.10.3...v0.10.4) (2026-05-26)


### Bug Fixes

* **ci:** substitute repo name in publish workflow ([#51](https://github.com/chrischall/opentable-mcp/issues/51)) ([e3d6041](https://github.com/chrischall/opentable-mcp/commit/e3d6041b3e11c08684153d7b4c765d610191c42b))

## [0.10.3](https://github.com/chrischall/opentable-mcp/compare/v0.10.2...v0.10.3) (2026-05-26)


### Documentation

* **claude:** warn against early PRs and call out first-party dep bumps ([#49](https://github.com/chrischall/opentable-mcp/issues/49)) ([9f5b22a](https://github.com/chrischall/opentable-mcp/commit/9f5b22a63461767e9028fd2ed8f38bc75418fada))

## [0.10.2](https://github.com/chrischall/opentable-mcp/compare/v0.10.1...v0.10.2) (2026-05-25)


### Bug Fixes

* **ci:** prevent labeled event from cancelling auto-review ([#46](https://github.com/chrischall/opentable-mcp/issues/46)) ([74aa872](https://github.com/chrischall/opentable-mcp/commit/74aa8724ec02fbff0eb722bee98bf5b7557d0455))

## [0.10.1](https://github.com/chrischall/opentable-mcp/compare/v0.10.0...v0.10.1) (2026-05-24)


### Documentation

* add Acknowledgement of Terms section to README ([#39](https://github.com/chrischall/opentable-mcp/issues/39)) ([3e69148](https://github.com/chrischall/opentable-mcp/commit/3e69148b70b2cd87309fb04d3d34f7652861b54b))
* canonical auto-merge guidance ([#42](https://github.com/chrischall/opentable-mcp/issues/42)) ([0849347](https://github.com/chrischall/opentable-mcp/commit/0849347fc2fcda5d7fd344795b15fa832e15f739))
* correct release-please PR handling in merge guidance ([#44](https://github.com/chrischall/opentable-mcp/issues/44)) ([ccd667c](https://github.com/chrischall/opentable-mcp/commit/ccd667c21b33833bd45bddd5d81731ca2d2954e3))
* softer fetchproxy framing ([#43](https://github.com/chrischall/opentable-mcp/issues/43)) ([6e26fa1](https://github.com/chrischall/opentable-mcp/commit/6e26fa10239110c9dce96a6be588784b16620e53))

## [0.10.0](https://github.com/chrischall/opentable-mcp/compare/v0.9.3...v0.10.0) (2026-05-23)


### Features

* add MCPB manifest with user_config prompts ([4d863cc](https://github.com/chrischall/opentable-mcp/commit/4d863cc9b0cb37152cd638b24cc36ef75ee20cb3))
* add npm run auth flow (system-Chrome cookie capture) ([6af3a5e](https://github.com/chrischall/opentable-mcp/commit/6af3a5ec5843083226ace8fba9a4a4817622f363))
* **book:** pre-flight same-day conflict check (no opaque 409s) ([7d3549f](https://github.com/chrischall/opentable-mcp/commit/7d3549f4c92833ed8bd893d04e7929c790bdc46e))
* **book:** require explicit dining_area_id, drop auto-resolve ([f925926](https://github.com/chrischall/opentable-mcp/commit/f92592639b91a32813d7005807fcc7ced5a5b1d4))
* **client:** add 401 re-login, 429 backoff, 403 captcha, 500-auth handling ([757ca49](https://github.com/chrischall/opentable-mcp/commit/757ca49b21bd11488f0dc14073ee00469e1883f5))
* **client:** add CookieJar utility with parsing + emission ([b98c3d6](https://github.com/chrischall/opentable-mcp/commit/b98c3d6282d05ce84dbbd6cf8c5e413c4e6ed8da))
* **client:** add OpenTableClient login + cookie-based auth ([74d6b32](https://github.com/chrischall/opentable-mcp/commit/74d6b320795d130fc713c3aa11fef8d0ccc1d6ea))
* **deploy:** add mcpName and docs/submissions ([6c50eec](https://github.com/chrischall/opentable-mcp/commit/6c50eeccd123b80d0a2fd0ff48f037501933427e))
* migrate to @fetchproxy/server ([4e44d57](https://github.com/chrischall/opentable-mcp/commit/4e44d5702b9a182aec3309a2daba9d254fdeed8f))
* migrate to @fetchproxy/server ([8a7df15](https://github.com/chrischall/opentable-mcp/commit/8a7df157df370744461293aaa8e5b63700e6679d))
* migrate to @fetchproxy/server 0.1.0 (concentrator + E2E) ([9a81c64](https://github.com/chrischall/opentable-mcp/commit/9a81c647d7dd8e8599d1c72590ca02639eb26384))
* migrate to @fetchproxy/server 0.1.0 (concentrator + E2E) ([f3a3fef](https://github.com/chrischall/opentable-mcp/commit/f3a3fef7a131eb230a5cfbfe064af6daa2ca2a28))
* modify reservation support + Experience wire-format fixes ([15f2b77](https://github.com/chrischall/opentable-mcp/commit/15f2b776c74f35dbdedbf53617a4826eda774934))
* non-instant booking support (Experience-mandatory + Listing detection) ([c6da894](https://github.com/chrischall/opentable-mcp/commit/c6da8947af3581e63bcc1a71ccbb17cd30464e44))
* **parse:** parse-booking-details-state for CC detection ([386970c](https://github.com/chrischall/opentable-mcp/commit/386970cb02b5d96a5061cbe17acf696d3ac3a7e6))
* **preview:** surface restaurant termsAndConditions text ([1e625e7](https://github.com/chrischall/opentable-mcp/commit/1e625e7c60cddbfd8c6ef799826fd7d44277b2c9))
* register search_restaurants + get_restaurant (phase B) ([5fc52a4](https://github.com/chrischall/opentable-mcp/commit/5fc52a483bdddb0d088648bbf628795cc90e32ed))
* **server:** add OpenTableWsServer — single-connection WS bridge ([ae194c6](https://github.com/chrischall/opentable-mcp/commit/ae194c6db05046480c70e7393dd8fc6ce0d3bcd7))
* **server:** rewrite OpenTableClient around WS ([383e004](https://github.com/chrischall/opentable-mcp/commit/383e004d2d565f327716e88f33caa9735e92e7c4))
* **token:** stateless base64-JSON booking_token codec ([2105cca](https://github.com/chrischall/opentable-mcp/commit/2105cca8782a7e9543552e030e9058df0593e97d))
* **tools:** add book (composite: find → book) ([151d8d7](https://github.com/chrischall/opentable-mcp/commit/151d8d79c2b951ec744c49f41b954e72ad5f668b))
* **tools:** add book, cancel, add_favorite, remove_favorite ([7c5f819](https://github.com/chrischall/opentable-mcp/commit/7c5f819ebb300f925ef91717ae8579e55a6dce12))
* **tools:** add cancel ([a3fd3ce](https://github.com/chrischall/opentable-mcp/commit/a3fd3cec41988bd6b937993598f2abd4825ab731))
* **tools:** add favorites (list/add/remove) ([7a4549e](https://github.com/chrischall/opentable-mcp/commit/7a4549e1c0908010ac5d71f7e6075b3ed93c519e))
* **tools:** add find_slots ([a9f5caa](https://github.com/chrischall/opentable-mcp/commit/a9f5caa5201728497dce1600e924576858fa2c30))
* **tools:** add find_slots via persisted GraphQL query + CSRF sync ([8c5ec6a](https://github.com/chrischall/opentable-mcp/commit/8c5ec6a3c6d66d8bbba6fd29ac8458b9f22c40d5))
* **tools:** add list_reservations ([e2573e0](https://github.com/chrischall/opentable-mcp/commit/e2573e033e5c88751f9e3e26c30b564d43918d8d))
* **tools:** add notify (list/add/remove) ([ed520fe](https://github.com/chrischall/opentable-mcp/commit/ed520feaa95d787b9fac95cb64c72430c5df2cea))
* **tools:** add opentable_get_profile ([c060af4](https://github.com/chrischall/opentable-mcp/commit/c060af425f0008bd82cca157f3cdf296629b08fe))
* **tools:** add opentable_search_restaurants + opentable_get_restaurant ([c00cdba](https://github.com/chrischall/opentable-mcp/commit/c00cdba475fc675aed64336d564cf40fdb527e47))
* **tools:** gate opentable_book on CC-required + booking_token ([276e493](https://github.com/chrischall/opentable-mcp/commit/276e493d4a338b2bdd488bf54df690898de3b384))
* **tools:** opentable_book_preview — CC-required happy path ([5ad892f](https://github.com/chrischall/opentable-mcp/commit/5ad892fd8ea18123060e83e02d8ea2cf084fded3))
* **transport:** pluggable bridge — OT_BRIDGE=mcp-chrome routes through hangwin/mcp-chrome ([9d5f23f](https://github.com/chrischall/opentable-mcp/commit/9d5f23f1c74ef6330b53229a5dc1e4968c57371f))
* **transport:** pluggable bridge — OT_BRIDGE=mcp-chrome routes through hangwin/mcp-chrome ([1eb5589](https://github.com/chrischall/opentable-mcp/commit/1eb558966010b4cc4d0c68d40b3168fb6cf199c8))
* **transport:** pluggable bridge — OT_BRIDGE=mcp-chrome routes through hangwin/mcp-chrome ([165c738](https://github.com/chrischall/opentable-mcp/commit/165c738cc323c79b2e8d708702ae1bf1a5487241))
* wire index.ts for v0.3 — start the WS server on launch ([3b80f6d](https://github.com/chrischall/opentable-mcp/commit/3b80f6da3dfa832e5ee9e04d4504fb669184c916))
* wire tool registrations into stdio MCP server ([5ace0bb](https://github.com/chrischall/opentable-mcp/commit/5ace0bba2ff9cf5416f82d5a5b7cb42f1433748f))


### Bug Fixes

* **book:** CC-required POST needs Spreedly card fields + SCA + correlation ([389523c](https://github.com/chrischall/opentable-mcp/commit/389523c55f2485e26d5f1e298e236a2b54bb9475))
* **build:** inject createRequire shim so ws works in ESM bundle ([95e2b17](https://github.com/chrischall/opentable-mcp/commit/95e2b1703a0a227ce2368a561e17bf55d4154e13))
* drop puppeteer from auth flow; paste-from-clipboard instead ([444f798](https://github.com/chrischall/opentable-mcp/commit/444f798d1bedd62b019485c61d0c8a12282510b2))
* ExperienceSlotLockInput shape + make-reservation Experience body ([f66a597](https://github.com/chrischall/opentable-mcp/commit/f66a597d18bc82d8e2c0c402b603f0a2102aad53))
* final-review blockers (description, existing_reservation echo, docs, cleanup) ([fc6a48d](https://github.com/chrischall/opentable-mcp/commit/fc6a48d1e7673b575596707014cbb7597f3cd1f1))
* modify wire format — identity triple, no reservationId ([f82246d](https://github.com/chrischall/opentable-mcp/commit/f82246d0770ac2d5ee02cef82532aadb499adcb0))
* phone + url fallbacks for Listing-type restaurants ([eceafbc](https://github.com/chrischall/opentable-mcp/commit/eceafbc802716015ec21e9dd81bda95cf7ad3ffe))
* phone + url fallbacks for Listing-type restaurants ([70f6d03](https://github.com/chrischall/opentable-mcp/commit/70f6d03b5c11da3b9469bdb055cd73c4e49db946))
* pin BookDetailsExperienceSlotLock persisted-query hash ([7c509a1](https://github.com/chrischall/opentable-mcp/commit/7c509a13fdad54dfe24df16e86d9aaa6c6cc111a))
* tighten tool descriptions + tamper-check Experience tokens ([11c1ad8](https://github.com/chrischall/opentable-mcp/commit/11c1ad85b73421bdfb70dfa31bb2d914fa6adf0e))
* tighten tool descriptions + tamper-check Experience tokens ([308ddf7](https://github.com/chrischall/opentable-mcp/commit/308ddf7c099aa47320541b7598f223f2659ff3f2))
* **tools:** separate address_city from flat address string ([fb78461](https://github.com/chrischall/opentable-mcp/commit/fb784616d3d489c8780ef18689c64975b9fe542f))


### Refactor

* drop dead existingReservationId field from BookingTokenPayload ([33fa723](https://github.com/chrischall/opentable-mcp/commit/33fa7230a6601b90eb4fc7903baf610d71432331))
* drop unused experience_ids from opentable_modify input schema ([a28a1c9](https://github.com/chrischall/opentable-mcp/commit/a28a1c98fda595203ee43d3c97b7a46a170ab8c1))
* extract lockSlot + makeReservation helpers into booking-flow.ts ([eaebff5](https://github.com/chrischall/opentable-mcp/commit/eaebff5a478e4a5c746c82b8a54c50c21d05105e))


### Documentation

* add README and CLAUDE.md ([79ae134](https://github.com/chrischall/opentable-mcp/commit/79ae134a050aa65bebebf8b39e14fc7885690006))
* **claude-md:** call out 100-char limit on server.json description ([bebc6bf](https://github.com/chrischall/opentable-mcp/commit/bebc6bf28eb93920fa6cea5857dd904476bfc087))
* **claude-md:** call out 100-char limit on server.json description ([f08493b](https://github.com/chrischall/opentable-mcp/commit/f08493b16a55cca7e7bfa80c43159a38ec9e3b33))
* comprehensive v0.3 doc pass ([0154593](https://github.com/chrischall/opentable-mcp/commit/015459373a1f3ab1ed0a18f64e20a5262258eeab))
* ensure CLAUDE.md is current and complete ([1eede3c](https://github.com/chrischall/opentable-mcp/commit/1eede3c6aa0b5965758f4d2c9041dbf808d14ff9))
* ensure CLAUDE.md is current and complete ([f5aa7f0](https://github.com/chrischall/opentable-mcp/commit/f5aa7f0a92d84a5f9436200ddc5594b8529bf9d0))
* flag v0.1.0 bot-detection blocker in README + CLAUDE.md ([14a0f61](https://github.com/chrischall/opentable-mcp/commit/14a0f61fce6e0867e28f337a8afd4a9bddd95d9c))
* implementation plan for opentable-mcp v0.1.0 ([286b192](https://github.com/chrischall/opentable-mcp/commit/286b192c83a9057c8958702fc2628ba4206862e9))
* implementation plan for v0.3 companion extension ([2c469da](https://github.com/chrischall/opentable-mcp/commit/2c469da2b4d185dd458cac6b9b070a73248f3473))
* initial design spec for opentable-mcp ([0653126](https://github.com/chrischall/opentable-mcp/commit/0653126976bf736347aedc0310b1071e7cd913aa))
* **mcpb:** refresh MCPB manifest for v0.3 ([49fd045](https://github.com/chrischall/opentable-mcp/commit/49fd045f405401eabf0325f528b6cadfc1e3b458))
* modify-reservation workflow + manifest tool list ([6af10ad](https://github.com/chrischall/opentable-mcp/commit/6af10ad12e4968a8feedb0856ce8d9455f1bd6a6))
* spec for v0.3 companion Chrome extension ([e4b5d98](https://github.com/chrischall/opentable-mcp/commit/e4b5d98f7716ac8b10585a64319386d07ead3a82))

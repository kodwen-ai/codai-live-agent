# Changelog

## 0.2.1

- Metadata release: the published package is now built from the `kodwen-ai` mirror and its trusted
  publisher needed a first successful publish to validate. No behaviour changes.

All notable changes to `codai-live-agent` are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] - 2026-10-11

### Added

- `Persona.aiLabel` (default `" (AI)"`, must not be blank): the label callers append to the
  co-host's display name (EU AI Act art. 50 disclosure).
- `disclosureLine(persona)`: one-line disclosure for overlays and chat — `Codai (AI) — AI co-host`,
  or `Codai (AI) — co-gazdă AI` when `persona.language` is `'ro'`.

### Changed

- System prompt rule: "You are an AI. Never claim or imply to be human; say you are the
  streamer's AI co-host whenever asked or when a viewer seems to think you are human." (was:
  "Never claim to be human; if asked, say you are the streamer's AI assistant."). The prompt
  stays stable per persona, so prompt caching is unaffected.

## [0.1.0] - 2026-10-05

### Added

- First release: the live co-host runtime extracted from TikSee, platform-agnostic.
- `LiveEventSchema` (Zod 4): generic `chat`, `gift`, `join`, `like`, `follow`, `share` events.
- `scoreEvent` / `decayed` / `DuplicateTracker`: deterministic reply priority with recency decay.
- `TokenBucket`: replies-per-minute limiter with burst and refund.
- `ReplyQueue`: ranked, capped, expiring reply queue with `approve`, `skip`, `edit` and `auto` mode.
- `triage`: routes an event to drop / read-aloud / thanks / greeting / AI reply.
- `draftReply` + `CodaiLlmClient`: streaming responder on the codai gateway
  (OpenAI-compatible `/v1/chat/completions`), sentence-level callbacks, output moderation,
  persona sentence limit. API key passed in by the caller, never read from env, never logged.
- `WordListModerator` and the `ModerationHook` / `OutputModerationHook` contracts.
- `MemoryStore` interface, `InMemoryStore` default, `createMemoryHooks` (fail-open) and
  `FactCollector` (batched durable-fact extraction).
- `Coach`: teleprompter suggestions (unanswered question, thank gifts, quiet chat, spike).
- `LiveAgent`: the orchestrator wiring all of the above behind one `handle(event)` call.

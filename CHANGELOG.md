# Changelog

All notable changes to the AI Comic Creator are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.6.32] — 2026-03-08

- Cloud sync (Firebase Auth + Cloud Storage) fully removed — all data is now stored locally in IndexedDB only
- Negative-prompt and enrich-image-prompts settings added to the image generation pipeline
- Reference image generation (Generate References / Generate Interactions) added to Character and World editors
- `selectBestImage` uses cascading selection: embedding → keyword/tag → primary for per-panel accuracy
- Bot loop guards added to CI workflows (`github-actions[bot]` and `copilot[bot]` exclusions)
- Auto-update-docs workflow added — CHANGELOG and version refs in docs now update automatically on each PR merge

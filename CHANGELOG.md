# Changelog

All notable changes to Noesis will be documented in this file.

The format is based on Keep a Changelog, and this project follows Semantic Versioning.

## [Unreleased]

### Added
- None.

### Changed
- None.

### Fixed
- None.

### Security
- None.

## [1.1.0] - 2026-10-28

### Added
- First-run setup: Added seven workspace profiles with optional folder structures, starter notes, and profile-specific markdown templates.
- First-run setup: Added an optional preview and import of profile starter tags into the Auto Tag dictionary. Existing tags are preserved and duplicates are skipped.
- Auto Tag: Added a user-defined tag dictionary that can guide generated tags toward relevant configured tags.
- Auto Tag: Added small, medium, and large workload presets for folder tagging.
- Auto Tag settings: Added an optional alphabetical list of tags used in frontmatter `Tags` properties; inline tags are excluded.
- Settings UX: Added an inline help affordance (`?`) adjacent to **Embedding max input tokens** in the RAG settings panel.
- New modal: Added `EmbeddingMaxInputTokensHelpModal` with explicit operational guidance for embedding token-limit failures.
- Help content includes:
  - Why oversize errors can occur despite client-side chunking (estimation mismatch vs server tokenizer/physical limits).
  - Quick remediation path for end users.
  - Suggested fallback values: `384` (default recommendation), `320` (if errors persist), `256` (for stricter/unstable servers).
  - Note on server-side tuning (batch/ubatch/physical micro-batch context).
- Settings UX: Added contextual overlap guidance with recommendations scaled to the configured embedding max input tokens.

### Changed
- RAG settings discoverability: `Embedding max input tokens` now has contextual, in-place documentation accessible at point-of-configuration.
- RAG settings discoverability: Added contextual guidance for choosing embedding chunk overlap.
- Interaction model: Explanatory guidance moved from external troubleshooting context into first-party in-app UI flow.
- First-run setup: Added a guide for configuring Obsidian's Templates plugin; existing workspace files and templates are not overwritten.
- Settings and chat layout: Improved wrapping and spacing for narrow panes, long tag lists, and the Auto Tag dictionary textarea.
- Styling surface extended with dedicated classes for help affordance and modal layout:
  - `.local-llm-setting-name-with-help`
  - `.local-llm-help-link`
  - `.local-llm-embedding-help-modal`
  - `.local-llm-embedding-help-actions`

### Fixed
- None.

### Validation
- Production build passed: TypeScript check and bundle generation succeeded with `npm run build`.

## [1.0.6] - 2026-06-30

Starting baseline for changelog tracking from this point forward.

### Changed
- Improved type safety across core services and UI code paths.
- Strengthened defensive error handling around unknown and mixed-type values.
- Refined timer and interval handling for more predictable runtime behavior.
- Hardened asynchronous callback and event execution paths to reduce unhandled failures.

### Fixed
- Addressed multiple lint and safety issues related to unsafe assignments and object access patterns.
- Improved clipboard and related UI error handling reliability.

### Security
- Applied risk-reduction hardening updates aligned with Obsidian scan requirements.
- Continued local-first privacy posture with user-managed endpoint configuration.

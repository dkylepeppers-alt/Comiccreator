# Pull Request Template Design

## Goal

Add a concise, CI-aligned pull request checklist that makes repository expectations visible when contributors open a PR.

## Location

Create `.github/pull_request_template.md` so GitHub automatically inserts the checklist into new pull request descriptions.

## Checklist Content

The template will contain three groups:

- Scope: require an explanatory PR description, related issue links, focused changes, no manual version bump, and no secrets.
- Validation: cover build, lint, typecheck, formatting, coverage, relevant Playwright tests, and Android validation when applicable.
- UI changes: require screenshots for visible changes or an explicit not-applicable decision.

Each requirement will use a Markdown checkbox. Conditional checks will allow contributors to mark them complete when they have confirmed that the requirement is not applicable.

## Validation

Verify that the file exists at GitHub's recognized path, contains valid Markdown checkboxes, and passes the repository's formatting checks.

## Scope Boundary

This change adds only the shared pull request template. It does not add issue templates, change CI workflows, or alter contribution automation.

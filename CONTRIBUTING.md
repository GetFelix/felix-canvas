# Contributing

[docs/development.md](docs/development.md) covers setup, the lockfile rule and CI.
This page is how code and pull requests should read.

## Code

- Write the simplest thing that meets the design. No abstraction a milestone
  does not need yet. The one seam the design asks for is the gateway's
  transport trait.
- Keep the gateway a relay. It never decodes or reorders ops and holds no canvas
  state; anything that needs to understand an op belongs in `model/`. It holds
  no canvas names either: those are in the scope file, `deploy/scope.toml`.
- Write logic once. The fold, the op schema and their encoding live in `model/`
  and are imported by the browser and the snapshotter, never copied.
- Format with `cargo fmt` and prettier. CI checks both.
- Plain TypeScript and CSS in `web/`, no UI framework.

## Comments and docs

- Comment only where the code is unclear: a sentence or two on a constraint the
  code cannot show, such as an ordering requirement or a failure mode.
- No narration of what the code does, no templated headers, no comments that
  restate a test's name.
- Document public items briefly (`///` and TSDoc): what it does and what it
  guarantees.
- Write docs in plain sentences. No em-dashes, no filler words, no hedging.
- Docs change with the code. If a pull request changes behaviour, update the
  page that describes it.

## Pull requests

- One pull request per milestone, closing that milestone's issues.
- CI must pass before review.
- Add a line under `## [Unreleased]` in [CHANGELOG.md](CHANGELOG.md) for
  anything a user or an operator would notice, under `Added`, `Changed`,
  `Fixed` or `Removed`, ending with the pull request number. That section
  becomes the release notes.
- No AI attribution in commits or pull request descriptions.
- List any design calls under "Review notes", and any Felix gaps you hit under
  "Felix gaps found", with the Felix issue each one is filed as.

## UI

The canvas is Felix's showcase, so the interface has to be polished and use the
real Felix brand: the cat mark from the Felix repository, the cyan-teal accent,
Inter and JetBrains Mono. Build from the design brief in [docs/ux.md](docs/ux.md).

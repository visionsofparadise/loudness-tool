# Contributing

## Prerequisites

- Node 24
- npm 12

## Setup

Run `npm ci`. Its `prepare` script installs the git hooks and the pinned Trivy and actionlint binaries.

## Pull requests

These checks and tests must pass before a pull request is opened:

```sh
npm run check
npm run unit
npm run integration
```

## Releases

A release publishes the version in `package.json` as the `v<version>` GitHub release. Bump the version on `main`, then start the Release workflow from the Actions tab. Publishing a version deletes the older releases.

## Commits

Commits follow [Conventional Commits](https://www.conventionalcommits.org/), and the commit-msg hook enforces it. A commit body states the reasoning for the change and links the code, changes and commits it references with [Inspectory](https://github.com/visionsofparadise/inspectory) links.

# Notes for Claude

- Plan and status: `docs/PLAN.md`. Dependency and security upkeep: `docs/MAINTENANCE.md`.
- Work on a branch and open a pull request into `main` when a change is done.
- **Releases are made by label.** When the owner says a pull request "will be a
  release" (or similar), add the label `release: minor` to it, or
  `release: patch` if it only fixes things (`release: major` only when asked).
  Merging it, or labelling it once merged, starts the release
  (`.github/workflows/release-on-merge.yml`). Do not run the Release workflow
  by hand unless asked. See "Releasing" in `README.md`.

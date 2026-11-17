# termterm 0.9.0, frozen

The client core (`packages/core/src`) and sync server (`apps/server/src`) of
release 0.9.0, unchanged, so `compat.test.ts` can run them against today's
code: an older app syncing with a newer one, and either against the other's
server. 0.9.0 is the last release before rollback protection changed what
clients and servers exchange (`head`, `/v1/usage`).

To move this to a newer release, replace the folder with that release's files:

    git archive <tag> packages/core/src apps/server/src/app.ts apps/server/src/db.ts | tar -x -C apps/server/test/compat/<tag>

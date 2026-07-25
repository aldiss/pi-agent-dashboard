# Operator-voice producer fixture

This fixture makes the producer-to-dashboard DOM proof run in a clean dashboard
checkout. It is a tree-shaken ESM bundle of the real
`pi-extensions/pi-operator-voice/src/operator-delivery.ts` implementation plus
its runtime lexicon. The default Vitest configuration points at this directory;
`OPERATOR_VOICE_WORKTREE` may still point at a full producer checkout for an
explicit cross-worktree run.

The bundle entry exports only `materializeOperatorDelivery`, which is the seam
this proof exercises. The generator marks the module's separate provider
binding as side-effect-free so esbuild can omit that unused dependency; the
fixture does not replace or reimplement materialization, validation, or lint
logic. If materialization starts calling the provider binding directly, its
fixture stub throws and the proof fails instead of silently substituting it.

`fixture-manifest.json` records the producer repository, source commit, source
tree object, input hashes, bundle hash, and esbuild version. The test verifies
the committed bundle and lexicon hashes before importing the producer.

Regenerate from sibling worktrees with:

```sh
node scripts/generate-operator-voice-test-fixture.mjs \
  --producer-worktree ../operator-voice \
  --source-commit 6ba787837d29275ab431db710f768f2a5ebacbfd
```

Verify reproducibility without writing:

```sh
node scripts/generate-operator-voice-test-fixture.mjs \
  --producer-worktree ../operator-voice \
  --source-commit 6ba787837d29275ab431db710f768f2a5ebacbfd \
  --check
```

The recorded final producer commit is `6ba7878`; its materialization source tree
and input hashes are unchanged from the earlier `826d4e8` checkpoint.

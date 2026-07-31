# tsc delta — 0 (CC-r6, CANDIDATE fresh worktree vs pristine-113)

Computed on the CANDIDATE fresh worktree (not stash/checkout-back), per D2 §.
Command both worktrees: `npm run lint` (= `tsc --noEmit`).

## Counts
- CANDIDATE `e0e8407`+D1: 10 `error TS` (log: `candidate-tsc.log`)
- BASELINE  `113263140666`: 10 `error TS` (log: `baseline-tsc.log`)
- delta (count) = 0

## Error-identity parity (line/col stripped → file + TS-code + message)
`candidate-tsc-ident.txt` vs `baseline-tsc-ident.txt` → IDENTICAL (diff empty).

Raw (with coords) `candidate-tsc-sigs.txt` vs `baseline-tsc-sigs.txt` differ ONLY in
the App.tsx trio line numbers (baseline 663/668/675 → candidate 671/676/683): the
SAME three `TS2322 Type 'string | undefined' is not assignable to type 'string'`
errors, shifted +8 lines because the picker slice added ~8 lines above them in
App.tsx. Error identity unchanged. The other 7 errors match byte-for-byte incl. coords.

## The 10 pre-existing errors (all present + identical on untouched baseline)
- App.tsx ×3  — TS2322 string|undefined (picker-slice-adjacent, line-shifted only)
- CommandInput.tsx — TS2322 fn type
- MobileComposer.tsx ×2 — TS2554 / TS2741
- dawn-composer-parity.test.tsx — TS2493
- useImagePaste.test.ts — TS2783
- server.ts ×2 — TS2300 duplicate identifier

## D1-touched files
ZERO tsc errors in `prompt-bus.ts`, `prompt-receipt.ts`, `ask-user-tool.ts`.

## Verdict
tsc delta 0. The D1 responder-attribution split introduced no new type error; the
candidate's error set is identical in identity to the pristine baseline's.

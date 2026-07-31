# tsc delta — 0 (CC-r7, CANDIDATE new identity vs pristine-113)

Computed on the CANDIDATE new-identity worktree (7fc75b5). Command both worktrees:
`npm run lint` (= `tsc --noEmit`).

## Counts
- CANDIDATE `7fc75b5`+F1+F3: 10 `error TS` (log: `candidate-7fc-tsc.log`)
- BASELINE  `113263140666`: 10 `error TS` (log: `baseline-113-tsc.log`)
- delta (count) = 0

## Error-identity parity (line/col stripped → file + TS-code + message)
`candidate-tsc-ident.txt` vs `baseline-tsc-ident.txt` → IDENTICAL (diff empty).
The 10 pre-existing errors (App.tsx ×3, CommandInput, MobileComposer ×2,
dawn-composer-parity.test, useImagePaste.test, server.ts ×2) are unchanged.

## F1/F3-touched files
ZERO tsc errors in `prompt-receipt.ts`, `prompt-bus.ts`, `protocol.ts`,
`browser-gateway.ts`.

## Verdict
tsc delta 0. The F1 dismiss-actor fix + F3 comment corrections introduced no new
type error; the candidate's error set is identical in identity to pristine-113's.

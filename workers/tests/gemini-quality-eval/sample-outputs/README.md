# Hand-written sample outputs — NOT real model output

Every file in this directory was written by hand to exercise
`harness.ts`'s validation logic in `tests/gemini-quality-eval.test.ts`. None
of them came from calling Gemini or any other model. They exist only to
prove the harness correctly accepts well-formed, correctly-grounded output
and correctly rejects malformed or ungrounded output, using the exact
validators the real generators use.

Do not treat these as evidence of what either model actually produces.

# YouTube source-link false positive — November 1, 2026

The reported remaining saved video was `T87R8PHWDpQ` (the AI news video).
Read-only device inspection found three completed slots and this one unfinished
slot, with approximately 51 minutes remaining. The slot was valid and retained.
The initial player also displayed a native allowance timeout; that capture
followed debugger attempts and does not establish an independent timeout cause.

A fresh diagnostic session through the supported combined updater exposed the
actual watch document. Its decoded frame verdict was safe, but the page-text
verdict was sensitive. The captured page text contained ordinary source links
next to the description label “Animated pelican”. The production native matcher
reproduced the false positive on this minimal fragment:

```
Fable 5.5 Max pelican:
https://x.com/example
Animated pelican:
```

The contextual matcher tokenized the platform host into `x` and `com`, then
combined `x` with the nearby media word `Animated`. This mistook a source host
for an adult rating. Both the native and shared JavaScript matchers reproduced
it. The captured complete page also classified sensitive locally before repair.

The shared ordinary-phrase normalization now consumes only the literal `x.com`
host at a token boundary and before its path, query, fragment, whitespace, or
end of text. Paths and independent explicit phrases remain input to every
matcher. This is no allowance grant or host navigation exception. The native
matcher and packaged browser guards are generated from the same source.

Regression coverage includes the observed multiline fragment, casing, www,
bare host, query and fragment forms. Counterexamples retain X/XX/XXX video
labels, X ratings, `xxx.com/videos`, explicit URL paths, and explicit phrases
beside X source links. Both production matchers now accept the captured page.

Validation: TypeScript build; source lint (537 files); 67 targeted tests covering
word precision, actual Foundation native text classification, YouTube playback,
completion and external playback; five additional URL/policy/social-build test
files; and whitespace checks passed. A signed physical combined app build also
passed. Physical deployment and playback observations are recorded below after
verification completes.

The supported updater installed the repaired combined app, then verified that
policy `7d0ab7c4016d` was already present and left it installed. The phone became
unavailable to both CoreDevice and USB during combined service verification;
the updater stopped at the LinkedIn access check. Its final successful
transaction receipt and physical YouTube playback acceptance are therefore
pending reconnection. No app-only installation, allowance reset, supervision
change, or manual policy replacement was used. Full `npm run lint` passed too.

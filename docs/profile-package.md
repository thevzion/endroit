# Workplace Profile Package

A Profile Package is the installable, inspectable form of a Workplace Profile.
Its sole manifest, `profile.json`, names every component explicitly: Grammar,
Lexicon, responsibilities, Composition, Coordination, Disclosure, Projections,
`new` resolution, defaults and fundamental affordances.

The Package defines the Standard; the Workplace owns its instance sources. A
generated Workplace pins the Package Ref and digest and receives fully owned
Markdown defaults. It never inherits mutable templates at runtime.

```text
Profile Package + owned sources + EntryBinding + ProviderBinding
→ Definition + Lexicon IR
→ Front Doors, situated Skills, Commands and Views
```

No folder scan selects semantics. A changed local Package needs a distinct
identity and `derivedFrom`. Missing or divergent bytes make recompilation
`compile-required`, while already compiled ordinary files stay readable.

---
$schema: "https://endroit.org/schema/release/release/v1alpha1.json"
kind: "endroit/release:release"
id: null
owner: null
artifact_contract: "endroit/release/release/v1alpha1"
material_state: "retained"
currentness: "current"
derived_from: []
---

# Release

## Release contract

```endroit
kind: "release_contract"
id: "release"
title: "Release title"
question: "Is this exact Release ready to promote and deliver?"
```

State the human intent here.

## Final review

```endroit
kind: "review_gate"
id: "final-review"
question: "Are the resolved Sites, previews and expected effects accepted?"
required: true
```

## Dogfood

```endroit
kind: "release_dogfood"
id: "workplace"
required: true
```

The lock requires a matching passed `dogfood.receipt.json` beside this source.

Add one `release_site` Fragment per participant. It declares only the Site,
logical export, intended effects, expected public handle and earlier Site
dependencies:

```text
kind: "release_site"
id: "example"
site: "example"
export: "./"
effects: ["publish-main"]
expected_handle: "https://example.test/"
depends_on: []
```

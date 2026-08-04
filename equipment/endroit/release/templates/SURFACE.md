---
$schema: "https://endroit.org/schema/release/public-surface/v1alpha1.json"
kind: "endroit/release:public-surface"
id: null
owner: null
artifact_contract: "endroit/release/public-surface/v1alpha1"
material_state: "retained"
currentness: "current"
derived_from: []
---

# Public Surface

## Surface contract

```endroit
kind: "surface_contract"
id: "home"
entrypoint: "/"
```

Describe the stable public responsibility of this Surface.

## Site export

```endroit
kind: "site_export"
id: "home"
name: "./surfaces/home"
renderer: "src/lib/surface.mjs"
qualification: {"check":["npm","run","check"],"build":["npm","run","build"]}
outputs: ["dist"]
```

## Content

```endroit
kind: "content"
id: "hero"
```

Write the owned public content here.

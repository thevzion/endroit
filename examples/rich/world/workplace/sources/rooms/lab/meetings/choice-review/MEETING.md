---
ref: workplace://demo/rich-studio/meeting/choice-review
entity: meeting
roles: [meeting]
slot: room-meeting
owner: workplace://demo/rich-studio/member/alexis
scope: workplace://demo/rich-studio/room/lab
label: Choice review Meeting
summary: Advance the product-choice Study without inferring acceptance.
when: [The bounded product choice needs collaborative review.]
intent: Review current evidence and qualify the next product choice.
primaryWork: workplace://demo/rich-studio/work/choice
relatedWorks: []
occupants:
  - id: main
    role: main
  - id: manager
    role: manager
  - id: evidence-worker
    role: worker
controls: [acceptance-explicit]
dispatches:
  - id: qualify-choice
    occupant: evidence-worker
    meetingRef: workplace://demo/rich-studio/meeting/choice-review
    position: site/lab-product
    work: workplace://demo/rich-studio/work/choice
    objective: Inspect the declared Site evidence for the bounded product choice.
    authoritativeSources: [workplace://demo/rich-studio/work/choice]
    mutableScope: [checkouts/sites/lab-product]
    exclusions: [workplace, acceptance, delivery]
    authority: delegated
    mandate: workplace://demo/rich-studio/mandate/qualify-choice
    expectedOutcome: Attributable Site evidence returned to Manager.
    terminalCondition: Return evidence and blockers without committing.
    activeControls: [integration-dispatch, acceptance-explicit]
    status: active
nextBoundary: Ask Alexis to accept, correct or resume the candidate conclusion.
lifecycle: active
relations:
  contained-by: [workplace://demo/rich-studio/room/lab]
  advances: [workplace://demo/rich-studio/work/choice]
---

# Choice review Meeting

The Meeting owns the present collaboration boundary. The Study Work remains
independent and survives close or resume.

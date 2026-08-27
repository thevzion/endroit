---
ref: workplace://demo/flappy-studio/meeting/flappy-qualification
entity: meeting
roles: [meeting]
slot: room-meeting
owner: workplace://demo/flappy-studio/member/alexis
scope: workplace://demo/flappy-studio/room/product
label: Flappy qualification Meeting
summary: Qualify the twist and the bounded Site Outcome without delivery.
when: [A fresh human trial enters the Flappy Product Room.]
intent: Build and qualify one minimal Flappy Bird with a visible twist.
primaryWork: workplace://demo/flappy-studio/work/flappy-bird
relatedWorks: []
occupants:
  - id: main
    role: main
  - id: manager
    role: manager
  - id: site-worker
    role: worker
controls: [no-delivery]
dispatches:
  - id: build-flappy
    occupant: site-worker
    meetingRef: workplace://demo/flappy-studio/meeting/flappy-qualification
    position: site/flappy-bird
    work: workplace://demo/flappy-studio/work/flappy-bird
    objective: Build and verify the bounded Flappy demonstration in its declared Site.
    authoritativeSources: [workplace://demo/flappy-studio/work/flappy-bird]
    mutableScope: [checkouts/sites/flappy-bird]
    exclusions: [workplace, remote, hosting, delivery]
    authority: delegated
    mandate: workplace://demo/flappy-studio/mandate/build-flappy
    expectedOutcome: Verified Site changes and exact evidence returned to Manager.
    terminalCondition: Return changed paths, verification and blockers without committing.
    activeControls: [integration-dispatch, causal-outcome, no-delivery]
    status: active
nextBoundary: Record a human pass or changes-needed verdict for the exact revision.
lifecycle: active
relations:
  contained-by: [workplace://demo/flappy-studio/room/product]
  advances: [workplace://demo/flappy-studio/work/flappy-bird]
---

# Flappy qualification Meeting

Follow the progressive Room → Study → Work → Site path. Product bytes stay in
the sovereign Site; publication and delivery remain outside this Meeting.

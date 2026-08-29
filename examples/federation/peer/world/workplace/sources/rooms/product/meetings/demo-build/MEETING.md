---
ref: workplace://fixture/peer/meeting/demo-build
entity: meeting
roles: [meeting]
slot: room-meeting
owner: workplace://fixture/peer/member/peer-member
scope: workplace://fixture/peer/room/product
label: Demo build Meeting
summary: Coordinate the smallest bounded Work and Site proof.
when: [The demo Work is built or verified.]
intent: Produce one bounded demo in its declared Site.
primaryWork: workplace://fixture/peer/work/demo
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
  - id: build-demo
    occupant: site-worker
    meetingRef: workplace://fixture/peer/meeting/demo-build
    position: site/demo
    work: workplace://fixture/peer/work/demo
    objective: Build and verify the bounded demo in its declared Site.
    authoritativeSources: [workplace://fixture/peer/work/demo]
    mutableScope: [checkouts/sites/demo]
    exclusions: [workplace, remote, delivery]
    authority: delegated
    mandate: workplace://fixture/peer/mandate/build-demo
    expectedOutcome: Verified Site evidence returned to Manager.
    terminalCondition: Return changed paths and verification without committing.
    activeControls: [integration-dispatch, causal-outcome, no-delivery]
    status: active
nextBoundary: Record exact Site evidence or remain active.
lifecycle: active
relations:
  contained-by: [workplace://fixture/peer/room/product]
  advances: [workplace://fixture/peer/work/demo]
---

# Demo build Meeting

The Meeting coordinates the Site effect without absorbing Site bytes or granting delivery.

# Hairness architecture

The Home is the durable, provider-agnostic place where agents work. It owns
shared sources and projections. A Desk carries personal continuity. Targets
remain independent Git repositories. Assets are autonomous, source-owned
collections copied under `assets/<namespace>/<name>` or `.desk/assets/`.

`@hairness/cli` is the only package and Kernel. It validates the Home, manages
Assets, computes one Resolved Home, projects provider outputs, builds the HUD and
stages explicitly approved executables. Git owns history; `.hairness/build.json`
records only output ownership, digests and the resolved plan digest.

Installation and synchronization copy files only. They never execute code.
Adapters run only during an explicitly approved build, inside bounded staging,
and may write only declared outputs.

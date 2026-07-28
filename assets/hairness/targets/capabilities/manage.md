# Manage Targets

A Target is an independent repository known by stable identity. Its declaration
is shared in Home settings. Each collaborator owns zero or more named Bindings
under `.desk/targets/<target>/<binding>`.

Resolve the intended Target and inspect its current declarations and Bindings
before proposing a change. When several Bindings exist, require an explicit
selection. Explain separately whether the operation changes shared Home state,
personal Desk state or a managed checkout.

Apply only the accepted declaration, bind, clone, unbind or removal effect.
Never remove a dirty managed checkout, persist a machine path in settings or
turn Target management into product work. Revalidate the selected Binding
before any later Target mutation.

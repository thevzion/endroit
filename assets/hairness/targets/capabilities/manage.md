# Manage Targets

A Target is an independent repository known by stable identity. Its declaration
is shared in Home settings. Each collaborator owns zero or more named Bindings
under `.desk/targets/<target>/<binding>`.

Use `hairness target list|discover|doctor|add|bind|clone|unbind|remove`. When a
Target has multiple Bindings, pass `--binding` explicitly.

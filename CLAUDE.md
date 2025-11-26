
You are attempting to get the combination of happy-server and
happy-cli working together in a self-hosted way (opitionally maybe the
happy/ web or mobile client).

This will require figuring out how to build the respective components,
and possibly adding flags to get them to expose a self-hosted mode
rather than connecting to the happy.engineering server

Install whatever dependencies you want with `apt-get install`, `npm`,
etc, but document what you install in DEPENDENCIES.md.

We are using "beads" ("mb" minibeads implementation) for issue tracking. Run `bd quickstart`.
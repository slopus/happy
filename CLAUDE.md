
You are attempting to get the combination of happy-server and
happy-cli working together in a self-hosted way (plus the web client
and MAYBE the mobile client).

This will require figuring out how to build the respective components,
and possibly adding flags to get them to expose a self-hosted mode
rather than connecting to the happy.engineering server

Install whatever dependencies you want with `apt-get install`, `npm`,
etc, but document what you install in DEPENDENCIES.md.

CODING STYLE
================================================================================

Go to great lengths to NOT DUPLICATE CODE. Even if it is more work, and more
complexity to factor out reusable pieces (i.e. which may require complicated
call-backs for the "holes" that are factored out). There should be as close
to one source-of-truth as possible for each decision, design point, constant
definition, etc.

PREFEER STRONG TYPES. Always use type code if it is an option, and use specific 
types and type wrappers rather than generic types like "String". You could use
Branded Types in TypeScript to achieve the "newtype pattern".

AVOID SILENT FAILURES. When anything goes wrong it is better to error with a
clear message than keep going in a broken state. Include health checks and
invariant checks and make a nice prominent error message when they are violated.

Pre-Commit Validation (IMPORTANT!)
================================================================================

**ALWAYS run `./scripts/validate.sh` before pushing changes!**

This is our primary validation script that:
- Runs all build checks (happy-cli, happy-server, happy webapp)
- Runs all unit tests
- Runs E2E tests with browser automation
- Uses slot 1 for test isolation (won't interfere with production on slot 0)
- Automatically cleans up all processes on exit

Usage:
```bash
./scripts/validate.sh           # Full validation (builds + unit + E2E)
./scripts/validate.sh --quick   # Quick mode (builds + unit tests only)
```

This script is also run by GitHub Actions CI on every push and pull request.

Repository and Branch Management
================================================================================

Unfortunately, the use of three separate submodules for the happy components
makes version control and branching complicated.  The Makefile has some targets
to help deal with this.

Generally speaking, we commit as necessary to these submodules, and then also
commit changes to the parent repo so it tracks up-to-date, mutually-compatible
versions of the submodules. The branch conventions (assisted by the Makefile)
are:

 * Mainline dev mode: default `happy` branch in parent repo, "rrnewton" branch
   in submods.
   * In at least the happy-cli repo, "main" actually tracks "rrnewton" so that 
     we can install it directly from a shallow git checkout.

 * Feature branch: "happy-X" branch in the parent, and "feature-X" branches in
   each submod.

Merging a feature branch back in is a pain, because of needing to merge across
up to four different repositories.

Issue Tracking
================================================================================

We are using "beads" ("mb" minibeads implementation) for issue tracking. Run `bd
quickstart` to learn more.

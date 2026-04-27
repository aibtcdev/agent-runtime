# Agent Package Template

Copy these files into `deploy/<agent>/` when creating a new sibling agent package.

Required operator edits before first run:

- choose the agent name
- fill in `IDENTITY.md`
- fill in `PURPOSE.md`
- create `deploy/<agent>/runtime.<agent>.json`
- create a host-local override config outside the synced repo tree
- seed the first backlog entries for that agent's purpose

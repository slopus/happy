# TODO

## Later

- [ ] Implement Claude session resuming - Currently we spawn a new Claude session for each command instead of resuming. This works but means we lose context between commands. When implementing, need to handle the case where Claude kills the process before saving the session properly.
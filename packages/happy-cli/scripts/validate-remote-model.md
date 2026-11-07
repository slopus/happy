# Live Claude local-to-remote model smoke

Run from a checkout with the CLI dependencies installed and `@slopus/happy-wire` built:

```sh
pnpm --filter happy... install --frozen-lockfile
pnpm --filter @slopus/happy-wire build
python3 packages/happy-cli/scripts/validate-remote-model.py /tmp/happy-opus-smoke opus
python3 packages/happy-cli/scripts/validate-remote-model.py /tmp/happy-opus-1m-smoke 'claude-opus-5-5[1m]'
```

Each output directory must be fresh. Existing Claude and Happy authentication is reused. Each case creates its own fixture directory and Happy session, runs one short native Claude inference and two short SDK remote inferences, then asks Happy to archive that test session through its normal SIGINT cleanup. The runner stops after three minutes; its driver terminates only its own process group if cleanup stalls.

The native local process uses print mode with an open JSON input stream. A headless app-side client submits encrypted prompts through the real Happy HTTP service. Both remote messages omit `meta.model`, exercising preservation of the native selection. No SDK, provider, launcher, queue, or relay is mocked. The observer wrappers forward their arguments unchanged to the real API client and SDK message converter.

`evidence.json` records the checkout SHA, SDK and Claude versions, native result, remote init/assistant/result models, session continuity, and metadata decrypted by an independent user-scoped socket. A pass requires two successful remote responses, the original Claude session ID, matching actual models, a published multi-entry catalog, and the expected `currentModelCode`. For an explicit full `[1m]` selection, that exact suffix must remain in the published selection. SDK `modelUsage.contextWindow` records the provider-reported capacity separately.

This covers a real provider/Happy relay takeover through headless app transport. The native interactive terminal, rendered iOS/Android model picker, and a near-capacity long-context workload are separate checks. The script does not label those as tested. `terminal.log` and `local-result.json` remain local diagnostic files; review their contents before sharing. The compact `evidence.json` contains no authentication material.

The driver removes `NODE_USE_ENV_PROXY` and the `--use-env-proxy` flag only from its child environment because Axios already applies the inherited proxy variables. It keeps those proxy variables intact.

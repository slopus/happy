# Spike: agent window placement (S5, 2026-09-25)

Question: can agent task tabs share a small pool of driver-owned windows (anchor tab +
`window.open('about:blank','_blank','noopener')`) instead of one window per tab, in the
pinned headful Chromium (153.0.8010.52, `abp-browser:pocfix`, Xvfb without a window manager)?

```sh
SPIKE=$PWD/scripts/browser-poc/spikes/window-placement
docker run -d --name abp-s5spike --label ai.saycode.abp-run=s5spike --entrypoint /spike/entry.sh \
  -v $SPIKE:/spike:ro -e "SPIKE_FLAGS=<extra chromium flags>" --memory 2g --shm-size 256m -p 127.0.0.1::9223 abp-browser:pocfix
PORT=$(docker port abp-s5spike 9223 | cut -d: -f2)
pnpm exec tsx $SPIKE/spike.ts abp-s5spike $PORT 60     # placement, capture, beforeunload, anchor loss, memory
pnpm exec tsx $SPIKE/focus.ts abp-s5spike $PORT anchor # X input focus with window.open placement
pnpm exec tsx $SPIKE/focus.ts abp-s5spike $PORT window # X input focus with createTarget(newWindow, background)
pnpm exec tsx $SPIKE/churn.ts abp-s5spike $PORT 200 25 # window-per-task churn memory trend
docker rm -f abp-s5spike
```

Results and the decision: `src/browserRuntime/DESIGN.md` ("Agent windows").

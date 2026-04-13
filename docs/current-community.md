# Happy User Deep Dive — Full Analysis

*Generated 2026-04-12. Data: 502 unique contributors, 497 issues, 296 PRs, 17,782 stars.*

---

## Executive Summary

Happy has 502 unique external contributors across 793 issues+PRs. The userbase is **truly global** — roughly 35% East Asian (China, Japan, Korea, HK), 40% Western (US, Europe, AU), 15% South/Southeast Asian, 10% other. Activity peaked in mid-February 2026 (43 new users/week) and has stabilized at ~27 new users/week.

**Founders:** Kirill Dubovitskiy (bra1nDump), Steve Korshakov (ex3ndr / ex3ndr-bot), and the GrocerPublishAgent system (PeoplesGrocers LLC). All three are excluded from "external contributor" counts below unless otherwise noted.

**The most striking finding:** Happy's contributor list reads like a who's-who of developer tools. Instagram's first engineer, OpenAI's ChatGPT team, Meta EMs, CMU robotics professors, the Kubeflow co-founder, Meteor/Apollo core engineers, the ReactiveUI creator, LAION/img2dataset builders, and the KernelSU creator (16K stars) all use or contribute to Happy.

---

## Growth Timeline

```
Week          New Users  Cumulative
2025-07-21:      2         2     ██
2025-08-18:      2         5     ██
2025-09-01:      3         9     ███
2025-11-03:      8        23     ████████        ← First real growth
2025-11-17:     12        38     ████████████
2025-12-29:     28       112     ████████████████████████████  ← Holiday spike
2026-01-12:     24       159     ████████████████████████
2026-02-09:     42       275     ██████████████████████████████████████████  ← PEAK
2026-02-16:     43       318     ███████████████████████████████████████████
2026-03-30:     31       475     ███████████████████████████████
2026-04-06:     27       502     ███████████████████████████
```

**Key inflection points:**
- **Jul-Sep 2025:** Founding era. 12 users. Mostly direct network (dvlkv, vzhovnitsky, kamal, etc.)
- **Nov 2025:** First real growth wave (~35 new users). Product discovered by broader audience.
- **Dec 2025-Jan 2026:** Steady growth. Self-hosting & Docker interest emerges.
- **Feb 2026:** EXPLOSIVE growth. 150+ new users in one month. Peak engagement.
- **Mar-Apr 2026:** Maturation. Growth stabilizes but still healthy (~27/week).

---

## Monthly Activity

| Month    | Issues | PRs | Total | Unique Users |
|----------|--------|-----|-------|-------------|
| 2025-07  |    0   |   3 |     3 |           3 |
| 2025-08  |    0   |   4 |     4 |           3 |
| 2025-09  |    0   |   8 |     8 |           6 |
| 2025-10  |    0   |   2 |     2 |           1 |
| 2025-11  |   36   |   4 |    40 |          36 |
| 2025-12  |   44   |  27 |    71 |          51 |
| 2026-01  |  103   |  45 |   148 |         113 |
| 2026-02  |  175   | 105 |   280 |         158 |
| 2026-03  |   88   |  74 |   162 |         115 |
| 2026-04  |   51   |  24 |    75 |          55 |

---

## Contributor Type Distribution

- **Issue reporters only:** 352 (70%) — Users who found bugs / requested features
- **PR authors only:** 115 (23%) — Code contributors
- **Both issues & PRs:** 35 (7%) — Deeply engaged contributors

---

## Contribution Topic Areas

| Topic                | Count | Notes |
|----------------------|-------|-------|
| Session Management   |   158 | #1 concern — daemon, tmux, lifecycle |
| Mobile/iOS/Android   |   116 | Core mobile UX |
| Codex Integration    |    99 | Multi-agent support (Codex, Gemini, Kimi, OpenCode) |
| UI/UX                |    80 | Buttons, sidebar, scroll, layout |
| MCP/Protocol         |    49 | MCP server compat, ACP protocol |
| Voice/Audio          |    31 | ElevenLabs, Whisper, voice agents |
| Windows              |    29 | Platform compatibility |
| Docker/Deploy        |    20 | Self-hosting |
| Security             |    20 | XSS, CORS, encryption, auth |
| i18n/Languages       |    16 | Chinese, Japanese, Italian, Korean |
| Self-hosting         |    15 | Docker compose, local deployment |
| Performance          |     6 | N+1 queries, latency |

---

## Retention Analysis

Only **28 of 502** contributors (5.6%) returned in a second month. The power users who stuck around:

| User | Months Active | Span |
|------|--------------|------|
| LightYear512 | 4 months | Jan-Apr 2026 |
| denysvitali | 4 months | Sep 2025-Feb 2026 |
| ahundt | 4 months | Nov 2025-Mar 2026 |
| theflysurfer | 3 months | Jan-Mar 2026 |
| chaehyun2 | 3 months | Feb-Apr 2026 |
| cruzanstx | 3 months | Nov 2025-Apr 2026 |
| kmizzi | 3 months | Nov 2025-Feb 2026 |
| bbhxwl | 3 months | Jan-Apr 2026 |

---

## Community Engagement (Issue Comments)

Beyond filing issues/PRs, these people are the actual *community* — they discuss, review, and help others:

| User | Comments | Role |
|------|----------|------|
| bra1nDump (Kirill Dubovitskiy) | 104 | Co-founder |
| ex3ndr (Steve Korshakov) | 90 | Co-founder |
| GrocerPublishAgent (PeoplesGrocers) | 71 | Co-founder (automated agent) |
| **leeroybrun** | **40** | Community champion |
| happier-bot | 20 | Bot |
| **Miista (Søren Guldmund)** | **13** | Discussion participant |
| **ahundt (Andrew Hundt, CMU)** | **13** | Academic contributor |
| **MattStarfield** | **12** | Hardware engineer |
| **hyacz** | **12** | Chinese community builder |
| **tiann (weishu)** | **10** | KernelSU creator |
| **rrnewton (Ryan Newton, Meta/Purdue)** | **10** | CS researcher |

---

## ⭐ The VIP Wall — Notable Users by Profile

### Founders

**ex3ndr (Steve Korshakov)** — Bay Area — 1,099 followers — **90 comments**
- "Chaotic good inventor." Working on AGI, social, fintech, new languages
- Created **llama-coder** (2,082 stars) — local AI Copilot replacement
- Core contributor to **Nicegram** (Telegram alternative client, 681+338 stars)
- Created **Tact** smart contract language for TON blockchain (694 stars)
- Building VALL-E 2 and VoiceBox neural network reproductions
- Also runs **ex3ndr-bot** submitting automated PRs
- Happy activity: 2 PRs + 9 bot PRs + 90 comments.

**bra1nDump (Kirill Dubovitskiy)** — Bay Area — Co-founder
- Previously at Robinhood (AI) and Meta
- Happy activity: 104 comments, core maintainer.

**GrocerPublishAgent** — PeoplesGrocers LLC — Co-founder (automated agent)
- Agentic CI/CD system operated by PeoplesGrocers LLC
- Happy activity: 4 merged PRs + 71 comments. Handles mono repo refactoring, win32 bundling, e2e testing.

---

### Tier S — Industry Legends

**anaisbetts (Ani Betts)** — Berlin — 2,428 followers
- Created **ReactiveUI** (8,469 stars), .NET reactive programming framework
- Created **Akavache** (2,543 stars) and **ModernHttpClient** (656 stars)
- Former GitHub engineer, worked on **Electron** (246 commits) and **GitHub Desktop**
- Now building MCP tools: **mcp-installer** (1,519 stars), **mcp-youtube** (514 stars)
- Happy activity: 1 issue (Nov 2025). Early user.

**rom1504 (Romain Beaumont)** — Palo Alto — 2,228 followers
- ML Engineer at **Google**
- Created **img2dataset** (4,407 stars) — THE tool for building AI training datasets
- Created **clip-retrieval** (2,749 stars)
- Key figure in **LAION** ecosystem (Open-Assistant: 37,419 stars)
- Happy activity: 1 issue (Jan 2026).

**shayne (Shayne Sweeney)** — NYC — 360 followers
- **ChatGPT team at OpenAI**
- Ex-**Tailscale** Product
- **First Engineer at Instagram**
- Created **go-wsl2-host** (1,679 stars), **wsl2-hacks** (1,312 stars)
- Happy activity: 4 issue comments. Lurker-engager.

**glasser (David Glasser)** — Berkeley — 519 followers
- Core engineer at **Apollo GraphQL** (apollo-server: 13,937 stars)
- **3,978 commits to Meteor** (44,781 stars) — one of its most prolific contributors ever
- Happy activity: 1 issue (Jan 2026).

**aronchick (David Aronchick)** — Seattle — 182 followers
- Co-founder of **Kubeflow** (15,568 stars) — THE ML toolkit for Kubernetes
- Previously led Kubernetes/ML at Google
- Now CEO of **Expanso** (Bacalhau, 854 stars)
- Happy activity: 2 contributions (Jan 2026), including a PR.

**tiann (weishu)** — Hong Kong — 8,218 followers
- Creator of **KernelSU** (15,979 stars) — kernel-based Android root solution
- Also runs **hapi** (3,451 stars) — a competing/parallel mobile AI coding client!
- Created **Leoric** (1,918 stars), **eadb** (555 stars)
- Happy activity: 5 PRs (3 merged, Dec 2025). Android fixes. Also 10 comments.

---

### Tier A — Well-Known in Their Domain

**danielamitay (Daniel Amitay)** — NYC — 401 followers
- OG iOS developer legend
- Created **DACircularProgress** (2,348 stars), **DAKeyboardControl** (1,551 stars), **iHasApp** (1,431 stars)
- 6,500+ cumulative stars across iOS libraries
- Happy activity: 1 merged PR (Jan 2026) — swipe to archive/delete sessions.

**rsanheim (Rob Sanheim)** — Madison, WI — 250 followers
- **Former GitHub engineer**
- Former **Cognitect** (the company behind Clojure/Datomic)
- Now at Doximity. Ruby/Rails community veteran since 2008.
- Happy activity: 1 PR (Feb 2026) — removing credential logging.

**rrnewton (Ryan Newton)** — Indiana — 287 followers
- Computer Scientist at **Meta** and **Purdue University** (and Indiana University)
- Specializes in Containers, Compilers, Deterministic Parallelism
- Created **happy-devbox** (30 stars) — dev environment for Happy
- Happy activity: 1 PR + 10 comments.

**anaclumos (Sunghyun Cho)** — 0 followers (deliberately hidden)
- Created **bing-chat-for-all-browsers** (1,444 stars)
- Created **heimdall** (130 stars), **extracranial** (146 stars)
- Deliberately anonymous profile ("not interested in becoming famous")
- Happy activity: 1 issue (Nov 2025). Very early.

**denysvitali (Denys Vitali)** — Zurich — 520 followers
- Prolific hacker/reverse engineer. 484 repos.
- Created **thebestmotherfuckingwebsite** (675 stars), **nginx-error-pages** (425 stars)
- Tesla firmware decryption, Apple FindMy key ops, COVID cert analysis
- Happy activity: 4 contributions spanning Sep 2025-Feb 2026. Very early, very persistent.

**krzemienski (Nick Krzemienski)** — NYC — 228 followers
- Video Engineer, formerly Engineering Lead at **fuboTV**
- Created **awesome-video** (1,845 stars) — definitive streaming video resource
- 1,325 repos. Also building Claude Code iOS tools obsessively.
- Happy activity: 3 PRs (Sep-Oct 2025). VERY early. First external feature contributor.

---

### Tier B — Impressive Professionals

**dzlobin (Danny Zlobinsky)** — NYC — 113 followers
- **Engineering Manager at Meta/Facebook**
- Happy activity: 5 contributions (Feb 2026). PRs: camera dismiss, Ink rendering, tmux detach.

**omachala (Ondrej Machala)** — London — 11 followers
- **Engineering Lead at JPMorgan Chase**
- Created **ha-treemap-card** (57 stars), **heroshot** (35 stars)
- Happy activity: 6 issues (Feb 2026). Thoughtful UX-focused bug reports.

**mfazekas (Miklos Fazekas)** — Hungary — 142 followers
- Freelance React Native expert
- **Lead maintainer of rnmapbox/maps** (2,810 stars)
- Also maintains net-ssh (Ruby SSH library)
- Happy activity: 1 PR (Feb 2026) — PTY proxy stdin corruption fix.

**lucharo (Luis Chaves Rodriguez)** — London — 35 followers
- Data scientist/bioinformatician at **GSK (GlaxoSmithKline)**
- MSc Health Data Analytics & Machine Learning
- Happy activity: 7 contributions (Feb 2026). UX bug reports.

**brtkwr (Bharat)** — Bristol, UK — 52 followers
- Security engineer at **Two Inc** (B2B payments fintech)
- Happy activity: 7 security issues in ONE DAY (Feb 19). Full security audit: QR auth expiry, wildcard CORS, debug logs, Docker root, RevenueCat bypass.

**arthurgervais (Arthur Gervais)** — 97 followers
- Blockchain security researcher
- Created **Bitcoin-Simulator** (196 stars), **MAPTA** (99 stars)
- Building AI-driven automated security testing (XBOW)
- Happy activity: 1 issue (Jan 2026).

**ahundt (Andrew Hundt)** — Pittsburgh — 505 followers
- **Carnegie Mellon University** CIFellow, PhD Johns Hopkins
- Previously at CMU's National Robotics Engineering Center
- Created **awesome-robotics** (1,365 stars)
- Happy activity: 5 contributions spanning Nov 2025-Mar 2026. 13 comments.

**jonocodes (Jono)** — San Francisco — 41 followers
- Works at **Terradot** (climate tech / carbon removal)
- Created **savr** (113 stars), GtkSourceSchemer, GeditSplitView
- Happy activity: 6 contributions (Mar 2026). Server status, web errors, UX.

---

### Tier C — Community Champions (Not Famous but Incredibly Valuable)

**leeroybrun (Leeroy Brun)** — Lausanne, Switzerland — 69 followers
- Full-stack engineer at **Batiplus**
- **Built the entire Happy self-hosted ecosystem:** happy-stacks, happy-server-light, happy-cli, slopus.github.io (docs)
- 5 merged PRs + 40 issue comments. THE community champion.
- Also built tools for Codex and OpenCode.

*(ex3ndr and GrocerPublishAgent are co-founders — see Founders section above)*

**cruzanstx** — Possibly US Virgin Islands — 9 followers
- The LONGEST-TENURED active user: Nov 2025 to Apr 2026 (5+ months!)
- Built **cclimits** (15 stars) — check quota for Claude Code, Codex, Gemini CLI
- Also built own **hapi** fork and **happy-cli** fork
- 6 issues spanning 5 months. The most persistent power user.

**theflysurfer** — ??? — 0 followers, 0 repos
- Ghost account. Filed 22 issues (most of any user!) covering i18n, image upload, sessions, pkgroll
- 18 issues in a SINGLE DAY (Feb 24, 2026). Insane thoroughness.
- Complete mystery — no profile, no repos, no followers. Just issues.

**nikhilsitaram** — ??? — 0 followers
- Brand new account (Dec 2025), but created **claude-caliper** (68 stars) and **claude-memory-system** (12 stars)
- 7 contributions focused on MCP/infrastructure
- Possibly experienced dev with a fresh account for AI tooling work.

**Scoteezy (Denis Bondarenko)** — Russia — 9 followers
- **100% merge rate!** All 4 PRs merged.
- Windows fixes, claude-agent-sdk migration, yolo mode, Gemini ACP integration
- The most versatile and reliable external contributor.

**hztBUAA (Zhenting Huang)** — Beijing — 30 followers
- CS senior at **Beihang University** (BUAA). 99 public repos.
- Building Obsidian plugins, AI desktop apps, MCP tools, LLM security scanners
- 10 contributions. Technically ambitious for a student.

**SaneBow** — Hong Kong — 49 followers
- Security + ML researcher
- Created **PiDTLN** (93 stars, ML noise suppression), **redirect-fuzzer** (53 stars)
- 2 merged PRs: AskUserQuestion UI, collapsible sidebar.

**EricSeastrand** — Houston, TX — 6 followers
- Building Claude Code tooling ecosystem: claude-context, claude-usage, claude-vectorsearch
- 9 PRs in 2 days. Mobile web fixes + Prometheus metrics. 1 merged.

**kmizzi (Kalvin Mizzi)** — Los Angeles — 6 followers
- Fintech developer. **Polymarket arbitrage bot** (10 stars), automated trading
- One of the EARLIEST external contributors (Nov 2025). 6 contributions over 3 months.

---

## The Pioneers (Pre-November 2025)

These 12 people were using Happy before it had any real traction:

| User | First Activity | What They Did |
|------|---------------|---------------|
| expectfun (Eugene Trifonov) | Jul 21, 2025 | Fixed a typo. Literally the first external contributor. |
| vzhovnitsky (Vladislav) | Jul 22, 2025 | iOS permissions check |
| dvlkv (Dan Volkov) | Jul 28, 2025 | Android barcode scanner fix |
| turbocrime | Aug 22, 2025 | Modal.prompt Android fix |
| **kamal (Kamal Fariz Mahyuddin)** | Aug 22, 2025 | Submit button + staged file path fixes. Bay Area Ruby veteran. |
| lava (Benno Evers) | Aug 26, 2025 | Voice assistant incoming messages |
| pyflmcp | Sep 3, 2025 | Simplified Chinese language pack |
| JulianCrespi | Sep 7, 2025 | iOS file picker |
| Lesiuk (Damian Lesiuk) | Sep 13, 2025 | GLM coding plan compatibility |
| **denysvitali (Denys Vitali)** | Sep 23, 2025 | New session wizard. Zurich hacker, 520 followers. |
| **krzemienski (Nick Krzemienski)** | Sep 30, 2025 | Resource browser, model control, Sonnet 4.5 support. Video industry leader. |
| GrocerPublishAgent | Sep 2025 | Co-founder (automated agent) |

---

## External Contributors with Merged PRs (Code That Shipped)

42 external contributors have had code merged. Top by volume:

| Contributor | Merged PRs | Key Contributions |
|------------|-----------|-------------------|
| leeroybrun | 5 | Expo app fixes, TypeScript CI, Enter-to-send, new session UX |
| Scoteezy | 4 | Windows, SDK migration, yolo mode, Gemini ACP. 100% merge rate. |
| GrocerPublishAgent | 4 | win32 bundling, mono repo, session hiding, markdown copy |
| tiann | 3 | Android: first message, press, notifications |
| LightYear512 | 2 | Windows npm shims, windowsHide |
| hyacz | 2 | Markdown layout, CLAUDE.md docs |
| OrdinarySF | 2 | Shell wrapper, IME composition |
| kmizzi | 2 | Message fetch, encryption retry |

---

## Burst Contributors (The "Speed Runners")

Some people go absolutely ham in a single day:

| User | Items | Date | What Happened |
|------|-------|------|--------------|
| theflysurfer | 18 | Feb 24 | Filed 18 detailed issues in one day |
| davidrimshnick | 12 | Feb 21 | 12 PRs, 0 merged. Possibly AI-generated burst. |
| HirokiKobayashi-R | 10 | Feb 13 | 10 contributions. Go/infra engineer. |
| seibe | 9 | Feb 21 | 9 PRs. Japanese Haxe/WebRTC dev in Tokyo. |
| EricSeastrand | 8 | Mar 13 | 8 PRs. Mobile web + Prometheus. Houston dev. |
| brtkwr | 7 | Feb 19 | 7 security issues. Full audit in one sitting. |
| nikhilsitaram | 7 | Feb 16 | 7 contributions. MCP/infra focus. |

---

## Still Active (April 2026)

55 users active in April 2026. Notable returnees from earlier cohorts:

- **cruzanstx** — Active since Nov 2025 (5+ months!)
- **LightYear512** — Active since Jan 2026 (4 months), Windows champion
- **Scoteezy** — Active since Jan 2026, still shipping merged PRs
- **chaehyun2** — Active since Feb 2026, frontend contributions
- **bbhxwl** — Active since Jan 2026

---

## Geographic Distribution (Inferred)

**East Asia (~35%):** China (Beijing, Wuhan, Shanghai, HK), Japan (Tokyo), Korea, Taiwan
**North America (~30%):** SF Bay Area, NYC, Houston, LA, Seattle, Pittsburgh, El Paso
**Europe (~25%):** London, Zurich/Lausanne, Bristol, Hungary, Russia, Czech Republic, Greece
**Other (~10%):** Israel, India, Vietnam, Brazil, USVI

**Notable clusters:**
- Bay Area: ex3ndr, kamal, jonocodes, rom1504
- NYC: dzlobin, danielamitay, krzemienski, fny
- London: omachala (JPMorgan), lucharo (GSK), brtkwr (Two Inc)
- Beijing: hztBUAA, nullne
- Hong Kong: tiann, SaneBow

---

## User Archetypes

1. **The Power User** (cruzanstx, theflysurfer, omachala) — Files many issues over time, deeply knows the product, shapes UX
2. **The Code Contributor** (leeroybrun, Scoteezy, tiann) — Submits PRs that get merged, ships features
3. **The Security Auditor** (brtkwr) — Does a comprehensive security sweep in one session
4. **The Ecosystem Builder** (leeroybrun, chris-yyau, EricSeastrand) — Builds tools, docs, and infrastructure around Happy
5. **The Sprint Contributor** (davidrimshnick, seibe, EricSeastrand) — Burst of activity in 1-2 days
6. **The Silent VIP** (shayne, glasser, anaisbetts, rom1504) — Famous people who lurk, comment, or file 1 issue
7. **The Student Builder** (hztBUAA, chaehyun2) — Early career devs contributing to build their portfolio
8. **The Competing Builder** (tiann/hapi, cruzanstx/hapi) — People who also build similar products

---

## Key Takeaways

1. **You have genuine industry credibility.** Instagram's first engineer, OpenAI, Meta EMs, CMU professors, Apollo/Meteor core engineers, ReactiveUI creators, and Google ML researchers all use Happy. This is not a toy project.

2. **Steve Korshakov (ex3ndr) is your #1 community asset.** 90 comments, 11 PRs (via bot), plugin architecture work. He's basically volunteering as a co-maintainer. The llama-coder creator (2K stars) clearly believes in Happy.

3. **Leeroybrun is your community champion.** Built the entire self-hosted ecosystem, 40 comments, 5 merged PRs. If you ever want to recognize a community contributor, it's him.

4. **The security audit from brtkwr was a gift.** 7 vulnerabilities found in one day. This is the kind of thing companies pay $50K+ for.

5. **Retention is low (5.6%)** but the retained users are incredibly high-quality. The 28 returning contributors are the product's backbone.

6. **Chinese developer community is massive and growing.** ~35% of contributors. Beijing (Beihang University), Wuhan, HK. i18n and Windows support are high-priority for this segment.

7. **tiann (weishu) is both an ally and a competitor.** His hapi project (3.4K stars) does the same thing. His early Android fixes for Happy were likely cross-pollination. Worth watching.

8. **The "burst contributor" pattern** (12 PRs in 1 day, 18 issues in 1 day) suggests people discover Happy and immediately deep-dive. First impressions matter enormously.

9. **Session management is the #1 pain point** (158 contributions). Daemon lifecycle, tmux, session state — this is where the product needs the most polish.

10. **The product has genuine "vibe coding" PMF.** The fact that Claude Code, Codex, Gemini, Kimi, and OpenCode integrations are all being contributed by users suggests Happy is becoming the universal mobile frontend for AI coding agents.

# Video Director Agent Design

**Date:** 2026-04-06  
**Version:** v1.0  
**Status:** Draft for review

---

## 1. Goal

Design a local-first backend agent that turns a complete app marketing brief into a finished product advertising video.

The agent should feel like a top-tier commercial director in how it reasons about story, pacing, and visual identity, but behave like a reliable production workflow in how it gathers assets, generates shots, renders audio, edits a timeline, and exports deliverables.

The first implementation target is:

- a local workflow running on the user's machine
- a backend-first system with no required GUI
- a generic app video director agent, not a Huppy-only tool
- `Seedance 2.0` as the only video generation provider in v1
- mixed production using real product assets plus AI-generated visual treatment
- automatic end-to-end production from brief to finished video

---

## 2. Product Definition

### Product statement

The system is a **video director agent for app marketing teams**.

Given a complete marketing brief, platform target, market, style direction, and product assets, it should:

1. understand the marketing objective
2. develop a creative direction
3. plan a shot structure
4. generate provider-specific video prompts
5. render shots through `Seedance 2.0`
6. create voiceover, music, and sound design
7. assemble everything into a finished export

### User-facing personality

The agent should behave like a strong creative director rather than a raw prompt generator.

Its default creative persona is:

- visually bold
- cinematic
- concept-led
- capable of international ad-film quality references
- able to reason like a director in the spirit of creators such as `Michel Gondry`

This does **not** mean every final video must look like Gondry. The agent's creative brain should be high-concept and visually inventive, while the final visual style should still follow the actual brief. For example, Huppy may call for a dark, minimal, orange-accented developer-tool aesthetic rather than whimsical handmade surrealism.

### First sample campaign

Huppy is the first sample use case, but not the product boundary.

The system should be able to support a Huppy-style brief such as:

- dark background `#080808`
- accent orange `#FF9A3C`
- 9:16 vertical
- 30 seconds
- fast-cut product film
- real UI plus AI-enhanced brand shots

---

## 3. Non-Goals

The first version should explicitly avoid trying to be all of these at once:

- a polished end-user web application
- a full nonlinear editor UI
- a multi-provider video generation platform
- a collaborative approval workflow with multiple human reviewers
- a general ad platform covering TV, long-form brand film, or non-app products
- a fully autonomous online service deployment

The goal is a strong local production engine that can later be wrapped in a chat UI or product UI.

---

## 4. User Inputs and Operating Assumptions

### Required input package

The first version assumes the user provides a **complete marketing brief**.

That brief should support at least:

- app name
- one-line product description
- target market
- target platform or delivery profile
- target duration
- audience
- core value propositions
- desired visual style
- tone of copy
- references or competitive context
- required claims or branding elements
- forbidden claims or visual directions

### Asset input model

The system uses a mixed asset model:

- the user provides core assets
- the agent may auto-collect missing supporting assets

Core user assets may include:

- screenshots
- screen recordings
- logo files
- brand guidelines
- press kit elements
- app icon
- existing voice copy or tagline copy

Auto-collected assets may include:

- product site imagery
- publicly available screenshots
- supporting brand references
- extracted frames from user videos

### Output target selection

Output format is selected at run start rather than hardcoded into the system.

Supported design intent for future profiles includes:

- Apple App Store Preview
- social vertical video
- Google Play or other ad placements

The first implementation plan should focus on one profile at a time, but the architecture should treat delivery profile as configuration.

### Language behavior

Language should be derived from the target market.

Examples:

- US market -> English by default
- China market -> Chinese by default
- multilingual campaign -> multiple localized exports

This affects:

- on-screen text
- voiceover
- subtitles
- export variants

### Automation preference

The default operating mode is:

- once the brief is sufficient, the agent should try to run end-to-end automatically
- it should interrupt only when blocked by missing assets, provider failure, or unresolved quality problems

---

## 5. Design Principles

1. **Director-first, not prompt-first**  
   The system should think in campaign structure, shot purpose, and emotional rhythm before it thinks in provider prompts.

2. **Real product truth with cinematic amplification**  
   Core product moments should stay faithful to the real app. AI-generated material should heighten emotion, clarity, and brand identity rather than replace product truth.

3. **Configuration over hardcoding**  
   Delivery specs, style presets, language behavior, and provider settings should live in structured profiles rather than being buried inside prompt templates.

4. **Shot-level retryability**  
   Every shot should be its own job so failures can be repaired locally without re-running the entire project.

5. **Local-first transparency**  
   Every run should leave behind a clear project folder with assets, plans, prompts, intermediate renders, logs, and exports.

6. **Quality over speed**  
   The system should spend extra cycles on retries, prompt adjustment, and validation when necessary to reach a publishable result.

---

## 6. System Shape

The system should present itself as a single director agent, while internally acting as a modular production pipeline.

### External shape

To the user, this is one creative agent that:

- receives a brief
- explains the concept if needed
- proceeds into production
- reports progress
- delivers final exports

### Internal shape

Internally, it should behave like a workflow orchestrator managing specialized modules for:

- brief normalization
- asset gathering
- creative direction
- shot planning
- video generation
- audio generation
- editing
- QA and export

This preserves a simple user mental model while keeping the implementation clean and extensible.

---

## 7. Core Modules

### 7.1 Brief Director

Purpose:

- parse the original brief
- normalize it into structured campaign data
- detect missing or conflicting requirements
- derive language, platform, timing, and constraints

Responsibilities:

- ingest markdown, text, or structured JSON brief data
- extract product facts and campaign goals
- identify must-keep brand elements
- identify prohibited directions
- score whether the brief is production-ready

Primary output:

- `brief.json`
- `brief-summary.md`

### 7.2 Asset Collector

Purpose:

- gather, inspect, and label all usable media assets

Responsibilities:

- import user-supplied screenshots, screen captures, logos, and references
- collect supplemental public assets when permitted
- generate frame extracts from videos
- tag assets by likely use: hero, UI demo, logo, transition, texture, reference
- identify gaps that require AI generation

Primary output:

- `asset-manifest.json`
- organized `assets/` directory

### 7.3 Creative Director

Purpose:

- turn campaign facts into a clear creative thesis and film structure

Responsibilities:

- decide the central idea of the piece
- choose pacing and narrative arc
- determine where to use real product footage vs AI treatment
- choose subtitle style, sound direction, and transition language
- apply a style preset or derived style system from the brief

Primary output:

- `creative-plan.md`

### 7.4 Shot Planner

Purpose:

- convert the creative plan into executable shot jobs

Responsibilities:

- define shot count and durations
- assign function to each shot
- draft provider-ready `Seedance 2.0` prompts
- bind each shot to required assets, text, timing, and fallback strategy
- define transitions between shots

Primary output:

- `shots/shot-01/spec.json`
- repeated for each shot

### 7.5 Seedance Operator

Purpose:

- own all interaction with `Seedance 2.0`

Responsibilities:

- submit generation requests
- poll job status
- download results
- manage retries
- mutate prompts when output fails technical or creative thresholds

Primary output:

- shot renders
- provider logs
- prompt version history

### 7.6 Audio Director

Purpose:

- create the audio layer of the final film

Responsibilities:

- write voiceover copy based on language and market
- generate or request TTS
- select or generate music
- define sound effect cues
- keep timing aligned with shot rhythm

Primary output:

- `voiceover-script.md`
- audio files in `audio/`

### 7.7 Editor

Purpose:

- assemble the finished piece from all components

Responsibilities:

- build the final timeline
- cut shots to exact duration
- composite subtitles
- mix voice, music, and SFX
- insert brand end card and transitions
- export according to delivery profile

Primary output:

- timeline manifests
- rendered exports

### 7.8 QA Publisher

Purpose:

- validate that the exported result matches platform and campaign requirements

Responsibilities:

- check aspect ratio
- check duration
- check subtitle safe area
- check language correctness
- check brand presence and required copy
- confirm export package completeness

Primary output:

- `qa-report.md`
- final export package

---

## 8. End-to-End Workflow

The canonical production flow should be:

1. ingest brief and project settings
2. normalize campaign data
3. collect and classify assets
4. produce a creative plan
5. produce shot plans
6. render video shots through `Seedance 2.0`
7. create voiceover, music, and sound effects
8. assemble edit timeline
9. run QA checks
10. export deliverables

### Blocking conditions

The workflow should stop and surface intervention only when:

- the brief is missing essential product facts
- required brand assets are unavailable
- a must-have real product shot has no source material
- repeated provider failures prevent acceptable shot generation
- audio or export steps fail irrecoverably

Everything else should be handled automatically.

---

## 9. Data Model and State Flow

Each production run should create a `video project`.

### 9.1 Project object

The top-level project should include:

- project id
- app name
- campaign name
- target market
- delivery profile
- language
- duration target
- style preset or derived style
- status
- timestamps
- output directory

### 9.2 Artifacts

Each project should own these artifacts:

- `brief.json`
- `brief-summary.md`
- `asset-manifest.json`
- `creative-plan.md`
- per-shot spec files
- render logs
- audio files
- timeline manifest
- QA report
- final exports

### 9.3 Shot jobs

Every shot must be a separate tracked job with:

- shot id
- purpose
- planned duration
- prompt text
- prompt revision history
- required assets
- current status
- retry count
- output file path
- quality notes

### 9.4 States

Recommended project states:

- `briefing`
- `asset_ready`
- `concept_ready`
- `shots_generating`
- `shots_ready`
- `editing`
- `qa`
- `exported`
- `failed`

Recommended shot states:

- `planned`
- `queued`
- `rendering`
- `retrying`
- `rendered`
- `accepted`
- `failed`

### 9.5 Failure semantics

Shot failure should not automatically fail the whole project.

Rules:

- individual shots may retry independently
- only critical unrecoverable shots should escalate project failure
- if a shot repeatedly fails, the system should either switch to a fallback prompt strategy or mark the project as requiring intervention

---

## 10. Creative Logic

### 10.1 Director persona vs visual style

The creative engine should separate:

- **director reasoning style**
- **campaign visual style**

Director reasoning style remains high-concept and cinematic.

Campaign visual style is derived from the brief or chosen preset.

This avoids a contradiction where every campaign looks the same merely because the agent has a recognizable creative voice.

### 10.2 Style presets

Style should be loaded from named presets and then refined by campaign inputs.

The first version should support at least:

- `michel-gondry`
- `dark-tech-minimal`

`michel-gondry` should bias toward:

- invention
- tactile imagination
- surprising transitions
- visual play
- emotionally resonant surrealism

`dark-tech-minimal` should bias toward:

- deep black backgrounds
- sharp orange or controlled accent lighting
- high-contrast UI presentation
- confident typography
- fast, clean, no-nonsense motion

### 10.3 Real vs AI shot allocation

The creative planner should classify shots into:

- product-truth shots
- hybrid shots
- fully synthetic support shots

Rules:

- core feature explanation should prefer real product material
- identity, atmosphere, and transition shots may use AI generation
- the more directly a shot demonstrates product functionality, the more it should be grounded in real assets

---

## 11. Provider Strategy

### 11.1 Video provider

`Seedance 2.0` is the only video generation provider in v1.

The implementation should still place it behind a provider interface so future providers can be added later.

The `SeedanceProvider` should own:

- request construction
- authentication
- polling
- download
- error classification
- retry policy

### 11.2 Audio providers

Audio should also sit behind interfaces even if the first implementation uses only one provider choice per category.

Interfaces should cover:

- text-to-speech
- music generation or selection
- sound effect generation or selection

### 11.3 Provider configuration

Secrets and provider settings should be environment-driven, not hardcoded.

Expected config categories:

- `SEEDANCE_API_KEY`
- video endpoint or provider base URL
- voice provider credentials
- music provider credentials
- output defaults

---

## 12. Local Project Layout

Every run should generate a folder like:

```text
projects/video-runs/2026-04-06T22-10-00-huppy/
  project.json
  brief/
    brief.json
    brief-summary.md
  assets/
    source/
    derived/
    manifest.json
  creative/
    creative-plan.md
  shots/
    shot-01/
      spec.json
      prompt-v1.txt
      prompt-v2.txt
      render.mp4
      notes.md
    shot-02/
  audio/
    voiceover-script.md
    voiceover.wav
    music.wav
    sfx/
  timeline/
    timeline.json
  qa/
    qa-report.md
  exports/
    final.mp4
    final-subtitled.mp4
    trailer-cover.jpg
```

This layout is important because the system is local-first and should be inspectable by humans.

---

## 13. Runtime Interface

The long-term user experience should be a chat-style director agent.

However, because v1 is backend-first, the initial runtime interface should be a local command workflow that can later be wrapped by chat or UI.

### Recommended v1 entry shape

The first implementation should support something equivalent to:

- provide a brief file
- provide an asset directory
- choose a delivery profile
- choose or derive a style preset
- start a project run

Example intent:

```bash
video-director run \
  --brief ./campaigns/huppy-brief.md \
  --assets ./campaigns/huppy-assets \
  --profile app-store-preview \
  --style dark-tech-minimal
```

This is not a final CLI contract, but it expresses the correct operating model for v1.

### Chat compatibility requirement

Even if the first entrypoint is CLI-first, all outputs should be structured so a later chat UI can:

- explain what the agent is doing
- show creative reasoning
- show shot progress
- show render results
- resume failed runs

---

## 14. Delivery Profiles

Delivery profile should be treated as a first-class configuration object.

Each profile should define:

- aspect ratio
- target resolution
- target duration or duration bounds
- subtitle safe area
- audio expectations
- export codec settings
- final packaging rules

The first implementation should design for profiles such as:

- `app-store-preview`
- `social-vertical`
- `google-play-video`

The plan may only fully implement one profile first, but the system model should support multiple profiles from the start.

---

## 15. Audio Strategy

The user explicitly wants full audio support in v1.

That means the final production flow must include:

- voiceover generation
- background music
- sound effects where helpful

Rules:

- audio should follow market language
- product copy should stay concise and ad-friendly
- music should support the chosen visual style
- sound design should clarify transitions and emphasis, not overwhelm the UI

If a delivery profile later prefers silent-first design, the system can still generate a silent-safe cut, but audio support remains part of core scope.

---

## 16. Editing and Export

The first version should use a media-processing stack based on:

- `ffmpeg`
- `ffprobe`

These tools are sufficient for:

- trimming clips
- concatenating shots
- scaling and padding
- audio mixing
- subtitle burn-in
- cover frame extraction
- technical validation

The system should avoid a complex custom editing UI in v1.

### Timeline assembly requirements

The editor should support:

- deterministic shot ordering
- exact duration control
- subtitle overlays
- voice track placement
- music ducking under speech
- transition insertion
- end card composition

---

## 17. Quality Gates

Before an export is considered complete, QA should verify:

- correct aspect ratio
- correct duration
- readable subtitle placement
- language consistency
- required brand assets appear
- no missing audio tracks
- no missing shot renders
- final export files exist where expected

Additional quality heuristics should be recorded where practical, such as:

- whether the opening hook arrives early enough
- whether feature explanation remains legible
- whether the edit rhythm drags or rushes

The first implementation does not need perfect automatic creative scoring, but it should at least produce a structured QA report.

---

## 18. MVP Scope

The MVP should guarantee these capabilities:

1. ingest a complete marketing brief
2. accept user assets and supplement them with auto-collected support assets
3. generate a creative plan
4. split the campaign into roughly five executable shots
5. render those shots through `Seedance 2.0`
6. generate voiceover, music, and basic sound design
7. assemble a finished export
8. validate the export and write a QA report
9. support shot-level retry without rerunning the entire project

The MVP should not require:

- multi-user collaboration
- browser UI
- multi-provider video support
- a visual timeline editor

---

## 19. Risks and Mitigations

### Risk: synthetic shots look detached from the real product

Mitigation:

- classify product-critical shots as real-first
- use AI mainly for support, atmosphere, and transitions

### Risk: provider variability makes quality inconsistent

Mitigation:

- version prompts per shot
- retry at the shot level
- store output history for comparison

### Risk: full automation wastes credits on weak concepts

Mitigation:

- require a strong creative plan before generation starts
- keep local artifacts inspectable
- make reruns incremental rather than full-project by default

### Risk: generic architecture becomes too abstract before proving value

Mitigation:

- lock v1 to `Seedance 2.0`
- focus on one strong local pipeline
- keep extension points only where future growth is highly likely

---

## 20. Testing Strategy

The implementation plan should include tests for:

- brief parsing and normalization
- project state transitions
- shot job creation
- provider request and polling adapters
- retry logic
- timeline manifest generation
- export validation

In addition, the system needs manual golden-path tests using at least:

- one Huppy-style dark-tech campaign
- one campaign with a visibly different style preset

This ensures the system is not secretly overfit to a single sample brief.

---

## 21. Recommended Implementation Direction

The recommended v1 architecture is:

- `Node.js + TypeScript` orchestrator
- local filesystem project storage
- provider adapters for video and audio
- `ffmpeg` and `ffprobe` for assembly and export
- configuration-driven delivery profiles and style presets

This is the best balance for the approved scope because it:

- matches the existing workspace ecosystem
- supports future chat wrapping
- keeps media handling practical
- avoids premature platform complexity

---

## 22. Success Criteria

The design should be considered successful when a local user can:

1. provide a full app marketing brief and asset folder
2. choose a delivery profile and target market
3. run the workflow once
4. receive a coherent finished marketing video with voice, music, subtitles, and brand structure
5. rerun only a failed or weak shot without redoing the whole project

At that point, the system is ready for implementation planning and later productization.

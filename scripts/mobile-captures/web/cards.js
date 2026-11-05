const CARDS = [
  { file: "01-home", hero: true, video: true, title: ["Happy"], lines: ["One place for you, your team,", "and your agents."],
    pal: ["#2a0670", "#ff3d9a", "#ffa63d", "#3d5bff"], seed: 0.0, palName: "violet · magenta · orange · blue",
    screen: "Home on “Happy Team”: subtasks start, lines tick, one finishes unread", status: "v8 recording",
    beats: [
      ["0–20 s", "Shader drifts very slowly behind everything, the whole time"],
      ["0 s", "Home is busy: shimmer and braille spinners on the running work"],
      ["2 s", "A subtask starts under Activity Feed Design"],
      ["3–9 s", "Its line count ticks up, +8 → +52 −9; a second subtask starts"],
      ["11 s", "The first subtask finishes and asks for you: bold, unread"],
      ["11–18 s", "Settles"],
    ] },
  { file: "02-feed", title: ["Build", "together"], lines: ["See what your team and agents", "shipped, day by day."],
    pal: ["#06215a", "#1fd4f0", "#b6f03a", "#8b5cf6"], seed: 3.1, palName: "navy · teal · lime · violet",
    screen: "Feed › Activity, each row wearing a generated icon of what it is", status: "v8 capture" },
  { file: "03-model-accounts", title: ["Use all your", "subscriptions"], lines: ["Switch models and accounts", "mid-session."],
    pal: ["#3a0764", "#ff4d6d", "#ffc23d", "#b45cff"], seed: 6.7, palName: "plum · pink · gold · lilac",
    screen: "Model and account picker over a chat that already holds two braille renders and a 3-line highlighted fix", status: "v8 capture" },
  { file: "04-servers", title: ["Your computer", "and team servers"], lines: ["Add remote servers for", "yourself and your team."],
    pal: ["#03234a", "#2f6bff", "#14d9b0", "#f07cff"], seed: 9.4, palName: "navy · blue · aqua · orchid",
    screen: "Server menu open: MacBook Pro / Happy Team", status: "v8 capture" },
  { file: "05-voice", title: ["Call your", "agents"], lines: ["Real-time voice calls.", "20 free minutes every 30 days."],
    pal: ["#4a0628", "#ff6b8b", "#ff8a1f", "#6a5cff"], seed: 12.2, palName: "wine · coral · orange · indigo",
    screen: "Voice call over a chat with an inline weekly-retention chart, legend and caption", status: "v8 capture" },
];
// Approved static marketing copy. Update deliberately when refreshing the gallery.
const STARS = "24k";
const GITHUB = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>`;

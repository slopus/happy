/-!
# One agent's version, as `AgentUpdate.apply` and `AgentUpdate.keepingNewer` keep it

The daemon versions each agent: every change makes a new version, and the
versions of one agent only grow (UUIDv7, compared as strings). An
`agent.updated` carries the new `version` and the `previousVersion` it was
made from. The phone holds one version per agent it lists.

The server's history of one agent is `chain : Nat → Nat`, strictly
increasing: `chain k` is its `k`-th version, and the event for it carries
`previousVersion = chain (k - 1)` (none for the first).
-/

namespace SyncProofs.Versions

/-- What `AgentUpdate.apply` decides. -/
inductive Outcome where
  | applied (version : Nat)
  | unchanged
  | reread
  deriving DecidableEq, Repr

/-- What the phone holds of the agent the event names. -/
inductive Held where
  /-- No row lists it (a subagent home doesn't show). -/
  | absent
  /-- Listed, without a version: an older daemon's. -/
  | unversioned
  | at (version : Nat)
  deriving DecidableEq, Repr

/-- `AgentUpdate.apply` for one agent (`patch`, AgentUpdate.swift). -/
def decide (held : Held) (previous : Option Nat) (version : Nat) : Outcome :=
  match held with
  | .absent => .unchanged
  | .unversioned => .reread
  | .at h => if version ≤ h then .unchanged else if previous = some h then .applied version else .reread

/-- The version held after the outcome. -/
def after (h : Nat) (previous : Option Nat) (version : Nat) : Nat :=
  match decide (.at h) previous version with
  | .applied v => v
  | _ => h

/-! ## Facts that need no history -/

/-- An update is laid over the held copy only when it was made from it. -/
theorem applied_only_on_its_base {h : Nat} {p : Option Nat} {v w : Nat}
    (e : decide (.at h) p v = .applied w) : p = some h ∧ w = v ∧ h < v := by
  unfold decide at e
  by_cases a : v ≤ h
  · simp [a] at e
  · by_cases b : p = some h
    · simp [a, b] at e; exact ⟨b, e.symm, by omega⟩
    · simp [a, b] at e

/-- A version already held, or an older one, never asks for a read and
changes nothing: replays and late events are free. -/
theorem old_news_is_free {h p v} (le : v ≤ h) : decide (.at h) p v = .unchanged := by
  simp [decide, le]

/-- The held version never goes back. -/
theorem after_monotone (h : Nat) (p : Option Nat) (v : Nat) : h ≤ after h p v := by
  unfold after decide
  by_cases a : v ≤ h
  · simp [a]
  · by_cases b : p = some h <;> simp [a, b] <;> omega

/-- When an update doesn't ask for a read, the phone has it afterwards. -/
theorem no_read_means_current {h p v} (n : decide (.at h) p v ≠ .reread) : v ≤ after h p v := by
  unfold after
  unfold decide at n ⊢
  by_cases a : v ≤ h
  · simp [a]
  · by_cases b : p = some h
    · simp [a, b]
    · simp [a, b] at n

/-! ## Reads

`keepingNewer` lays a bootstrap read over what is held: the read's own
agents, each at the newer of the two versions. -/

/-- A read's version of the agent, merged with the held one. -/
def merge (held read : Nat) : Nat := max held read

theorem merge_keeps_held (h r : Nat) : h ≤ merge h r := Nat.le_max_left _ _
theorem merge_takes_read (h r : Nat) : r ≤ merge h r := Nat.le_max_right _ _
theorem merge_comm (a b : Nat) : merge a b = merge b a := Nat.max_comm _ _
theorem merge_assoc (a b c : Nat) : merge (merge a b) c = merge a (merge b c) := Nat.max_assoc _ _ _
theorem merge_idem (a : Nat) : merge a a = a := Nat.max_self _

/-- However reads and events interleave, the copy is the newest of all it
has seen: the order things arrive in never matters. -/
theorem merge_all (h : Nat) (reads : List Nat) :
    ∀ r ∈ reads, r ≤ reads.foldl merge h := by
  induction reads generalizing h with
  | nil => simp
  | cons r rs ih =>
    intro x hx
    simp only [List.foldl_cons]
    rcases List.mem_cons.mp hx with rfl | hx
    · exact Nat.le_trans (merge_takes_read h x) (foldl_ge _ _)
    · exact ih _ x hx
where
  foldl_ge (h : Nat) (rs : List Nat) : h ≤ rs.foldl merge h := by
    induction rs generalizing h with
    | nil => simp
    | cons r rs ih => exact Nat.le_trans (merge_keeps_held h r) (ih _)

/-! ## The server's history -/

/-- The agent's versions, oldest first. -/
structure Chain where
  version : Nat → Nat
  grows : ∀ {i j}, i < j → version i < version j

namespace Chain
variable (c : Chain)

/-- What the event for version `k` says it was made from. -/
def previous (k : Nat) : Option Nat := if k = 0 then none else some (c.version (k - 1))

theorem le_iff {i j} : c.version i ≤ c.version j ↔ i ≤ j := by
  constructor
  · intro le; apply Classical.byContradiction; intro n
    have := c.grows (show j < i by omega); omega
  · intro le
    rcases Nat.lt_or_eq_of_le le with lt | rfl
    · exact Nat.le_of_lt (c.grows lt)
    · exact Nat.le_refl _

theorem eq_iff {i j} : c.version i = c.version j ↔ i = j := by
  constructor
  · intro e
    have a := (c.le_iff).mp (Nat.le_of_eq e)
    have b := (c.le_iff).mp (Nat.le_of_eq e.symm)
    omega
  · intro e; rw [e]

theorem merge_on_chain (i j : Nat) : merge (c.version i) (c.version j) = c.version (max i j) := by
  unfold merge
  by_cases le : i ≤ j
  · rw [Nat.max_eq_right le, Nat.max_eq_right ((c.le_iff).mpr le)]
  · have : j ≤ i := by omega
    rw [Nat.max_eq_left this, Nat.max_eq_left ((c.le_iff).mpr this)]

/-- **A read is asked for exactly when the phone missed a version.**
Holding version `j`, the event for version `k` asks for the bootstrap
only when `k` is more than one past `j`: version `k - 1` never reached
the phone, so what it holds really is stale and can't be brought up to
date from the event. -/
theorem reread_iff_missed (j k : Nat) :
    decide (.at (c.version j)) (c.previous k) (c.version k) = .reread ↔ j + 1 < k := by
  unfold decide previous
  by_cases a : k ≤ j
  · simp [(c.le_iff).mpr a]; omega
  · have na : ¬ c.version k ≤ c.version j := fun h => a ((c.le_iff).mp h)
    simp only [na, ite_false]
    by_cases z : k = 0
    · omega
    · simp only [z, ite_false, Option.some.injEq, c.eq_iff]
      by_cases e : k - 1 = j <;> simp [e] <;> omega

theorem applied_iff_next (j k : Nat) :
    decide (.at (c.version j)) (c.previous k) (c.version k) = .applied (c.version k) ↔ k = j + 1 := by
  unfold decide previous
  by_cases a : k ≤ j
  · simp [(c.le_iff).mpr a]; omega
  · have na : ¬ c.version k ≤ c.version j := fun h => a ((c.le_iff).mp h)
    simp only [na, ite_false]
    by_cases z : k = 0
    · omega
    · simp only [z, ite_false, Option.some.injEq, c.eq_iff]
      by_cases e : k - 1 = j <;> simp [e] <;> omega

/-! ## A loop of events and reads

What reaches the phone: the event for version `k`, or a read that found
version `r` (a read can be older or newer than what is held, and come
at any time). The state is the index of the version held. -/

inductive Input where
  | event (k : Nat)
  | read (r : Nat)

/-- One input: the index held after it, and whether it asked for a read. -/
def step (j : Nat) : Input → Nat × Bool
  | .event k =>
    match decide (.at (c.version j)) (c.previous k) (c.version k) with
    | .applied _ => (k, false)
    | .unchanged => (j, false)
    | .reread => (j, true)
  | .read r => (max j r, false)

/-- The index held after the inputs, and how many reads they asked for. -/
def run : Nat → List Input → Nat × Nat
  | j, [] => (j, 0)
  | j, i :: is =>
    let (j', asked) := c.step j i
    let (final, reads) := run j' is
    (final, reads + if asked then 1 else 0)

/-- The events come in order from `next` on, with reads anywhere between:
the stream from a cursor, which never skips one. -/
def InOrder : Nat → List Input → Prop
  | _, [] => True
  | next, .event k :: is => k = next ∧ InOrder (next + 1) is
  | next, .read _ :: is => InOrder next is

theorem step_monotone (j : Nat) (i : Input) : j ≤ (c.step j i).1 := by
  cases i with
  | read r => exact Nat.le_max_left _ _
  | event k =>
    simp only [step]
    by_cases a : k ≤ j
    · have : decide (.at (c.version j)) (c.previous k) (c.version k) = .unchanged := by
        simp [decide, (c.le_iff).mpr a]
      simp [this]
    · by_cases n : k = j + 1
      · rw [(c.applied_iff_next j k).mpr n]; simp; omega
      · have : j + 1 < k := by omega
        rw [(c.reread_iff_missed j k).mpr this]; exact Nat.le_refl _

/-- **Nothing fresh is ever read again.** Starting from a copy that has
every version before the stream's first event (the bootstrap read before
its cursor), an unbroken stream asks for no read at all, however reads
are interleaved, and the copy ends with the last version streamed and
everything any read found. -/
theorem in_order_never_rereads :
    ∀ (is : List Input) (j next : Nat), next ≤ j + 1 → InOrder next is →
      (c.run j is).2 = 0 ∧ j ≤ (c.run j is).1 := by
  intro is
  induction is with
  | nil => intro j _ _ _; simp [run]
  | cons i is ih =>
    intro j next hn ho
    cases i with
    | read r =>
      have := ih (max j r) next (by omega) ho
      simp only [run, step]
      exact ⟨by simpa using this.1, Nat.le_trans (Nat.le_max_left _ _) this.2⟩
    | event k =>
      obtain ⟨rfl, ho⟩ := ho
      by_cases a : k ≤ j
      · have d : decide (.at (c.version j)) (c.previous k) (c.version k) = .unchanged := by
          simp [decide, (c.le_iff).mpr a]
        have := ih j (k + 1) (by omega) ho
        simp only [run, step, d]
        exact ⟨by simpa using this.1, this.2⟩
      · have n : k = j + 1 := by omega
        have d := (c.applied_iff_next j k).mpr n
        have := ih k (k + 1) (by omega) ho
        simp only [run, step, d]
        exact ⟨by simpa using this.1, by omega⟩

end Chain
end SyncProofs.Versions

/-!
# Home's refresh loop (`SyncEngine.scheduleReconcile` and `reconcile`)

The computer's state is `server`, a version that only grows; home shows
`held`. Some news is laid over `held` at once (an `agent.updated` made
from the held version, `AgentUpdate`); the rest marks home stale
(`dirty`), and one loop reads the bootstrap while it is: a read takes the
server as it was when it began (`pending`) and, when it lands, is merged
into what is held (`keepingNewer`, the newer of each).

This is the loop as the code runs it:

```
signal:  dirty = true; if refresh == nil { start the loop }
loop:    while dirty { sleep 200 ms; dirty = false; try read }   -- begin
         read lands → merged                                       -- finish
         read fails → dirty = true, back off                       -- fail
         dirty false → refresh = nil                               -- exit
```
-/

namespace SyncProofs.Refresh

structure S where
  server : Nat
  held : Nat
  dirty : Bool
  running : Bool
  inflight : Bool
  pending : Nat
  /-- Times home went from fresh to stale. -/
  raises : Nat
  reads : Nat
  /-- News that couldn't be laid over the held copy. -/
  signals : Nat
  failures : Nat

def init : S := ⟨0, 0, false, false, false, 0, 0, 0, 0, 0⟩

inductive Step : S → S → Prop where
  /-- The computer changed and said so in a way the phone can't apply. -/
  | change (s : S) (v : Nat) (newer : s.server < v) :
      Step s { s with server := v, dirty := true, running := true,
                      raises := s.raises + (if s.dirty then 0 else 1), signals := s.signals + 1 }
  /-- The stream came back with a gap, or from another process: news may
  have been missed, so home is stale. (Back without either, the stream
  replays what was missed as `change` and `applied` steps, and nothing
  else happens.) -/
  | gap (s : S) :
      Step s { s with dirty := true, running := true,
                      raises := s.raises + (if s.dirty then 0 else 1), signals := s.signals + 1 }
  /-- The computer changed and the event was made from what home holds:
  laid over it, no read. -/
  | applied (s : S) (v : Nat) (newer : s.server < v) (current : s.server ≤ s.held) :
      Step s { s with server := v, held := v }
  | begin (s : S) (r : s.running = true) (d : s.dirty = true) (i : s.inflight = false) :
      Step s { s with dirty := false, inflight := true, pending := s.server, reads := s.reads + 1 }
  /-- A read landed: always merged. -/
  | finish (s : S) (i : s.inflight = true) :
      Step s { s with inflight := false, held := max s.held s.pending }
  | fail (s : S) (i : s.inflight = true) :
      Step s { s with inflight := false, dirty := true,
                      raises := s.raises + (if s.dirty then 0 else 1), failures := s.failures + 1 }
  | exit (s : S) (r : s.running = true) (d : s.dirty = false) (i : s.inflight = false) :
      Step s { s with running := false }

structure Inv (s : S) : Prop where
  inflight_running : s.inflight = true → s.running = true
  dirty_running : s.dirty = true → s.running = true
  accounting : s.reads + (if s.dirty then 1 else 0) = s.raises
  raises_le : s.raises ≤ s.signals + s.failures
  held_le : s.held ≤ s.server
  pending_le : s.pending ≤ s.server
  fresh : s.dirty = false → s.server ≤ s.held ∨ (s.inflight = true ∧ s.server ≤ s.pending)

theorem inv_init : Inv init := by
  constructor <;> simp [init]

theorem inv_step {s t : S} (h : Inv s) (st : Step s t) : Inv t := by
  obtain ⟨h1, h2, h3, h4, h5, h6, h7⟩ := h
  cases st with
  | change v newer =>
    constructor <;> simp_all
    · cases hd : s.dirty <;> simp_all
    · cases hd : s.dirty <;> simp_all <;> omega
    · omega
    · omega
  | gap =>
    constructor <;> simp_all
    · cases hd : s.dirty <;> simp_all
    · cases hd : s.dirty <;> simp_all <;> omega
  | applied v newer current =>
    constructor <;> simp_all <;> omega
  | begin r d i =>
    constructor <;> simp_all
  | finish i =>
    constructor <;> simp_all
    · omega
    · intro hd
      rcases h7 hd with a | b <;> omega
  | fail i =>
    constructor <;> simp_all
    · cases hd : s.dirty <;> simp_all
    · cases hd : s.dirty <;> simp_all <;> omega
  | exit r d i =>
    constructor <;> simp_all

inductive Reach : S → Prop where
  | init : Reach init
  | step {s t} : Reach s → Step s t → Reach t

theorem reach_inv {s} (r : Reach s) : Inv s := by
  induction r with
  | init => exact inv_init
  | step _ st ih => exact inv_step ih st

/-- The loop has nothing left to do. -/
def Quiet (s : S) : Prop :=
  ¬ (s.running = true ∧ s.dirty = true ∧ s.inflight = false) ∧ s.inflight = false ∧
  ¬ (s.running = true ∧ s.dirty = false ∧ s.inflight = false)

/-- **Every change reaches home.** Once the loop has nothing left to do,
home holds exactly what the computer has: no news was dropped, however
changes, reads, failures and exits interleaved. -/
theorem quiet_is_current {s} (r : Reach s) (q : Quiet s) : s.held = s.server := by
  have h := reach_inv r
  obtain ⟨q1, q2, _⟩ := q
  have nd : s.dirty = false := by
    cases hd : s.dirty
    · rfl
    · exact absurd ⟨h.dirty_running hd, hd, q2⟩ q1
  rcases h.fresh nd with a | ⟨b, _⟩
  · have := h.held_le; omega
  · simp [q2] at b

/-- **Back on the stream with nothing stale, nothing needs reading.**
With no stale news outstanding and no read on its way (in the code: the
newest read taken began after the last news it couldn't apply,
`covered == signalled`), home already holds what the computer has; what
changed while away arrives as the stream replays it. So the reconnect
reads neither home nor any conversation (`SyncEngine.run`'s `resuming`). -/
theorem resume_is_current {s} (r : Reach s) (d : s.dirty = false) (i : s.inflight = false) :
    s.held = s.server := by
  have h := reach_inv r
  rcases h.fresh d with a | ⟨b, _⟩
  · have := h.held_le; omega
  · simp [i] at b

/-- **Nothing is read unless something is stale.** Every read answers
news that couldn't be applied, or retries a read that failed. -/
theorem reads_le {s} (r : Reach s) : s.reads ≤ s.signals + s.failures := by
  have h := reach_inv r
  have := h.accounting; have := h.raises_le
  split at * <;> omega

theorem no_staleness_no_reads {s} (r : Reach s) (h0 : s.signals = 0) (f0 : s.failures = 0) : s.reads = 0 := by
  have := reads_le r; omega

/-- **News while a read is on its way costs one more read, not one each.**
A read is begun only for a change from fresh to stale. -/
theorem reads_count_raises {s} (r : Reach s) : s.reads ≤ s.raises :=
  by have := (reach_inv r).accounting; split at * <;> omega

/-- Applied news never asks for a read. -/
theorem applied_reads_nothing (s : S) (v : Nat) (_n : s.server < v) (_c : s.server ≤ s.held) :
    ({ s with server := v, held := v } : S).reads = s.reads := rfl

/-! ## What changed: a read is merged even when news came during it

The loop used to keep a read only when nothing had marked home stale
while it was on its way (`guard self.revision == revision else { return }`)
and drop it otherwise. While agents worked, news came several times a
second, so every read was dropped and home showed what it held before
the work began until the work stopped. Here is one turn of the loop
when news comes during each read, both ways: `(held, server)`. -/

/-- `f` applied `n` times. -/
def turns (f : α → α) : Nat → α → α
  | 0, x => x
  | n + 1, x => f (turns f n x)

def droppedTurn : Nat × Nat → Nat × Nat := fun (h, v) => (h, v + 1)
def mergedTurn : Nat × Nat → Nat × Nat := fun (h, v) => (max h v, v + 1)

theorem dropped_never_moves (n : Nat) : (turns droppedTurn n (0, 0)).1 = 0 := by
  induction n with
  | zero => rfl
  | succ n ih =>
    simp [turns, droppedTurn] at *; exact ih

theorem merged_keeps_up (n : Nat) : turns mergedTurn n (0, 0) = (n - 1, n) := by
  induction n with
  | zero => rfl
  | succ n ih =>
    simp only [turns, ih, mergedTurn]; simp

/-- `mergedTurn` is what the loop does: begin, news during the read, the
read lands. -/
theorem merged_turn_is_the_loop (s : S) (r : s.running = true) (d : s.dirty = true) (i : s.inflight = false) :
    ∃ s1 s2 s3, Step s s1 ∧ Step s1 s2 ∧ Step s2 s3 ∧
      (s3.held, s3.server) = mergedTurn (s.held, s.server) := by
  let s1 : S := { s with dirty := false, inflight := true, pending := s.server, reads := s.reads + 1 }
  let s2 : S := { s1 with server := s1.server + 1, dirty := true, running := true,
                          raises := s1.raises + (if s1.dirty then 0 else 1), signals := s1.signals + 1 }
  let s3 : S := { s2 with inflight := false, held := max s2.held s2.pending }
  refine ⟨s1, s2, s3, Step.begin s r d i, Step.change s1 _ (Nat.lt_succ_self _), Step.finish s2 rfl, ?_⟩
  simp [s1, s2, s3, mergedTurn]

end SyncProofs.Refresh

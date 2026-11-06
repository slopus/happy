/-!
# A streamed word laid on its message (`Conversation.grow`)

`message.delta` says: block `blockIndex` of message `messageId` reads
`append` from UTF-16 offset `offset` on. The phone lays it on the copy it
holds: an append at the end grows it, a replay (already held) changes
nothing, an overlap adds only what is missing; an offset past the end
(words never received) or text that disagrees reads the conversation
again (`reconcile`).

A block's text is a list of UTF-16 units. On the computer it is `t`, and
only grows. The phone holds a prefix of it, `t.take n`, and a delta is a
slice of it: `(t.drop o).take m`.
-/

namespace SyncProofs.Delta

variable {α : Type} [DecidableEq α]

/-- `Conversation.grow` on one block's units. -/
def grow (s : List α) (o : Nat) (a : List α) : Option (List α) :=
  if s.length < o then none else
  let after := s.drop o
  if after = [] then some (s ++ a)
  else if a.length ≤ after.length then (if after.take a.length = a then some s else none)
  else if a.take after.length = after then some (s ++ a.drop after.length) else none

/-- **A word that follows what is held is merged.** Whatever the phone
holds of the block (a prefix of it) and whichever of the computer's
deltas arrives, as long as it starts within what is held, the result is
again the computer's text, through the end of the delta or of what was
held, whichever is further. Replays, late duplicates and overlaps all
land here. -/
theorem grow_merges (t : List α) (n o m : Nat) (hn : n ≤ t.length) (hm : o + m ≤ t.length) (ho : o ≤ n) :
    grow (t.take n) o ((t.drop o).take m) = some (t.take (max n (o + m))) := by
  have ls : (t.take n).length = n := by simp [List.length_take]; omega
  have la : ((t.drop o).take m).length = m := by simp [List.length_take, List.length_drop]; omega
  have after : (t.take n).drop o = (t.drop o).take (n - o) := List.drop_take
  have lafter : ((t.drop o).take (n - o)).length = n - o := by simp [List.length_take, List.length_drop]; omega
  unfold grow
  simp only [ls, la, after, lafter]
  have nlt : ¬ n < o := by omega
  simp only [nlt, ite_false]
  by_cases e : n = o
  · subst e
    have : (t.drop n).take (n - n) = [] := by simp
    simp only [this, ite_true]
    rw [← List.take_add]; congr 2; omega
  · have ne : (t.drop o).take (n - o) ≠ [] := by
      intro h; have := congrArg List.length h; simp at this; omega
    simp only [ne, ite_false]
    by_cases le : m ≤ n - o
    · simp only [le, ite_true, List.take_take, Nat.min_eq_left le]
      congr 2; omega
    · simp only [le, ite_false, List.take_take, Nat.min_eq_left (show n - o ≤ m by omega)]
      simp only [ite_true]
      rw [List.drop_take, List.drop_drop, show o + (n - o) = n by omega,
          show t.take n = t.take n from rfl, ← List.take_add]
      congr 2; omega

/-- **The conversation is read again only for words it never got.** For
any of the computer's deltas, `grow` gives up exactly when the delta
starts past the end of what is held. -/
theorem grow_gives_up_iff_gap (t : List α) (n o m : Nat) (hn : n ≤ t.length) (hm : o + m ≤ t.length) :
    grow (t.take n) o ((t.drop o).take m) = none ↔ n < o := by
  constructor
  · intro h
    apply Classical.byContradiction; intro no
    rw [grow_merges t n o m hn hm (by omega)] at h
    simp at h
  · intro lt
    have ls : (t.take n).length = n := by simp [List.length_take]; omega
    simp [grow, ls, lt]

/-- Laying the same delta again changes nothing: events held during a
read and applied after it are free. -/
theorem replay_is_free (t : List α) (n o m : Nat) (hn : n ≤ t.length) (hm : o + m ≤ t.length) (ho : o ≤ n) :
    grow (t.take (max n (o + m))) o ((t.drop o).take m) = some (t.take (max n (o + m))) := by
  have := grow_merges t (max n (o + m)) o m (by omega) hm (by omega)
  rw [this]; congr 2; omega

end SyncProofs.Delta

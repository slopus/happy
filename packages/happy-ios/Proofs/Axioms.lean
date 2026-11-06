import SyncProofs

/-! Prints the axioms each main theorem rests on. `check.sh` fails on
anything beyond Lean's `propext`, `Classical.choice` and `Quot.sound`
(an unfinished proof shows `sorryAx`). -/

open SyncProofs

#print axioms Versions.applied_only_on_its_base
#print axioms Versions.old_news_is_free
#print axioms Versions.after_monotone
#print axioms Versions.no_read_means_current
#print axioms Versions.merge_all
#print axioms Versions.Chain.reread_iff_missed
#print axioms Versions.Chain.applied_iff_next
#print axioms Versions.Chain.step_monotone
#print axioms Versions.Chain.in_order_never_rereads
#print axioms Refresh.inv_step
#print axioms Refresh.quiet_is_current
#print axioms Refresh.resume_is_current
#print axioms Refresh.reads_le
#print axioms Refresh.no_staleness_no_reads
#print axioms Refresh.reads_count_raises
#print axioms Refresh.dropped_never_moves
#print axioms Refresh.merged_keeps_up
#print axioms Refresh.merged_turn_is_the_loop
#print axioms Delta.grow_merges
#print axioms Delta.grow_gives_up_iff_gap
#print axioms Delta.replay_is_free

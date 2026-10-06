-- Entries disqualified with the "show at bottom" disposition are published
-- without a score and with vote_count = 0 (see 11_review_enhancements.sql),
-- but the original check from 07 still required vote_count > 0, so
-- publishing failed whenever such an entry existed. Ranked entries must
-- still have at least one complete ballot.
alter table public.published_competition_results
  drop constraint published_competition_results_vote_count_check;

alter table public.published_competition_results
  add constraint published_competition_results_vote_count_check
    check (vote_count >= 0 and (is_disqualified or vote_count > 0));

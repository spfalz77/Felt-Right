-- Guest hosting: shown to guests as "in development"; switched on by hand
-- after store launch (decided 2026-11-17). coming_soon with no threshold
-- never flips by itself.
update public.feature_flags
   set state = 'coming_soon', threshold = null,
       note = 'In development: guests can host after store launch (switched on by hand)',
       updated_at = now()
 where key = 'guest_hosting';

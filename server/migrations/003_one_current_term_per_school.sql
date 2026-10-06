UPDATE terms t
SET is_current=false,updated_at=now()
FROM academic_years ay
WHERE ay.id=t.academic_year_id AND ay.school_id=t.school_id
  AND t.is_current=true AND ay.is_current=false;

WITH ranked_current_terms AS (
  SELECT t.id,
         row_number() OVER (
           PARTITION BY t.school_id
           ORDER BY ay.is_current DESC, t.start_date DESC, t.created_at DESC, t.id
         ) AS position
  FROM terms t
  JOIN academic_years ay ON ay.id=t.academic_year_id AND ay.school_id=t.school_id
  WHERE t.is_current=true
)
UPDATE terms t
SET is_current=false, updated_at=now()
FROM ranked_current_terms ranked
WHERE ranked.id=t.id AND ranked.position>1;

CREATE UNIQUE INDEX IF NOT EXISTS one_current_term_per_school
  ON terms (school_id)
  WHERE is_current=true;

-- Fase 5.16.1: indice de cobertura da FK apontado pelo Performance Advisor.
create index if not exists idx_living_world_settings_updated_by
  on public.living_world_settings(updated_by);

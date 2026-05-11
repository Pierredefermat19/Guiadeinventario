-- ═══════════════════════════════════════════════════════════════════
-- pg_cron: Generación automática de tareas diarias
-- Pegar en Supabase → SQL Editor → Run (una sola vez)
-- ═══════════════════════════════════════════════════════════════════

-- 1. Habilitar extensiones requeridas
create extension if not exists pg_cron;
create extension if not exists pg_net;   -- solo si se quiere hacer HTTP calls en el futuro

-- 2. Función que genera las tareas del día
--    Crea UNA tarea por cada template activo, si no existe ya una para hoy.
--    Idempotente: ejecutar dos veces en el mismo día no duplica tareas.
create or replace function generate_daily_tasks()
returns table(created_count int, skipped_count int)
language plpgsql
security definer
as $$
declare
  v_created  int := 0;
  v_skipped  int := 0;
  v_template record;
  v_today    date := current_date;
begin
  for v_template in
    select id, warehouse_id, title, description
    from   task_templates
    where  is_active = true
  loop
    -- Solo inserta si no existe ya una tarea de este template para hoy
    if not exists (
      select 1 from tasks
      where  template_id   = v_template.id
        and  scheduled_for::date = v_today
    ) then
      insert into tasks (
        warehouse_id,
        template_id,
        title,
        description,
        status,
        scheduled_for,
        after_photo_required,
        created_at
      )
      values (
        v_template.warehouse_id,
        v_template.id,
        v_template.title,
        v_template.description,
        'disponible',
        v_today::timestamp,
        true,
        now()
      );

      v_created := v_created + 1;
    else
      v_skipped := v_skipped + 1;
    end if;
  end loop;

  return query select v_created, v_skipped;
end;
$$;

-- 3. Smoke test (ejecutar para verificar que la función funciona):
--    select * from generate_daily_tasks();

-- 4. Programar el cron: todos los días a las 00:01 (hora UTC)
--    Ajusta la hora según tu zona: Chile = UTC-3 en verano, UTC-4 en invierno
--    00:01 UTC = 21:01 (verano) / 20:01 (invierno) hora Chile
--    Si quieres que las tareas aparezcan al inicio de la jornada laboral (08:00 Chile),
--    usa: '0 11 * * *' (08:00 Chile verano = 11:00 UTC)
select cron.schedule(
  'generate-daily-tasks',          -- nombre único del job
  '1 0 * * *',                     -- cada día a las 00:01 UTC
  $$ select generate_daily_tasks() $$
);

-- 5. Para ver los jobs programados:
--    select jobid, jobname, schedule, command from cron.job;

-- 6. Para eliminar el job (si necesitas recrearlo):
--    select cron.unschedule('generate-daily-tasks');

-- 7. Para ver el historial de ejecuciones:
--    select * from cron.job_run_details order by start_time desc limit 20;

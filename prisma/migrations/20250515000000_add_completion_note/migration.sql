-- Add completion_note to tasks
ALTER TABLE "tasks" ADD COLUMN IF NOT EXISTS "completion_note" TEXT;

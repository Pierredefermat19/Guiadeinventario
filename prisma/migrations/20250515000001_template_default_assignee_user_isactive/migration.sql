-- Add default_assignee_id to task_templates
ALTER TABLE "task_templates"
  ADD COLUMN IF NOT EXISTS "default_assignee_id" UUID REFERENCES "users"("id") ON DELETE SET NULL;

-- Add is_active to users (was missing from User model)
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "is_active" BOOLEAN NOT NULL DEFAULT TRUE;

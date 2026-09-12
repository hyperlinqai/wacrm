// ============================================================
// Automations for the public API, decoupled from auth.
//
// The dashboard routes under /api/automations authenticate a human via
// cookies and scope rows by `user_id`; an API key has no user session and
// belongs to an *account*, so everything here is account-scoped instead —
// the same discipline the other /api/v1 modules follow. The tree <-> rows
// conversion and the activation validation are shared with the dashboard
// (steps-tree.ts, validate.ts) so both surfaces accept exactly the same
// payloads and refuse the same broken ones.
// ============================================================

import type { SupabaseClient } from '@wacrm/shared/db';

import {
  insertSteps,
  loadStepsTree,
  replaceSteps,
  type BuilderStepInput,
} from '@/lib/automations/steps-tree';
import {
  validateStepsForActivation,
  validateTriggerForActivation,
  type ValidationIssue,
} from '@/lib/automations/validate';

export const AUTOMATION_SELECT =
  'id, name, description, trigger_type, trigger_config, is_active, execution_count, last_executed_at, created_at, updated_at';

export class AutomationError extends Error {
  readonly status: number;
  readonly issues?: ValidationIssue[];

  constructor(message: string, status: number, issues?: ValidationIssue[]) {
    super(message);
    this.name = 'AutomationError';
    this.status = status;
    this.issues = issues;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AutomationInput {
  name?: unknown;
  description?: unknown;
  trigger_type?: unknown;
  trigger_config?: unknown;
  is_active?: unknown;
  steps?: unknown;
}

function asSteps(value: unknown): BuilderStepInput[] | undefined {
  return Array.isArray(value) ? (value as BuilderStepInput[]) : undefined;
}

/** Refuse to activate a configuration the engine would only fail on at run time. */
function assertActivatable(
  triggerType: string,
  triggerConfig: unknown,
  steps: { step_type: string; step_config: Record<string, unknown> }[],
): void {
  const issues = [
    ...validateTriggerForActivation(triggerType, triggerConfig ?? {}),
    ...validateStepsForActivation(steps),
  ];
  if (issues.length > 0) {
    throw new AutomationError('Automation configuration is not valid to activate', 400, issues);
  }
}

/** Ownership check: a row from another account reads as "not found". */
async function loadOwned(db: SupabaseClient, accountId: string, id: string) {
  if (!UUID_RE.test(id)) throw new AutomationError('Automation not found', 404);
  const { data, error } = await db
    .from('automations')
    .select('id, name, is_active, trigger_type, trigger_config')
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/automations] lookup error:', error);
    throw new AutomationError('Failed to read automation', 500);
  }
  if (!data) throw new AutomationError('Automation not found', 404);
  return data;
}

export async function getAutomation(db: SupabaseClient, accountId: string, id: string) {
  if (!UUID_RE.test(id)) throw new AutomationError('Automation not found', 404);
  const { data, error } = await db
    .from('automations')
    .select(AUTOMATION_SELECT)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/automations] read error:', error);
    throw new AutomationError('Failed to read automation', 500);
  }
  if (!data) throw new AutomationError('Automation not found', 404);
  return { ...data, steps: await loadStepsTree(id) };
}

export async function createAutomation(
  db: SupabaseClient,
  accountId: string,
  organizationId: string,
  userId: string,
  body: AutomationInput,
) {
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const triggerType = typeof body.trigger_type === 'string' ? body.trigger_type : '';
  if (!name) throw new AutomationError("'name' is required", 400);
  if (!triggerType) throw new AutomationError("'trigger_type' is required", 400);

  const steps = asSteps(body.steps) ?? [];
  const isActive = body.is_active === true;
  if (isActive) {
    assertActivatable(triggerType, body.trigger_config, steps as never);
  }

  const { data, error } = await db
    .from('automations')
    .insert({
      account_id: accountId,
      organization_id: organizationId,
      // Audit only — the automation belongs to the account, not this user.
      user_id: userId,
      name,
      description: typeof body.description === 'string' ? body.description : null,
      trigger_type: triggerType,
      trigger_config: (body.trigger_config as Record<string, unknown>) ?? {},
      is_active: isActive,
    })
    .select(AUTOMATION_SELECT)
    .single();

  if (error || !data) {
    console.error('[api/v1/automations] insert error:', error);
    throw new AutomationError(error?.message ?? 'Failed to create automation', 500);
  }

  if (steps.length > 0) {
    const stepErr = await insertSteps(data.id as string, steps);
    if (stepErr) throw new AutomationError(`Automation saved but steps failed: ${stepErr}`, 500);
  }

  return { ...data, steps: await loadStepsTree(data.id as string) };
}

export async function updateAutomation(
  db: SupabaseClient,
  accountId: string,
  id: string,
  body: AutomationInput,
) {
  const existing = await loadOwned(db, accountId, id);

  const update: Record<string, unknown> = {};
  if (typeof body.name === 'string') update.name = body.name.trim();
  if ('description' in body) update.description = typeof body.description === 'string' ? body.description : null;
  if (typeof body.trigger_type === 'string') update.trigger_type = body.trigger_type;
  if ('trigger_config' in body) update.trigger_config = body.trigger_config ?? {};
  if (typeof body.is_active === 'boolean') update.is_active = body.is_active;

  const steps = asSteps(body.steps);
  const willBeActive = typeof update.is_active === 'boolean' ? update.is_active : existing.is_active;
  if (willBeActive) {
    assertActivatable(
      (update.trigger_type ?? existing.trigger_type) as string,
      update.trigger_config ?? existing.trigger_config,
      (steps ?? (await loadStepsTree(id))) as never,
    );
  }

  if (Object.keys(update).length > 0) {
    update.updated_at = new Date().toISOString();
    const { error } = await db.from('automations').update(update).eq('id', id).eq('account_id', accountId);
    if (error) {
      console.error('[api/v1/automations] update error:', error);
      throw new AutomationError(error.message, 500);
    }
  }

  if (steps) {
    const stepErr = await replaceSteps(id, steps);
    if (stepErr) throw new AutomationError(`Automation saved but steps failed: ${stepErr}`, 500);
  }

  return getAutomation(db, accountId, id);
}

export async function deleteAutomation(db: SupabaseClient, accountId: string, id: string) {
  await loadOwned(db, accountId, id);
  const { error } = await db.from('automations').delete().eq('id', id).eq('account_id', accountId);
  if (error) {
    console.error('[api/v1/automations] delete error:', error);
    throw new AutomationError(error.message, 500);
  }
}

/** Run history for one automation, newest first. */
export async function listAutomationLogs(
  db: SupabaseClient,
  accountId: string,
  id: string,
  limit: number,
) {
  await loadOwned(db, accountId, id);
  const { data, error } = await db
    .from('automation_logs')
    .select('id, contact_id, trigger_event, status, error_message, steps_executed, created_at, contact:contacts(id, name, phone)')
    .eq('automation_id', id)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error('[api/v1/automations] logs error:', error);
    throw new AutomationError('Failed to read automation logs', 500);
  }
  return data ?? [];
}

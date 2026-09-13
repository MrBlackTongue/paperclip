import { and, eq, inArray, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { conflict } from "../errors.js";

type Workspace = typeof executionWorkspaces.$inferSelect;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
export const sharedSourceIssueKey = "sharedSessionSourceIssueId";
export const sharedSourceRunKey = "sharedSessionRunId";

export function sharedWorkspaceIssueTree(workspace: Pick<Workspace, "id" | "companyId" | "sourceIssueId">) {
  return sql`WITH RECURSIVE shared_holders(id, status, checkout_run_id, execution_run_id) AS (
    SELECT root.id, root.status, root.checkout_run_id, root.execution_run_id
    FROM ${issues} root
    WHERE root.company_id = ${workspace.companyId}
      AND (root.id = ${workspace.sourceIssueId} OR root.execution_workspace_id = ${workspace.id})
    UNION
    SELECT child.id, child.status, child.checkout_run_id, child.execution_run_id
    FROM ${issues} child JOIN shared_holders parent ON child.parent_id = parent.id
    WHERE child.company_id = ${workspace.companyId}
  )`;
}

export function sharedWorkspaceHoldersAreTerminal(workspace: Workspace) {
  return sql`NOT EXISTS (${sharedWorkspaceIssueTree(workspace)}
    SELECT 1 FROM shared_holders WHERE status NOT IN ('done', 'cancelled'))`;
}

export function sharedWorkspaceHasNoLiveRuns(workspace: Workspace) {
  const sourceId = workspace.sourceIssueId ?? workspace.metadata?.[sharedSourceIssueKey] ?? null;
  const runId = workspace.metadata?.[sharedSourceRunKey] ?? null;
  return sql`NOT EXISTS (${sharedWorkspaceIssueTree(workspace)}
    SELECT 1 FROM ${heartbeatRuns} live_run
    WHERE live_run.company_id = ${workspace.companyId}
      AND live_run.status IN ('queued', 'running')
      AND (live_run.id::text = ${runId}
        OR live_run.context_snapshot ->> 'issueId' = ${sourceId}
        OR live_run.context_snapshot ->> 'executionWorkspaceId' = ${workspace.id}
        OR live_run.id IN (SELECT checkout_run_id FROM shared_holders)
        OR live_run.id IN (SELECT execution_run_id FROM shared_holders)))`;
}

/** Use the same lock as the reaper when introducing a new direct holder. */
export async function lockSharedWorkspaceBinding(tx: Transaction, companyId: string, workspaceId: string | null | undefined, allowClosed = false) {
  if (!workspaceId) return true;
  const [workspace] = await tx.select({ mode: executionWorkspaces.mode }).from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId)));
  if (workspace?.mode !== "shared_workspace") return true;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspaceId}`}, 0))`);
  const [open] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId),
    inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
    sql`${executionWorkspaces.closedAt} IS NULL`,
  ));
  if (!open && !allowClosed) throw conflict("Cannot bind an archived shared workspace; resolve a replacement first");
  return Boolean(open);
}

/** Keep the terminality/run evidence before the FK clears source_issue_id. */
export async function preserveDeletedSharedWorkspaceOwner(tx: Transaction, issueId: string) {
  const [source] = await tx.select().from(issues).where(eq(issues.id, issueId)).for("update");
  if (!source) return;
  const workspaces = await tx.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.companyId, source.companyId), eq(executionWorkspaces.sourceIssueId, source.id),
    eq(executionWorkspaces.mode, "shared_workspace"),
  )).orderBy(executionWorkspaces.id);
  for (const workspace of workspaces) {
    await lockSharedWorkspaceBinding(tx, source.companyId, workspace.id, true);
    // JSON merge preserves any lifecycle fence published while we waited.
    const evidence = JSON.stringify({ [sharedSourceIssueKey]: source.id,
      [sharedSourceRunKey]: source.executionRunId ?? source.checkoutRunId ?? workspace.metadata?.[sharedSourceRunKey] ?? null });
    await tx.update(executionWorkspaces).set({
      metadata: sql`COALESCE(${executionWorkspaces.metadata}, '{}'::jsonb) || ${evidence}::jsonb`,
    }).where(eq(executionWorkspaces.id, workspace.id));
  }
}

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { sharedSourceIssueKey, sharedSourceRunKey } from "./shared-workspace-holders.js";

const execFileAsync = promisify(execFile);
const identityMetadataKey = "sharedSessionIdentity";
type WorkspaceInsert = typeof executionWorkspaces.$inferInsert;
type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** A path alone cannot identify a checkout, branch, or runtime environment. */
export async function captureSharedWorkspaceIdentity(input: {
  cwd: string;
  environmentId: string;
  environmentDriver: string;
  configFingerprint: string;
}): Promise<string | null> {
  if (input.environmentDriver !== "local" || !input.environmentId || !input.configFingerprint) return null;
  try {
    const cwd = await fs.realpath(input.cwd);
    const stat = await fs.stat(cwd);
    if (!stat.isDirectory()) return null;
    const ceilings = new Set((process.env.GIT_CEILING_DIRECTORIES ?? "")
      .split(path.delimiter).filter(Boolean).map((entry) => path.resolve(entry)));
    let ancestor = cwd;
    let hasGit = false;
    while (true) {
      try {
        await fs.lstat(path.join(ancestor, ".git"));
        hasGit = true;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") return null;
      }
      const parent = path.dirname(ancestor);
      if (parent === ancestor || ceilings.has(parent)) break;
      ancestor = parent;
    }
    let gitIdentity: string[] | null = null;
    if (hasGit) {
      const git = async (args: string[]) => (await execFileAsync("git", args, {
        cwd, timeout: 10_000, maxBuffer: 64 * 1024,
      })).stdout.trim();
      const gitDir = await fs.realpath(await git(["rev-parse", "--absolute-git-dir"]));
      let branch: string;
      try {
        branch = await git(["symbolic-ref", "--quiet", "HEAD"]);
      } catch (error) {
        if ((error as { code?: number }).code !== 1) return null;
        branch = `detached:${await git(["rev-parse", "--verify", "HEAD"])}`;
      }
      gitIdentity = [gitDir, branch];
    }
    return createHash("sha256").update(JSON.stringify([
      1, cwd, stat.dev, stat.ino, gitIdentity, input.environmentId, input.configFingerprint,
    ])).digest("hex");
  } catch {
    // An inaccessible or ambiguous environment must never be merged by guessing.
    return null;
  }
}

export function sharedWorkspaceReuseKey(data: WorkspaceInsert, identity: string | null): string | null {
  if (!identity || !data.sourceIssueId || data.mode !== "shared_workspace"
    || data.strategyType !== "project_primary" || data.providerType !== "local_fs"
    || data.status !== "active" || data.closedAt || data.metadata?.createdByRuntime === true) return null;
  return createHash("sha256").update(JSON.stringify([
    1, data.companyId, data.projectId, data.projectWorkspaceId ?? null, data.sourceIssueId,
    data.cwd, data.repoUrl ?? null, data.baseRef ?? null, data.branchName ?? null, identity,
  ])).digest("hex");
}

/** Serialize duplicate launches and participate in the terminal cleanup lock. */
export async function createOrReuseSharedWorkspace(input: {
  db: Db;
  data: WorkspaceInsert;
  identity: string;
  runId: string;
  lockWorkspace: (tx: Transaction, workspaceId: string) => Promise<void>;
}) {
  const key = sharedWorkspaceReuseKey(input.data, input.identity);
  if (!key) throw new Error("Shared workspace reuse requires a compatible local session");
  return input.db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`shared_workspace_reuse:${key}`}, 0))`);
    // Only the currently owning live run may retain this session. The reaper
    // checks this issue/run pair again under the same workspace lifecycle lock.
    const [owner] = await tx.select({ id: issues.id }).from(issues)
      .innerJoin(heartbeatRuns, eq(heartbeatRuns.id, input.runId))
      .where(and(
        eq(issues.id, input.data.sourceIssueId!), eq(issues.companyId, input.data.companyId),
        eq(heartbeatRuns.companyId, input.data.companyId),
        inArray(heartbeatRuns.status, ["queued", "running"]),
        sql`${input.runId} IN (${issues.executionRunId}, ${issues.checkoutRunId})`,
      )).for("update");
    if (!owner) throw new Error("Shared workspace reuse requires the owning live issue run");
    const candidates = await tx.select().from(executionWorkspaces).where(and(
      eq(executionWorkspaces.companyId, input.data.companyId),
      eq(executionWorkspaces.sourceIssueId, input.data.sourceIssueId!),
      sql`${executionWorkspaces.metadata} ->> ${identityMetadataKey} = ${key}`,
      inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
      isNull(executionWorkspaces.closedAt),
    )).orderBy(desc(executionWorkspaces.lastUsedAt));
    for (const candidate of candidates) {
      await input.lockWorkspace(tx, candidate.id);
      const [fresh] = await tx.select().from(executionWorkspaces).where(and(
        eq(executionWorkspaces.id, candidate.id),
        inArray(executionWorkspaces.status, ["active", "idle", "in_review"]),
        isNull(executionWorkspaces.closedAt),
      ));
      if (!fresh || fresh.metadata?.[identityMetadataKey] !== key
        || sharedWorkspaceReuseKey({ ...fresh, status: "active" }, input.identity) !== key) continue;
      const [reused] = await tx.update(executionWorkspaces).set({
        status: "active", lastUsedAt: new Date(), updatedAt: new Date(),
        // Keep lifecycle fences and ownership metadata from the locked row.
        metadata: { ...input.data.metadata, ...fresh.metadata, [identityMetadataKey]: key,
          [sharedSourceIssueKey]: input.data.sourceIssueId, [sharedSourceRunKey]: input.runId },
      }).where(eq(executionWorkspaces.id, fresh.id)).returning();
      return reused;
    }
    const [previous] = await tx.select({ id: executionWorkspaces.id }).from(executionWorkspaces)
      .where(and(eq(executionWorkspaces.companyId, input.data.companyId),
        eq(executionWorkspaces.sourceIssueId, input.data.sourceIssueId!)))
      .orderBy(sql`(${executionWorkspaces.metadata} ->> ${identityMetadataKey} = ${key}) DESC NULLS LAST`,
        desc(executionWorkspaces.lastUsedAt)).limit(1);
    const [created] = await tx.insert(executionWorkspaces).values({
      ...input.data,
      derivedFromExecutionWorkspaceId: input.data.derivedFromExecutionWorkspaceId ?? previous?.id ?? null,
      metadata: { ...input.data.metadata, [identityMetadataKey]: key,
        [sharedSourceIssueKey]: input.data.sourceIssueId, [sharedSourceRunKey]: input.runId },
    }).returning();
    return created;
  });
}

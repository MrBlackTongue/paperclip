import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { workspaceOverviewQuerySchema } from "@paperclipai/shared";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, executionWorkspaces, heartbeatRuns, issues, projects, workspaceRuntimeServices } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";
import { issueService } from "../services/issues.js";
import { lockSharedWorkspaceBinding } from "../services/shared-workspace-holders.js";
import { captureSharedWorkspaceIdentity } from "../services/shared-workspace-reuse.js";

const exec = promisify(execFile);
const dirs: string[] = [];
async function directory() {
  const dir = await fs.mkdtemp(path.join(process.env.PAPERCLIP_RUN_SCRATCH_DIR ?? os.tmpdir(), "shared-reuse-"));
  dirs.push(dir);
  return dir;
}
afterAll(async () => {
  for (const dir of dirs) await fs.rm(dir, { recursive: true, force: true });
});

describe("shared checkout physical identity", () => {
  it("distinguishes environments, config, physical directories and git branches", async () => {
    const cwd = await directory();
    const git = (args: string[]) => exec("git", args, { cwd });
    await git(["init", "-b", "main"]);
    await git(["-c", "user.name=Test", "-c", "user.email=test@localhost", "commit", "--allow-empty", "-m", "Initial"]);
    const input = { cwd, environmentId: "local-1", environmentDriver: "local", configFingerprint: "config-1" };
    const identity = await captureSharedWorkspaceIdentity(input);
    expect(identity).toMatch(/^[a-f0-9]{64}$/);
    expect(await captureSharedWorkspaceIdentity(input)).toBe(identity);
    expect(await captureSharedWorkspaceIdentity({ ...input, environmentId: "local-2" })).not.toBe(identity);
    expect(await captureSharedWorkspaceIdentity({ ...input, configFingerprint: "config-2" })).not.toBe(identity);
    expect(await captureSharedWorkspaceIdentity({ ...input, environmentDriver: "sandbox" })).toBeNull();
    await git(["checkout", "-b", "other"]);
    expect(await captureSharedWorkspaceIdentity(input)).not.toBe(identity);
    await git(["checkout", "--detach"]);
    expect(await captureSharedWorkspaceIdentity(input)).not.toBe(identity);
    expect(await captureSharedWorkspaceIdentity({ ...input, cwd: await directory() })).not.toBe(identity);
  });

  it("keeps dirty files and handles non-git directories without creating files", async () => {
    const cwd = await directory();
    await fs.writeFile(path.join(cwd, "work.txt"), "unfinished");
    const input = { cwd, environmentId: "local", environmentDriver: "local", configFingerprint: "config" };
    const identity = await captureSharedWorkspaceIdentity(input);
    expect(identity).not.toBeNull();
    expect(await captureSharedWorkspaceIdentity(input)).toBe(identity);
    expect(await fs.readdir(cwd)).toEqual(["work.txt"]);
    expect(await fs.readFile(path.join(cwd, "work.txt"), "utf8")).toBe("unfinished");
    expect(await captureSharedWorkspaceIdentity({ ...input, cwd: path.join(cwd, "missing") })).toBeNull();
  });
});

describe("shared workspace session reuse", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let svc: ReturnType<typeof executionWorkspaceService>;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("shared-reuse-");
    db = createDb(tempDb.connectionString);
    svc = executionWorkspaceService(db, { workspaceReaperCooldownDays: 0 });
  }, 30_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function fixture() {
    const companyId = randomUUID();
    const projectId = randomUUID();
    const sourceIssueId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Shared reuse", issuePrefix: `S${companyId.slice(0, 8)}` });
    await db.insert(projects).values({ id: projectId, companyId, name: "Shared reuse" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Test", role: "engineer", adapterType: "process" });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    await db.insert(issues).values({ id: sourceIssueId, companyId, projectId, title: "Test", status: "in_progress", executionRunId: runId });
    const cwd = await directory();
    await fs.writeFile(path.join(cwd, "unfinished.txt"), "keep");
    const data = { companyId, projectId, sourceIssueId, cwd,
      mode: "shared_workspace", strategyType: "project_primary", providerType: "local_fs", status: "active", name: "Shared",
      metadata: { createdByRuntime: false } };
    const identity = (await captureSharedWorkspaceIdentity({ cwd, environmentId: "local", environmentDriver: "local", configFingerprint: "config" }))!;
    return { data, reuse: { identity, runId }, agentId };
  }

  it("keeps one record across sequential owning runs and concurrent requests", async () => {
    const { data, reuse, agentId } = await fixture();
    const first = await svc.create(data, reuse);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId: data.companyId, agentId, status: "running" });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, data.sourceIssueId));
    const resumed = await Promise.all(Array.from({ length: 3 }, () => svc.create(data, { ...reuse, runId })));
    expect(resumed.map((row) => row!.id)).toEqual([first!.id, first!.id, first!.id]);
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, data.sourceIssueId))).toHaveLength(1);
    expect(await fs.readFile(path.join(data.cwd, "unfinished.txt"), "utf8")).toBe("keep");
  });

  it("does not merge incompatible bindings or revive an archived record", async () => {
    const { data, reuse } = await fixture();
    const first = await svc.create(data, reuse);
    const other = await svc.create({ ...data, baseRef: "other" }, reuse);
    expect(other!.id).not.toBe(first!.id);
    await db.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, first!.id));
    const replacement = await svc.create(data, reuse);
    expect(replacement!.id).not.toBe(first!.id);
    expect(replacement!.derivedFromExecutionWorkspaceId).toBe(first!.id);
  });

  it("rechecks archive status after taking the lifecycle lock", async () => {
    const { data, reuse } = await fixture();
    const first = await svc.create(data, reuse);
    let finishArchive!: () => void;
    let locked!: () => void;
    const lockReady = new Promise<void>((resolve) => { locked = resolve; });
    const release = new Promise<void>((resolve) => { finishArchive = resolve; });
    const archive = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${first!.id}`}, 0))`);
      locked();
      await release;
      await tx.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, first!.id));
    });
    await lockReady;
    const resume = svc.create(data, reuse);
    finishArchive();
    await archive;
    expect((await resume)!.id).not.toBe(first!.id);
  });

  it("rejects a stale run before it can claim or create a session", async () => {
    const { data, reuse } = await fixture();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    await expect(svc.create(data, reuse)).rejects.toThrow("owning live issue run");
    expect(await db.select().from(executionWorkspaces).where(eq(executionWorkspaces.sourceIssueId, data.sourceIssueId))).toHaveLength(0);
  });

  it.each(["done", "cancelled"])("archives a %s session only after its last run stops and preserves files", async (status) => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    const overviewQuery = workspaceOverviewQuerySchema.parse({ projectId: data.projectId });
    expect((await svc.listOverview(data.companyId, overviewQuery)).total).toBe(1);
    await db.update(issues).set({ status }).where(eq(issues.id, data.sourceIssueId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("active");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
    expect((await svc.listOverview(data.companyId, overviewQuery)).total).toBe(0);
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
    expect(await fs.readFile(path.join(data.cwd, "unfinished.txt"), "utf8")).toBe("keep");
  });

  it("retains a shared session for an open descendant and an unrelated linked issue", async () => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    const childId = randomUUID();
    const linkedId = randomUUID();
    await db.insert(issues).values([
      { id: childId, companyId: data.companyId, projectId: data.projectId, title: "Child", status: "todo", parentId: data.sourceIssueId },
      { id: linkedId, companyId: data.companyId, projectId: data.projectId, title: "Linked", status: "todo", executionWorkspaceId: workspace!.id },
    ]);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, data.sourceIssueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("active");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, childId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("active");
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, linkedId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
  });

  it("archives the record after its source issue is deleted without deleting the shared folder", async () => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    // A legacy row has no reuse metadata; the deletion path must retain its owner.
    await db.update(executionWorkspaces).set({ metadata: { createdByRuntime: false } }).where(eq(executionWorkspaces.id, workspace!.id));
    await issueService(db).remove(data.sourceIssueId);
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
    expect(await fs.readFile(path.join(data.cwd, "unfinished.txt"), "utf8")).toBe("keep");
  });

  it("rejects a new holder if archive wins the binding lock", async () => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    let locked!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const finish = new Promise<void>((resolve) => { release = resolve; });
    const archive = db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`execution_workspace_lifecycle:${workspace!.id}`}, 0))`);
      locked();
      await finish;
      await tx.update(executionWorkspaces).set({ status: "archived", closedAt: new Date() }).where(eq(executionWorkspaces.id, workspace!.id));
    });
    await ready;
    const binding = db.transaction((tx) => lockSharedWorkspaceBinding(tx, data.companyId, workspace!.id));
    const rejected = expect(binding).rejects.toThrow("archived shared workspace");
    release();
    await archive;
    await rejected;
  });

  it("reopens the task without forcing reuse of its archived shared record", async () => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    await db.update(issues).set({ status: "done", executionWorkspaceId: workspace!.id,
      executionWorkspacePreference: "reuse_existing", executionRunId: null }).where(eq(issues.id, data.sourceIssueId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
    await issueService(db).update(data.sourceIssueId, { status: "todo" });
    const [reopened] = await db.select().from(issues).where(eq(issues.id, data.sourceIssueId));
    expect(reopened!.status).toBe("todo");
    expect(reopened!.executionWorkspaceId).toBeNull();
    expect(reopened!.executionWorkspacePreference).toBeNull();
    expect(await fs.readFile(path.join(data.cwd, "unfinished.txt"), "utf8")).toBe("keep");
  });

  it("retains a shared record until its runtime service stops", async () => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    const serviceId = randomUUID();
    await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId: data.companyId,
      executionWorkspaceId: workspace!.id, scopeType: "execution_workspace", serviceName: "preview",
      status: "running", lifecycle: "shared", provider: "local_process" });
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, data.sourceIssueId));
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("active");
    await db.update(workspaceRuntimeServices).set({ status: "stopped" }).where(eq(workspaceRuntimeServices.id, serviceId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
  });

  it("keeps a deleted source's session while its recorded run is alive", async () => {
    const { data, reuse } = await fixture();
    const workspace = await svc.create(data, reuse);
    await db.delete(issues).where(eq(issues.id, data.sourceIssueId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("active");
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, reuse.runId));
    await svc.sweepTerminalWorkspaces();
    expect((await svc.getById(workspace!.id))!.status).toBe("archived");
    expect(await fs.readFile(path.join(data.cwd, "unfinished.txt"), "utf8")).toBe("keep");
  });
});

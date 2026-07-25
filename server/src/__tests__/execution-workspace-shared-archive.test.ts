import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  companies,
  createDb,
  executionWorkspaces,
  issues,
  projectWorkspaces,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { executionWorkspaceService } from "../services/execution-workspaces.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres shared workspace archive tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("shared execution workspace terminal archive", () => {
  let db!: ReturnType<typeof createDb>;
  let service!: ReturnType<typeof executionWorkspaceService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const tempDirs = new Set<string>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-shared-workspace-archive-");
    db = createDb(tempDb.connectionString);
    service = executionWorkspaceService(db);
  }, 30_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(companies);
    for (const dir of tempDirs) {
      await fs.rm(dir, { recursive: true, force: true });
    }
    tempDirs.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function createFixture(input: {
    issueStatuses: Array<"done" | "in_review">;
    mode?: "shared_workspace" | "isolated_workspace";
    workspaceStatus?: "active" | "cleanup_failed";
  }) {
    const workspacePath = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-shared-workspace-"));
    tempDirs.add(workspacePath);

    const companyId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const mode = input.mode ?? "shared_workspace";

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Shared workspace archive",
      status: "in_progress",
    });
    await db.insert(projectWorkspaces).values({
      id: projectWorkspaceId,
      companyId,
      projectId,
      name: "Primary",
      sourceType: "local_path",
      isPrimary: true,
      cwd: workspacePath,
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      projectWorkspaceId,
      mode,
      strategyType: mode === "shared_workspace" ? "project_primary" : "git_worktree",
      name: "Terminal session",
      status: input.workspaceStatus ?? "active",
      cwd: workspacePath,
      providerType: mode === "shared_workspace" ? "local_fs" : "git_worktree",
      providerRef: mode === "shared_workspace" ? null : workspacePath,
    });

    const issueIds = input.issueStatuses.map(() => randomUUID());
    await db.insert(issues).values(input.issueStatuses.map((status, index) => ({
      id: issueIds[index],
      companyId,
      projectId,
      title: `Issue ${index + 1}`,
      status,
      priority: "medium" as const,
      executionWorkspaceId,
    })));

    return {
      executionWorkspaceId,
      issueIds,
      projectWorkspaceId,
      workspacePath,
    };
  }

  it("waits for every linked issue, then archives only the shared session record", async () => {
    const fixture = await createFixture({
      issueStatuses: ["done", "in_review"],
    });

    const blocked = await service.archiveTerminalSharedForIssue(fixture.issueIds[0]);
    expect(blocked).toBeNull();

    await db
      .update(issues)
      .set({ status: "done" })
      .where(eq(issues.id, fixture.issueIds[1]));
    const archived = await service.archiveTerminalSharedForIssue(fixture.issueIds[1]);

    expect(archived?.status).toBe("archived");
    expect(await fs.stat(fixture.workspacePath).then(() => true)).toBe(true);

    const linkedIssues = await db
      .select({ executionWorkspaceId: issues.executionWorkspaceId })
      .from(issues);
    expect(linkedIssues).toEqual([
      { executionWorkspaceId: null },
      { executionWorkspaceId: null },
    ]);

    const projectWorkspace = await db
      .select({ id: projectWorkspaces.id })
      .from(projectWorkspaces)
      .where(eq(projectWorkspaces.id, fixture.projectWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(projectWorkspace?.id).toBe(fixture.projectWorkspaceId);
  }, 20_000);

  it("rearchives a cleanup_failed shared session after its linked issue is terminal", async () => {
    const fixture = await createFixture({
      issueStatuses: ["done"],
      workspaceStatus: "cleanup_failed",
    });

    const archived = await service.archiveTerminalSharedForIssue(fixture.issueIds[0]);

    expect(archived?.status).toBe("archived");
    expect(archived?.cleanupReason).toBeNull();
    expect(await fs.stat(fixture.workspacePath).then(() => true)).toBe(true);
  }, 20_000);

  it("does not automatically archive an isolated workspace", async () => {
    const fixture = await createFixture({
      issueStatuses: ["done"],
      mode: "isolated_workspace",
    });

    const archived = await service.archiveTerminalSharedForIssue(fixture.issueIds[0]);

    expect(archived).toBeNull();
    const workspace = await db
      .select({ status: executionWorkspaces.status })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, fixture.executionWorkspaceId))
      .then((rows) => rows[0]);
    expect(workspace.status).toBe("active");
    expect(await fs.stat(fixture.workspacePath).then(() => true)).toBe(true);
  }, 20_000);
});

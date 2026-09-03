import { and, eq, inArray } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import {
  isResponsibleUserDenialCode,
  type ResponsibleUserDenialCode,
} from "@paperclipai/shared";
import { logger } from "../middleware/logger.js";
import { publishLiveEvent } from "./live-events.js";

export function normalizeResponsibleUserDenialCode(
  code: unknown,
): ResponsibleUserDenialCode | null {
  return typeof code === "string" && isResponsibleUserDenialCode(code) ? code : null;
}

export async function recordResponsibleUserDenialOnActiveRun(
  db: Db,
  input: {
    runId?: string | null;
    agentId?: string | null;
    companyId?: string | null;
    code: unknown;
  },
) {
  const runId = input.runId?.trim();
  const code = normalizeResponsibleUserDenialCode(input.code);
  if (!runId || !code) return null;

  const conditions = [
    eq(heartbeatRuns.id, runId),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  ];
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.companyId) conditions.push(eq(heartbeatRuns.companyId, input.companyId));

  const updated = await db
    .update(heartbeatRuns)
    .set({
      errorCode: code,
      updatedAt: new Date(),
    })
    .where(and(...conditions))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!updated) return null;

  publishLiveEvent({
    companyId: updated.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: updated.id,
      agentId: updated.agentId,
      status: updated.status,
      invocationSource: updated.invocationSource,
      triggerDetail: updated.triggerDetail,
      error: updated.error ?? null,
      errorCode: updated.errorCode ?? null,
      startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
      finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
    },
  });

  logger.info(
    {
      runId: updated.id,
      agentId: updated.agentId,
      companyId: updated.companyId,
      errorCode: code,
    },
    "recorded responsible-user denial code on active heartbeat run",
  );

  return updated;
}

/**
 * Last-resort outcome for a denial that could not be recorded on its run.
 *
 * `recordResponsibleUserDenialOnActiveRun` and adapter finalization are
 * independent, non-transactional statements that may run on different pooled
 * connections, so a rejected denial write does not imply that finalization will
 * also fail: the run could still be finalized as `succeeded` with the denial
 * recorded nowhere, which is exactly the state continuation recovery replays.
 *
 * This write is the durable stop for that case. It is issued separately from
 * the failed one and moves the run out of `queued`/`running`, so the
 * compare-and-set finalizer (`setRunStatusIfRunning`) can no longer mark it
 * `succeeded`, whatever exit code the adapter reports.
 */
export async function failRunAfterUnrecordedResponsibleUserDenial(
  db: Db,
  input: {
    runId?: string | null;
    agentId?: string | null;
    companyId?: string | null;
    code: unknown;
  },
) {
  const runId = input.runId?.trim();
  const code = normalizeResponsibleUserDenialCode(input.code);
  if (!runId || !code) return null;

  const conditions = [
    eq(heartbeatRuns.id, runId),
    inArray(heartbeatRuns.status, ["queued", "running"]),
  ];
  if (input.agentId) conditions.push(eq(heartbeatRuns.agentId, input.agentId));
  if (input.companyId) conditions.push(eq(heartbeatRuns.companyId, input.companyId));

  const now = new Date();
  const updated = await db
    .update(heartbeatRuns)
    .set({
      status: "failed",
      errorCode: code,
      error: `responsible-user denial ${code} could not be recorded on this run`,
      finishedAt: now,
      updatedAt: now,
    })
    .where(and(...conditions))
    .returning()
    .then((rows) => rows[0] ?? null);

  if (!updated) return null;

  publishLiveEvent({
    companyId: updated.companyId,
    type: "heartbeat.run.status",
    payload: {
      runId: updated.id,
      agentId: updated.agentId,
      status: updated.status,
      invocationSource: updated.invocationSource,
      triggerDetail: updated.triggerDetail,
      error: updated.error ?? null,
      errorCode: updated.errorCode ?? null,
      startedAt: updated.startedAt ? new Date(updated.startedAt).toISOString() : null,
      finishedAt: updated.finishedAt ? new Date(updated.finishedAt).toISOString() : null,
    },
  });

  logger.error(
    {
      runId: updated.id,
      agentId: updated.agentId,
      companyId: updated.companyId,
      errorCode: code,
    },
    "failed the heartbeat run because its responsible-user denial could not be recorded",
  );

  return updated;
}

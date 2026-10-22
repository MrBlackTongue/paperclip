import { singleFlight } from "../single-flight.js";
import type { ActorInfo } from "../types.js";
import { descriptorHash } from "../../tool-catalog-hash.js";
import { DAYTONA_TOOLS, daytonaRisk, isDaytonaConnection, isDaytonaToolName } from "../../daytona.js";
import { desc, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { toolCatalogEntries, toolConnections } from "@paperclipai/db";
import type { ToolCatalogEntry } from "@paperclipai/shared";

import type { RefreshConnectionCatalog } from "./contracts.js";
export function createToolCatalogReader(db: Db, options: { catalogCacheTtlMs?: number }, now: () => Date, getConnectionRow: (idOrUid: string, companyId?: string) => Promise<typeof toolConnections.$inferSelect>, refreshCatalog: RefreshConnectionCatalog, toCatalogEntryForConnection: (row: typeof toolCatalogEntries.$inferSelect, connection: typeof toolConnections.$inferSelect) => ToolCatalogEntry) {
  const catalogRefreshFlights = new Map<string, Promise<unknown>>();
  const catalogCacheTtlMs = Math.max(
    0,
    options.catalogCacheTtlMs ?? 15 * 60 * 1000,
  );
  return {
    listCatalog: async (
      connectionId: string,
      companyId?: string,
      actor?: ActorInfo,
    ): Promise<ToolCatalogEntry[]> => {
      const connection = await getConnectionRow(connectionId, companyId);
      let rows = await db
        .select()
        .from(toolCatalogEntries)
        .where(eq(toolCatalogEntries.connectionId, connection.id))
        .orderBy(desc(toolCatalogEntries.updatedAt));
      // Native provider catalogs change with the deployed code. Upgrade saved
      // Daytona connections too; their first small catalog must not survive
      // merely because REST discovery has no remote MCP cache timer.
      const nativeDaytona = isDaytonaConnection(connection);
      const rowsByName = new Map(rows.map((row) => [row.toolName, row]));
      const daytonaCatalogChanged = nativeDaytona && connection.status === "active" && (
        rows.some((row) => row.status !== "removed" && !isDaytonaToolName(row.toolName))
        || DAYTONA_TOOLS.some((tool) => {
          const existing = rowsByName.get(tool.name);
          return !existing || existing.versionHash !== descriptorHash(tool, daytonaRisk(tool.name));
        })
      );
      const cacheExpired = daytonaCatalogChanged || (
        connection.transport === "mcp_remote" &&
        connection.status !== "archived" &&
        (rows.length === 0 ||
          !connection.lastCatalogRefreshAt ||
          connection.lastCatalogRefreshAt.getTime() <=
            now().getTime() - catalogCacheTtlMs));
      if (cacheExpired) {
        try {
          await singleFlight(catalogRefreshFlights, connection.id, () =>
            refreshCatalog(connection.id, nativeDaytona && actor ? actor : {
              actorType: "system",
              actorId: "tool_catalog_cache",
            }),
          );
          rows = await db
            .select()
            .from(toolCatalogEntries)
            .where(eq(toolCatalogEntries.connectionId, connection.id))
            .orderBy(desc(toolCatalogEntries.updatedAt));
        } catch (error) {
          // A stale catalog remains useful when the remote server is temporarily
          // unavailable. Empty caches still fail so callers never mistake “no
          // actions discovered” for a successful lookup.
          if (rows.length === 0) throw error;
        }
      }
      // Even failed discovery must not keep retired native tools visible.
      // Their database rows remain available to historical invocation records.
      return rows
        .filter((row) => !nativeDaytona || (row.status !== "removed" && isDaytonaToolName(row.toolName)))
        .map((row) => toCatalogEntryForConnection(row, connection));
    }
  };
}

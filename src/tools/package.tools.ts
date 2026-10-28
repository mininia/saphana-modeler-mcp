import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { attachPagedInfo, markEmptyResult } from '../core/result-info.js';
import { listPackageObjects, listPackages } from '../services/metadata.service.js';
import {
  createPackageViaRest,
  exportPackageViaRest,
  importObjectViaRest,
  listChangesViaRest,
} from '../services/repository.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { CAP } from '../capabilities/manifest.js';
import type { Envelope } from '../types/hana.js';

/** limit 的 schema 默认值（单一事实源 = 清单；每个工具取自己的 schema，不借用兄弟工具的默认值） */
const PACKAGE_LIST_LIMIT_DEFAULT: number = CAP.hana_package_list.inputSchema.shape.limit.parse(undefined);
const PACKAGE_OBJECTS_LIMIT_DEFAULT: number = CAP.hana_package_list_objects.inputSchema.shape.limit.parse(undefined);

/** 包/对象浏览与仓库操作工具（声明见 capabilities/defs/package.ts） */
export function registerPackageTools(server: McpServer, ctx: ToolContext): void {
  // capabilityRegistrar 统一套调用期闸门，判定不通过不进 service。
  const regCap = capabilityRegistrar(server, ctx);
  regCap(CAP.hana_package_list, async ({ pattern, limit }) => {
    const envelope: Envelope = await withErrorEnvelope(async () =>
      attachPagedInfo(await listPackages(ctx.pool, { pattern, limit }), {
        requestedLimit: limit !== PACKAGE_LIST_LIMIT_DEFAULT,
      }),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_package_list_objects, async ({ packageId, pattern, kind, limit }) => {
    const envelope: Envelope = await withErrorEnvelope(async () =>
      attachPagedInfo(await listPackageObjects(ctx.pool, packageId, { pattern, kind, limit }), {
        requestedLimit: limit !== PACKAGE_OBJECTS_LIMIT_DEFAULT,
      }),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_package_create, async ({ packageId, description }) => {
    const envelope: Envelope = await withErrorEnvelope(() => createPackageViaRest(ctx.config, packageId, description));
    return toToolResult(envelope);
  });

  regCap(CAP.hana_repo_export, async ({ packageId, saveTo }) => {
    const envelope: Envelope = await withErrorEnvelope(() => exportPackageViaRest(ctx.config, packageId, saveTo));
    return toToolResult(envelope);
  });

  regCap(CAP.hana_repo_import, async ({ targetPackageId, filePath, content, fileName, overwrite }) => {
    // 来源二选一：同时给出必须拒绝——静默取舍会让调用方以为导入了文件、实际是另一份内容。
    if (filePath && content !== undefined) {
      return mcpErrorText(
        '导入来源二选一：filePath（本地文件）与 content（内联内容）不能同时提供。',
        '导本地文件只给 filePath；导内联内容给 content + fileName',
      );
    }
    const envelope: Envelope = await withErrorEnvelope(() =>
      importObjectViaRest(ctx.config, { targetPackageId, filePath, content, fileName, overwrite }, undefined, ctx.pool),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_repo_changelist, async ({ user, status }) => {
    const envelope: Envelope = await withErrorEnvelope(async () => {
      const data = await listChangesViaRest(ctx.config, { user, status });
      // 空变更列表是合法结果（未启用 Change Tracking / 无变更），不是错误：显式标记空集。
      return Array.isArray(data) && data.length === 0 ? markEmptyResult(data) : data;
    });
    return toToolResult(envelope);
  });
}

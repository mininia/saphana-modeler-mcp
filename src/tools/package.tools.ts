import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
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

/** 包/对象浏览与仓库操作工具（声明见 capabilities/defs/package.ts） */
export function registerPackageTools(server: McpServer, ctx: ToolContext): void {
  // capabilityRegistrar 统一套调用期闸门，判定不通过不进 service。
  const regCap = capabilityRegistrar(server, ctx);
  regCap(CAP.hana_package_list, async ({ pattern, limit }) => {
    const envelope: Envelope = await withErrorEnvelope(() => listPackages(ctx.pool, { pattern, limit }));
    return toToolResult(envelope);
  });

  regCap(CAP.hana_package_list_objects, async ({ packageId, pattern, kind, limit }) => {
    const envelope: Envelope = await withErrorEnvelope(() =>
      listPackageObjects(ctx.pool, packageId, { pattern, kind, limit }),
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
    const envelope: Envelope = await withErrorEnvelope(() => listChangesViaRest(ctx.config, { user, status }));
    return toToolResult(envelope);
  });
}

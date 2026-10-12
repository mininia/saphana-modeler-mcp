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

/** 包/对象浏览工具：包树 + 包内对象清单（只读） */
export function registerPackageTools(server: McpServer, ctx: ToolContext): void {
  // 注册器把每个 handler 套上统一的调用期闸门（authorizeCall）：判定不通过会在 handler 之前拦截、
  // 不进 service（闸门实现与判定依据见 tools/index.ts 与 config/authorize.ts）。
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
    // 来源二选一：两者同时给出时必须拒绝——若按任一优先静默取舍，另一份来源会被静默忽略，
    // 调用方以为导入了本地文件，实际导入的是另一份内容，属最难查的一类回执。
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

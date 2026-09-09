import type { HanaPool } from '../core/hana-client.js';
import { getViewDefinition, VIEW_SUFFIXES, type ViewDefinitionResult } from '../services/metadata.service.js';
import type { ViewDefinition, ViewKind } from './view-types.js';

/**
 * 视图定义解析缓存（数据预览「XML 预处理」封装）。
 *
 * 背景：_SYS_REPO.ACTIVE_OBJECT.CDATA 的视图 XML 可达几十 KB，节点推导预览每次
 * 都重新拉取并解析很浪费；但缓存不能牺牲正确性（视图可能被重新激活）。
 *
 * 策略：
 * - 首次请求：走 getViewDefinition 拉 CDATA 并解析，缓存 parsed ViewDefinition
 * - TTL 内命中：先做一次轻量 VERSION_ID 校验（只 SELECT 版本列，不取 CDATA），
 *   版本未变直接返回缓存；变了则删除缓存并重新拉取
 * - 进程内 Map（MCP stdio 单进程场景足够）
 *
 * 该模块可被任意需要「读视图定义 + 解析」的服务复用（当前预览服务使用）。
 */
export class ViewDefinitionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(private readonly ttlMs = 60_000) {}

  /** 取视图定义（优先缓存；版本变化自动失效重取） */
  async get(
    pool: HanaPool,
    packageId: string,
    objectName: string,
    opts: { kind?: ViewKind } = {},
  ): Promise<ViewDefinitionResult> {
    const suffixes = opts.kind ? [VIEW_SUFFIXES[opts.kind]] : Object.values(VIEW_SUFFIXES);
    const key = `${packageId}/${objectName}/${suffixes.join(',')}`;
    const entry = this.entries.get(key);

    if (entry && Date.now() - entry.cachedAt < this.ttlMs) {
      // 缓存命中：轻量版本校验（不取 CDATA），版本未变直接用缓存
      const rows = await pool.query<{ VERSION_ID: number }>(
        `SELECT VERSION_ID FROM "_SYS_REPO"."ACTIVE_OBJECT"
         WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN (${suffixes.map(() => '?').join(',')})
         ORDER BY VERSION_ID DESC LIMIT 1`,
        [packageId, objectName, ...suffixes],
      );
      if (rows[0] && rows[0].VERSION_ID === entry.versionId) {
        return { object: entry.object, definition: entry.definition };
      }
      this.entries.delete(key); // 版本变化：落空，走全量重取
    }

    const result = await getViewDefinition(pool, packageId, objectName, { kind: opts.kind, format: 'json' });
    if (result.definition) {
      this.entries.set(key, {
        versionId: result.object.versionId,
        object: result.object,
        definition: result.definition,
        cachedAt: Date.now(),
      });
    }
    return result;
  }

  /** 清空缓存（测试/配置变更用） */
  clear(): void {
    this.entries.clear();
  }
}

interface CacheEntry {
  versionId: number;
  object: ViewDefinitionResult['object'];
  definition: ViewDefinition;
  cachedAt: number;
}

/** 进程级共享缓存（MCP stdio 单进程场景） */
export const viewDefinitionCache = new ViewDefinitionCache();

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
 * - 容量上限 + LRU 淘汰：HTTP 模式下一个进程服务多个客户端、对象数不受本进程控制，
 *   无上限的 Map 会被持续拉取的定义撑大内存
 * - 进程级单例（Map 插入序即 LRU 序）
 *
 * key 约定：key 必须覆盖「缓存值所依赖的全部维度」——当前只有包/对象/类型（同一份
 * _SYS_REPO.CDATA 对所有调用方相同）。若将来按客户端身份裁剪视图定义（多租户），
 * 必须把身份维度加进 key，否则会跨客户端串数据。
 *
 * 该模块可被任意需要「读视图定义 + 解析」的服务复用（当前预览服务使用）。
 */
export class ViewDefinitionCache {
  private readonly entries = new Map<string, CacheEntry>();

  constructor(
    private readonly ttlMs = 60_000,
    /** 缓存条目上限（超出即淘汰最久未使用项） */
    private readonly maxEntries = 200,
  ) {}

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
        this.touch(key, entry); // 命中：刷新为最近使用
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
      this.evictOldest();
    }
    return result;
  }

  /** 清空缓存（测试/配置变更用） */
  clear(): void {
    this.entries.clear();
  }

  /** 命中即刷新为最近使用（依赖 Map 插入序 = LRU 序） */
  private touch(key: string, entry: CacheEntry): void {
    this.entries.delete(key);
    this.entries.set(key, entry);
  }

  /** 超容量即淘汰最久未使用项（Map 首项） */
  private evictOldest(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next();
      if (oldest.done) return;
      this.entries.delete(oldest.value);
    }
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

import type { HanaPool } from '../core/hana-client.js';
import { quoteIdentifier } from '../core/sql.js';
import { getViewDefinition, suffixInClause, suffixesOf } from '../services/metadata.service.js';
import type { ViewDefinitionResult } from '../services/metadata.service.js';
import type { ViewDefinition, ViewKind } from './view-types.js';
import { OBJECT_TABLE, type VersionScope } from './view-scope.js';

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
 * key 约定：key 必须覆盖「缓存值所依赖的全部维度」——当前是包/对象/类型/**版本视角**
 * （active 与 inactive 的 CDATA 来自两张不同的表，同一对象两侧可以同时存在且内容不同）。
 * 若将来按客户端身份裁剪视图定义（多租户），必须把身份维度加进 key，否则会跨客户端串数据。
 *
 * 依赖例外：本模块 import services/metadata.service 取数与版本校验（model→services 的反向边，
 * 已登记在 CONTRIBUTING 的分层一节）。两模块互为运行时环，导入值只在函数体内使用（求值期不
 * 互相解引用），故在 ESM 下成立。
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

  /** 取视图定义（优先缓存；版本变化自动失效重取）。version 默认 active（既有行为） */
  async get(
    pool: HanaPool,
    packageId: string,
    objectName: string,
    opts: { kind?: ViewKind; version?: VersionScope } = {},
  ): Promise<ViewDefinitionResult> {
    // 后缀解析与 IN 占位符复用 metadata.service 的单点实现（suffixesOf / suffixInClause）：
    // 与 getViewDefinition 是同一条对象表查询口径，过滤语义演进时不会分叉。
    const suffixes = suffixesOf(opts.kind);
    const version = opts.version ?? 'active';
    const key = `${packageId}/${objectName}/${suffixes.join(',')}/${version}`;
    const entry = this.entries.get(key);

    if (entry && Date.now() - entry.cachedAt < this.ttlMs) {
      // 缓存命中：轻量版本校验（不取 CDATA），版本未变直接用缓存；
      // 校验表随版本视角切换（inactive 的挂起改动不会改变 ACTIVE_OBJECT 的版本号）
      const rows = await pool.query<{ VERSION_ID: number }>(
        `SELECT VERSION_ID FROM "_SYS_REPO".${quoteIdentifier(OBJECT_TABLE[version])}
         WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN ${suffixInClause(suffixes)}
         ORDER BY VERSION_ID DESC LIMIT 1`,
        [packageId, objectName, ...suffixes],
      );
      if (rows[0] && rows[0].VERSION_ID === entry.versionId) {
        this.touch(key, entry); // 命中：刷新为最近使用
        return { object: entry.object, definition: entry.definition };
      }
      this.entries.delete(key); // 版本变化：落空，走全量重取
    }

    const result = await getViewDefinition(pool, packageId, objectName, { kind: opts.kind, version, format: 'json' });
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

  /**
   * 按 (包/对象) 前缀失效（写路径成功后调用）。返回被删除的条目数（供调用方/测试断言）。
   *
   * key 形如「包名/对象名/后缀列表」（用斜杠连接，见 get() 的 key 构造），这里把前缀为
   * `包名/对象名/` 的条目全部删除（后缀维度不同 = 同对象的另一种视图类型，一并失效）。
   * 缓存本身已有 VERSION_ID 命中校验 + TTL 自愈：失效只是把「最多 60s 后自愈」变成「立即」，
   * 不是正确性必需。**未激活的设计时写入不改变 ACTIVE_OBJECT**（严格说不必失效），
   * 但写路径一律失效更简单——不用在每条写路径上判断「这次写会不会改变 ACTIVE_OBJECT」——
   * 代价只是一次重取。
   * 调用方传入的 (packageId, objectName) 须与 get() 的 key 维度一致；不一致只是前缀不命中，
   * 退回 TTL/版本自愈，不会误删别的对象。
   */
  invalidate(packageId: string, objectName: string): number {
    const prefix = `${packageId}/${objectName}/`;
    let removed = 0;
    for (const key of this.entries.keys()) {
      if (key.startsWith(prefix)) {
        this.entries.delete(key);
        removed += 1;
      }
    }
    return removed;
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

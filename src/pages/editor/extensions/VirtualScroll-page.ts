/**
 * VirtualScroll - 基于 Decoration 的智能虚拟滚动（升级版）
 *
 * 核心原理（参考语雀/Notion方案）：
 * 1. 文档模型完整保留，不影响光标/选区计算（ProseMirror核心优势）
 * 2. 使用 Decoration.node 标记不可见节点（CSS 控制显示/隐藏）
 * 3. CSS content-visibility + 固定高度占位（解决滚动条跳动 Bug）
 * 4. 动态高度缓存：预估高度 → 真实高度（ResizeObserver 测量）
 * 5. 滚动平滑策略：IntersectionObserver + RAF + 防抖
 * 6. 编辑态智能检测：光标周围强制渲染，编辑时暂停虚拟化
 *
 * 性能目标：
 * - 10,000 字文档：< 100ms 初始渲染
 * - 滚动帧率：稳定 60fps
 * - 内存占用：减少 70% DOM 节点
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const VIRTUAL_SCROLL_KEY = new PluginKey('virtualScroll');

// 块级节点类型
const BLOCK_TYPES = [
  'paragraph',
  'heading',
  'listItem',
  'codeBlock',
  'blockquote',
];

// 预估高度（首次渲染前使用）
const ESTIMATED_HEIGHTS: Record<string, number> = {
  paragraph: 80,
  heading: 60,
  codeBlock: 200,
  blockquote: 100,
  listItem: 40,
};

/**
 * 高度缓存管理器
 */
class HeightCache {
  private cache = new Map<string, number>(); // blockId -> 真实高度
  private totalHeight = 0;

  get(blockId: string, nodeType?: string): number {
    return (
      this.cache.get(blockId) ??
      ESTIMATED_HEIGHTS[nodeType || 'paragraph'] ??
      80
    );
  }

  set(blockId: string, height: number): boolean {
    const oldHeight = this.cache.get(blockId);
    if (oldHeight === height) return false;

    this.cache.set(blockId, height);
    return true;
  }

  has(blockId: string): boolean {
    return this.cache.has(blockId);
  }

  /**
   * 计算文档总高度（用于滚动条同步）
   */
  calculateTotalHeight(doc: {
    descendants: (
      callback: (node: {
        type: { name: string };
        attrs: Record<string, unknown>;
      }) => boolean,
    ) => void;
  }): number {
    let total = 0;
    doc.descendants(
      (node: { type: { name: string }; attrs: Record<string, unknown> }) => {
        if (BLOCK_TYPES.includes(node.type.name)) {
          const blockId = node.attrs.blockId as string;
          if (blockId) {
            total += this.get(blockId, node.type.name);
          }
        }
        return true;
      },
    );
    this.totalHeight = total;
    return total;
  }

  getTotalHeight(): number {
    return this.totalHeight;
  }
}

const heightCache = new HeightCache();

/**
 * 块索引信息
 */
interface BlockInfo {
  pos: number;
  nodeSize: number;
  blockId: string;
  type: string;
}

/**
 * 计算可视区域的块索引范围（基于块数量，非字符位置）
 */
function calculateVisibleBlockRange(
  view: {
    dom: HTMLElement;
    state: {
      doc: {
        descendants: (
          callback: (
            node: {
              type: { name: string };
              attrs: Record<string, unknown>;
              nodeSize?: number;
            },
            pos: number,
          ) => boolean | void,
        ) => void;
        content: { size: number };
      };
    };
    posAtCoords: (coords: {
      left: number;
      top: number;
    }) => { pos: number } | null | undefined;
  },
  scrollContainer: HTMLElement | null,
  buffer: number,
): { startIndex: number; endIndex: number; blocks: BlockInfo[] } {
  // 收集所有块信息
  const blocks: BlockInfo[] = [];
  view.state.doc.descendants(
    (
      node: {
        type: { name: string };
        attrs: Record<string, unknown>;
        nodeSize?: number;
      },
      pos: number,
    ) => {
      if (BLOCK_TYPES.includes(node.type.name)) {
        blocks.push({
          pos,
          nodeSize: node.nodeSize || 0,
          blockId: node.attrs.blockId as string,
          type: node.type.name,
        });
      }
      return true;
    },
  );

  if (!scrollContainer || blocks.length === 0) {
    return { startIndex: 0, endIndex: blocks.length, blocks };
  }

  const editorRect = view.dom.getBoundingClientRect();
  const containerRect = scrollContainer.getBoundingClientRect();

  // 计算可见区域
  const visibleTop = Math.max(editorRect.top, containerRect.top);
  const visibleBottom = Math.min(editorRect.bottom, containerRect.bottom);

  if (visibleTop >= visibleBottom) {
    return { startIndex: 0, endIndex: 0, blocks };
  }

  // 使用 posAtCoords 找到可见区域的起止位置
  const topPos = view.posAtCoords({
    left: editorRect.left + editorRect.width / 2,
    top: visibleTop + 10,
  });

  const bottomPos = view.posAtCoords({
    left: editorRect.left + editorRect.width / 2,
    top: visibleBottom - 10,
  });

  let startIndex = 0;
  let endIndex = blocks.length;

  if (topPos?.pos != null) {
    // 找到第一个位置 >= topPos.pos 的块
    startIndex = blocks.findIndex(
      (block) => block.pos + block.nodeSize > topPos.pos,
    );
    if (startIndex === -1) startIndex = 0;
  }

  if (bottomPos?.pos != null) {
    // 找到最后一个位置 <= bottomPos.pos 的块
    endIndex = blocks.findIndex((block) => block.pos > bottomPos.pos);
    if (endIndex === -1) endIndex = blocks.length;
  }

  // 添加缓冲区（上下各 buffer 个块）
  startIndex = Math.max(0, startIndex - buffer);
  endIndex = Math.min(blocks.length, endIndex + buffer);

  return { startIndex, endIndex, blocks };
}

/**
 * 查找滚动容器
 */
function findScrollContainer(
  editorDom: HTMLElement,
  selector?: string | null,
): HTMLElement | null {
  // 如果提供了选择器，优先使用
  if (selector) {
    // 🔥 修复：先尝试从 editorDom 向上查找匹配选择器的元素
    let el: HTMLElement | null = editorDom;
    while (el) {
      if (el.matches(selector)) {
        console.log('[VirtualScroll] 找到指定的滚动容器:', selector, el);
        return el;
      }
      el = el.parentElement;
    }

    // 如果向上查找失败，尝试全局查找
    const container = document.querySelector(selector) as HTMLElement;
    if (container) {
      console.log(
        '[VirtualScroll] 使用全局查找的滚动容器:',
        selector,
        container,
      );
      return container;
    }

    console.warn('[VirtualScroll] 未找到选择器对应的容器:', selector);
  }

  // 自动查找最近的滚动容器
  let el = editorDom.parentElement;
  const candidates: { el: HTMLElement; distance: number }[] = [];

  while (el && el !== document.body) {
    const style = getComputedStyle(el);
    if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
      // 计算距离（DOM 层级深度）
      let distance = 0;
      let temp = editorDom.parentElement;
      while (temp && temp !== el) {
        distance++;
        temp = temp.parentElement;
      }

      candidates.push({ el, distance });
      console.log(
        `[VirtualScroll] 找到候选滚动容器 (距离 ${distance}):`,
        el.className || el.tagName,
        `scrollHeight: ${el.scrollHeight}, clientHeight: ${el.clientHeight}`,
      );
    }
    el = el.parentElement;
  }

  // 选择最近的、且实际可滚动的容器
  const validCandidate = candidates.find(
    (c) => c.el.scrollHeight > c.el.clientHeight,
  );

  if (validCandidate) {
    console.log(
      '[VirtualScroll] 选择滚动容器:',
      validCandidate.el.className || validCandidate.el.tagName,
    );
    return validCandidate.el;
  }

  // 降级：选择最近的有 overflow 的容器
  if (candidates.length > 0) {
    console.log(
      '[VirtualScroll] 降级选择最近的容器:',
      candidates[0].el.className || candidates[0].el.tagName,
    );
    return candidates[0].el;
  }

  console.warn('[VirtualScroll] 未找到滚动容器，使用编辑器父元素');
  return editorDom.parentElement;
}

export default Extension.create({
  name: 'virtualScroll',

  addOptions() {
    return {
      buffer: 15, // 上下缓冲的**块数量**（优化：增加到 15 块，减少频繁切换）
      cursorBuffer: 3000, // 光标周围强制渲染范围（字符数，优化：增加到 3000）
      scrollThrottle: 50, // 滚动节流（优化：降低到 50ms，提升响应速度）
      preloadMargin: '800px', // IntersectionObserver 预加载边距（优化：增加到 800px）
      scrollContainerSelector: '.tiptap' as string | null, // 默认滚动容器选择器
      enableWhileEditing: false, // 编辑时暂停虚拟化（保持编辑流畅）
      enableDebugLog: false, // 🆕 控制调试日志输出（生产环境关闭）
      enableVisualDebug: false, // 🆕 可视化调试（显示虚拟化块边框）
    };
  },

  addProseMirrorPlugins() {
    const {
      buffer,
      cursorBuffer,
      scrollContainerSelector,
      enableWhileEditing,
      scrollThrottle,
      enableDebugLog,
      enableVisualDebug,
    } = this.options;

    return [
      new Plugin({
        key: VIRTUAL_SCROLL_KEY,

        state: {
          init(_, state) {
            // 🔥 初始化时收集所有块，并设置默认可见范围为前 20 个块
            const blocks: BlockInfo[] = [];
            state.doc.descendants(
              (
                node: {
                  type: { name: string };
                  attrs: Record<string, unknown>;
                  nodeSize?: number;
                },
                pos: number,
              ) => {
                if (BLOCK_TYPES.includes(node.type.name)) {
                  blocks.push({
                    pos,
                    nodeSize: node.nodeSize || 0,
                    blockId: node.attrs.blockId as string,
                    type: node.type.name,
                  });
                }
                return true;
              },
            );

            return {
              visibleBlockRange: {
                startIndex: 0,
                endIndex: Math.min(20, blocks.length), // 🔥 初始显示前 20 个块
              },
              blocks,
              forceRenderRanges: [] as { from: number; to: number }[],
              scrollContainer: null as HTMLElement | null,
            };
          },

          apply(tr, value, _oldState, newState) {
            const newValue = { ...value };

            // 🔥 处理初始化可视区域
            const initVisibleRange = tr.getMeta('initVisibleRange') as
              | { startIndex: number; endIndex: number; blocks: BlockInfo[] }
              | undefined;
            if (initVisibleRange) {
              newValue.visibleBlockRange = {
                startIndex: initVisibleRange.startIndex,
                endIndex: initVisibleRange.endIndex,
              };
              newValue.blocks = initVisibleRange.blocks;
            }

            // 处理滚动容器更新
            const updateScrollContainer = tr.getMeta('updateScrollContainer');
            if (updateScrollContainer !== undefined) {
              newValue.scrollContainer = updateScrollContainer;
            }

            // 处理强制渲染范围（如目录跳转）
            const forceRange = tr.getMeta('forceRenderRange') as
              | { from: number; to: number }
              | undefined;
            if (forceRange) {
              newValue.forceRenderRanges = [
                ...value.forceRenderRanges,
                forceRange,
              ];
            }

            // 处理高度更新
            const heightUpdates = tr.getMeta('heightUpdates') as
              | {
                  blockId: string;
                  height: number;
                }[]
              | undefined;

            if (heightUpdates) {
              let updated = false;
              heightUpdates.forEach(({ blockId, height }) => {
                if (heightCache.set(blockId, height)) {
                  updated = true;
                }
              });

              // 重新计算总高度
              if (updated) {
                heightCache.calculateTotalHeight(newState.doc);
              }
            }

            // 处理滚动更新
            const scrollUpdate = tr.getMeta('scrollUpdate');
            if (scrollUpdate && newValue.scrollContainer) {
              const result = calculateVisibleBlockRange(
                scrollUpdate.view,
                newValue.scrollContainer,
                buffer,
              );
              newValue.visibleBlockRange = {
                startIndex: result.startIndex,
                endIndex: result.endIndex,
              };
              newValue.blocks = result.blocks;
            }

            // 文档变化时重新收集 blocks（但保持 visibleBlockRange）
            if (tr.docChanged) {
              heightCache.calculateTotalHeight(newState.doc);

              // 🔥 重新收集 blocks（因为文档结构可能变化）
              const newBlocks: BlockInfo[] = [];
              newState.doc.descendants(
                (
                  node: {
                    type: { name: string };
                    attrs: Record<string, unknown>;
                    nodeSize?: number;
                  },
                  pos: number,
                ) => {
                  if (BLOCK_TYPES.includes(node.type.name)) {
                    newBlocks.push({
                      pos,
                      nodeSize: node.nodeSize || 0,
                      blockId: node.attrs.blockId as string,
                      type: node.type.name,
                    });
                  }
                  return true;
                },
              );

              newValue.blocks = newBlocks;

              // 🔥 只有当有 scrollUpdate 时才重新计算可视区域
              if (scrollUpdate?.view && newValue.scrollContainer) {
                const result = calculateVisibleBlockRange(
                  scrollUpdate.view,
                  newValue.scrollContainer,
                  buffer,
                );
                newValue.visibleBlockRange = {
                  startIndex: result.startIndex,
                  endIndex: result.endIndex,
                };
                // 🔥 条件日志输出
                if (enableDebugLog) {
                  // console.log(
                  //   '[VirtualScroll] 📝 文档变化 + 滚动更新，重新计算可视区域:',
                  //   result.startIndex,
                  //   '-',
                  //   result.endIndex,
                  // );
                }
              } else {
                // 🔥 如果没有滚动更新，保持原有的 visibleBlockRange
                // 但需要确保 endIndex 不超过新的 blocks 长度
                if (newValue.visibleBlockRange.endIndex > newBlocks.length) {
                  newValue.visibleBlockRange = {
                    startIndex: Math.max(0, newBlocks.length - 20),
                    endIndex: newBlocks.length,
                  };
                  if (enableDebugLog) {
                    // console.log(
                    //   '[VirtualScroll] 📝 文档变化，调整可视区域以适应新长度:',
                    //   newValue.visibleBlockRange,
                    // );
                  }
                } else {
                  if (enableDebugLog) {
                    // console.log(
                    //   '[VirtualScroll] 📝 文档变化，保持原有可视区域:',
                    //   newValue.visibleBlockRange.startIndex,
                    //   '-',
                    //   newValue.visibleBlockRange.endIndex,
                    // );
                  }
                }
              }
            }

            return newValue;
          },
        },

        props: {
          decorations(state) {
            const pluginState = VIRTUAL_SCROLL_KEY.getState(state);
            const { visibleBlockRange, blocks, forceRenderRanges } =
              pluginState;
            // 🔥 分页模式下禁用虚拟化（分页已有自己的加载/卸载机制）
            const isPagedMode = (window as any).__PAGED_MODE_ACTIVE__ || false;
            if (isPagedMode) {
              if (enableDebugLog) {
                console.log('[VirtualScroll] 🚫 分页模式已启用，禁用虚拟化');
              }
              return DecorationSet.empty;
            }

            const { from: selFrom, to: selTo } = state.selection;

            const decos: Decoration[] = [];
            let visibleCount = 0;
            let hiddenCount = 0;

            // 🔥 调试：记录每个块的状态
            const debugBlocks: {
              index: number;
              blockId: string;
              pos: number;
              inVisibleRange: boolean;
              inCursorRange: boolean;
              inForceRange: boolean;
              isHidden: boolean;
            }[] = [];

            // 🔥 核心优化：基于块索引范围判断可见性
            blocks.forEach((block: BlockInfo, index: number) => {
              const { pos, nodeSize, blockId, type } = block;
              const nodeEnd = pos + nodeSize;

              // 判断是否在可见范围内（基于索引）
              const inVisibleRange =
                index >= visibleBlockRange.startIndex &&
                index < visibleBlockRange.endIndex;

              // 判断是否在光标附近
              const inCursorRange =
                Math.abs(pos - selFrom) < cursorBuffer ||
                Math.abs(pos - selTo) < cursorBuffer ||
                (pos <= selFrom && nodeEnd >= selTo);

              // 判断是否在强制渲染范围
              const inForceRange = forceRenderRanges.some(
                (range: { from: number; to: number }) =>
                  pos >= range.from && pos <= range.to,
              );

              // 🔥 非可见区域 → 添加虚拟化标记
              const isHidden =
                !inVisibleRange && !inCursorRange && !inForceRange;

              if (isHidden) {
                const height = heightCache.get(blockId, type);
                const isCached = heightCache.has(blockId);

                // 🎯 关键修复：使用 min-height + content-visibility 防止滚动条跳动
                decos.push(
                  Decoration.node(pos, nodeEnd, {
                    class: enableVisualDebug
                      ? 'virtual-hidden virtual-debug'
                      : 'virtual-hidden',
                    'data-virtual-height': String(height),
                    'data-cached': isCached ? 'true' : 'false',
                    'data-block-index': String(index),
                    'data-virtualized': 'true', // 🆕 标记为虚拟化状态
                    style: `min-height: ${height}px; height: ${height}px; contain-intrinsic-size: ${height}px;`, // 🔥 强制高度占位
                  }),
                );
                hiddenCount++;
              } else {
                // 🆕 可见区域也添加标记（用于调试和性能监控）
                if (enableVisualDebug) {
                  decos.push(
                    Decoration.node(pos, nodeEnd, {
                      'data-virtualized': 'false',
                      'data-block-index': String(index),
                    }),
                  );
                }
                visibleCount++;
              }

              // 🔥 记录前 5 个和后 5 个块的详细状态，以及可视区域附近的块
              if (
                index < 5 ||
                index >= blocks.length - 5 ||
                Math.abs(index - visibleBlockRange.startIndex) <= 2 ||
                Math.abs(index - visibleBlockRange.endIndex) <= 2
              ) {
                debugBlocks.push({
                  index,
                  blockId: blockId ? blockId.slice(0, 12) + '...' : 'null',
                  pos,
                  inVisibleRange,
                  inCursorRange,
                  inForceRange,
                  isHidden,
                });
              }
            });

            // 🔥 根据配置控制日志输出
            if (enableDebugLog) {
              // console.log(
              //   `[VirtualScroll] 📊 块索引: ${visibleBlockRange.startIndex}-${visibleBlockRange.endIndex} | 可见: ${visibleCount} | 隐藏: ${hiddenCount} | 总块数: ${blocks.length} | 总高度: ${heightCache.getTotalHeight().toFixed(0)}px`,
              // );

              // 🔥 详细调试信息：显示块状态表格
              // if (debugBlocks.length > 0) {
              //   console.group('[VirtualScroll] 🔍 块状态详情');
              //   console.table(debugBlocks);
              //   console.log('光标位置:', { from: selFrom, to: selTo });
              //   console.log('光标缓冲区:', cursorBuffer, '字符');
              //   console.groupEnd();
              // }

              // 🔥 调试：检查 visibleBlockRange 是否正确初始化
              if (
                blocks.length > 0 &&
                visibleBlockRange.startIndex === 0 &&
                visibleBlockRange.endIndex === 0
              ) {
                console.warn(
                  '[VirtualScroll] ⚠️ visibleBlockRange 未初始化，所有块被标记为不可见',
                );
              }
            }

            return DecorationSet.create(state.doc, decos);
          },
        },

        view(view) {
          let scrollContainer: HTMLElement | null = null;
          let rafId = 0;
          let resizeObserver: ResizeObserver | null = null;
          let isEditing = false; // 🔥 编辑状态标志
          let editingTimeout: NodeJS.Timeout | null = null;

          // 初始化滚动容器
          scrollContainer = findScrollContainer(
            view.dom,
            scrollContainerSelector,
          );
          if (enableDebugLog) {
            console.log(
              '[VirtualScroll] 最终滚动容器:',
              scrollContainer?.className || scrollContainer?.tagName,
            );
          }

          // 初始化高度缓存
          heightCache.calculateTotalHeight(view.state.doc);

          // 🔥 修复：初始化时立即计算可视区域
          const initVisibleRange = () => {
            const result = calculateVisibleBlockRange(
              view,
              scrollContainer,
              buffer,
            );

            if (enableDebugLog) {
              console.log('[VirtualScroll] 🔍 初始化可视区域计算结果:', {
                startIndex: result.startIndex,
                endIndex: result.endIndex,
                blocksLength: result.blocks.length,
                scrollContainer:
                  scrollContainer?.className || scrollContainer?.tagName,
                scrollTop: scrollContainer?.scrollTop || 0,
                clientHeight: scrollContainer?.clientHeight || 0,
              });
            }

            // 更新插件状态
            const tr = view.state.tr;
            tr.setMeta('updateScrollContainer', scrollContainer);
            tr.setMeta('scrollUpdate', {
              view,
              scrollTop: scrollContainer?.scrollTop || 0,
            });
            tr.setMeta('initVisibleRange', result);
            view.dispatch(tr);

            if (enableDebugLog) {
              console.log(
                '[VirtualScroll] ✅ 初始化完成，块总数:',
                result.blocks.length,
                '可视范围:',
                `${result.startIndex}-${result.endIndex}`,
              );
            }
          };

          // 🔥 编辑状态管理
          const setEditingState = (editing: boolean) => {
            if (editingTimeout) clearTimeout(editingTimeout);

            if (editing) {
              isEditing = true;
              // 编辑结束后 500ms 恢复虚拟化
              editingTimeout = setTimeout(() => {
                isEditing = false;
                // 恢复后立即更新一次可视区域
                handleScroll();
              }, 500);
            }
          };

          // 🔥 滚动事件监听（使用可配置的节流）
          let scrollTimeout: NodeJS.Timeout | null = null;
          const handleScroll = () => {
            // 如果正在编辑且禁用编辑时虚拟化，跳过
            if (!enableWhileEditing && isEditing) {
              if (enableDebugLog) {
                // console.log('[VirtualScroll] 🚫 编辑中，跳过虚拟化更新');
              }
              return;
            }

            // if (enableDebugLog) {
            //   console.log(
            //     '[VirtualScroll] 📜 滚动事件触发, scrollTop:',
            //     scrollContainer?.scrollTop,
            //   );
            // }

            if (scrollTimeout) clearTimeout(scrollTimeout);
            scrollTimeout = setTimeout(() => {
              cancelAnimationFrame(rafId);
              rafId = requestAnimationFrame(() => {
                if (enableDebugLog) {
                  // console.log('[VirtualScroll] 🔄 更新可视区域');
                }
                view.dispatch(
                  view.state.tr.setMeta('scrollUpdate', {
                    view,
                    scrollTop: scrollContainer?.scrollTop,
                  }),
                );
              });
            }, scrollThrottle);
          };

          if (scrollContainer) {
            if (enableDebugLog) {
              console.log(
                '[VirtualScroll] ✅ 绑定滚动事件到容器:',
                scrollContainer,
              );
            }
            scrollContainer.addEventListener('scroll', handleScroll, {
              passive: true,
            });
          } else {
            console.error(
              '[VirtualScroll] ❌ 滚动容器为 null，无法绑定滚动事件！',
            );
          }

          // 🔥 监听编辑事件
          view.dom.addEventListener('input', () => setEditingState(true));
          view.dom.addEventListener('keydown', () => setEditingState(true));
          view.dom.addEventListener('compositionstart', () =>
            setEditingState(true),
          );
          view.dom.addEventListener('compositionend', () =>
            setEditingState(true),
          );

          // ResizeObserver 测量真实高度
          resizeObserver = new ResizeObserver((entries) => {
            const updates: { blockId: string; height: number }[] = [];

            entries.forEach((entry) => {
              const el = entry.target as HTMLElement;
              const blockId = el.getAttribute('data-block-id');

              // 只测量可见节点（没有 virtual-hidden class）
              if (blockId && !el.classList.contains('virtual-hidden')) {
                const height = entry.contentRect.height;
                if (height > 0) {
                  updates.push({ blockId, height });
                }
              }
            });

            if (updates.length > 0) {
              requestIdleCallback(
                () => {
                  view.dispatch(
                    view.state.tr.setMeta('heightUpdates', updates),
                  );
                },
                { timeout: 100 },
              );
            }
          });

          // 观察所有块节点
          const observeBlocks = () => {
            view.dom.querySelectorAll('[data-block-id]').forEach((el) => {
              resizeObserver?.observe(el as HTMLElement);
            });
          };

          // 初始化
          setTimeout(() => {
            observeBlocks();
            initVisibleRange(); // 🔥 使用新的初始化方法
          }, 100);

          return {
            update(view, prevState) {
              // 文档结构变化时重新观察
              if (view.state.doc !== prevState.doc) {
                observeBlocks();
              }
            },

            destroy() {
              if (scrollContainer) {
                scrollContainer.removeEventListener('scroll', handleScroll);
              }
              resizeObserver?.disconnect();
              cancelAnimationFrame(rafId);
              if (scrollTimeout) clearTimeout(scrollTimeout);
              if (editingTimeout) clearTimeout(editingTimeout);
            },
          };
        },
      }),
    ];
  },
});

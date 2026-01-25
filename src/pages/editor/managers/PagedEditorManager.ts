/**
 * PagedEditorManager - 分页编辑器核心管理器
 *
 * 负责：
 * - 页面动态加载/卸载
 * - 滚动监听和页面切换
 * - 脏页保存
 * - 边界检查
 */

import type { Editor } from '@tiptap/core';
import { pagedDocDB, type PageContent } from '../storage/PagedDocStorage';
import { TOCIndexManager } from './TOCIndexManager';

const BUFFER_PAGES = 1; // 缓冲区页数（当前页 ± BUFFER_PAGES）
const ESTIMATED_PAGE_HEIGHT = 8000; // 预估页面高度（像素）
const MAX_CACHED_PAGES = 10; // 最大缓存页数（防止内存泄漏）

interface PagedEditorState {
  docId: string;
  loadedPages: Map<number, PageContent>; // 已加载的页面数据
  renderedPages: Set<number>; // 已渲染真实内容的页面（非占位符）
  pageHeights: Map<number, number>; // 页面高度缓存（像素）
  currentPage: number;
  dirtyPages: Set<number>;
  totalPages: number;
  isLoading: boolean;
  isSwitchingPage: boolean; // 标志位：是否正在手动切换页面
}

export class PagedEditorManager {
  private editor: Editor;
  private state: PagedEditorState;
  private tocManager: TOCIndexManager;
  private scrollContainer: HTMLElement | null = null;
  private scrollListener: (() => void) | null = null;
  private autoSaveTimer: number | null = null;

  constructor(editor: Editor, docId: string) {
    this.editor = editor;
    this.tocManager = new TOCIndexManager(docId);

    this.state = {
      docId,
      loadedPages: new Map(),
      renderedPages: new Set(),
      pageHeights: new Map(),
      currentPage: 1,
      dirtyPages: new Set(),
      totalPages: 1,
      isLoading: false,
      isSwitchingPage: false,
    };
  }

  /**
   * 初始化编辑器（虚拟列表式分页）
   */
  async init(startPage = 1): Promise<void> {
    console.log('[PagedEditor] 🚀 虚拟列表式分页初始化，起始页:', startPage);

    // 1. 加载文档元数据
    const meta = await pagedDocDB.getDocMeta(this.state.docId);
    if (meta) {
      this.state.totalPages = meta.totalPages;
      console.log('[PagedEditor] 📄 总页数:', meta.totalPages);
    }

    // 2. 加载目录索引
    await this.tocManager.load();

    // 3. 加载初始可视区和缓冲区的页面数据
    this.state.currentPage = startPage;
    const pagesToLoad = this.getVisiblePages(startPage);
    await this.loadPagesData(pagesToLoad);

    // 4. 一次性渲染所有页面（占位符 + 真实内容）
    await this.renderAllPagesWithVirtualList();

    // 5. 设置滚动监听
    this.setupScrollListener();

    // 6. 监听编辑器变化
    this.setupEditorListeners();

    // 7. 测量已渲染页面的真实高度
    this.measureRenderedPageHeights();

    console.log('[PagedEditor] ✅ 初始化完成');
    console.log('  - 总页数:', this.state.totalPages);
    console.log('  - 当前页:', this.state.currentPage);
    console.log('  - 已加载数据:', Array.from(this.state.loadedPages.keys()));
    console.log('  - 已渲染页面:', Array.from(this.state.renderedPages));
  }

  /**
   * 查找页面在文档中的范围
   */
  private findPageRange(pageNum: number): { from: number; to: number } | null {
    let from = 0;
    let to = this.editor.state.doc.content.size;
    let foundStart = false;

    this.editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'pageBreak') {
        if (node.attrs.pageNum === pageNum) {
          from = pos;
          foundStart = true;
        } else if (node.attrs.pageNum === pageNum + 1 && foundStart) {
          to = pos;
          return false;
        }
      }
      return true;
    });

    return foundStart ? { from, to } : null;
  }

  /**
   * 🔥 虚拟列表核心：获取需要真实渲染的页码（当前页 ± 缓冲区）
   */
  private getVisiblePages(centerPage: number): number[] {
    const pages: number[] = [];
    const start = Math.max(1, centerPage - BUFFER_PAGES);
    const end = Math.min(this.state.totalPages, centerPage + BUFFER_PAGES);

    for (let i = start; i <= end; i++) {
      pages.push(i);
    }

    return pages;
  }

  /**
   * 🔥 虚拟列表核心：仅加载页面数据到内存（不渲染到编辑器）
   */
  private async loadPagesData(pageNums: number[]): Promise<void> {
    const promises = pageNums
      .filter((p) => p >= 1 && p <= this.state.totalPages)
      .filter((p) => !this.state.loadedPages.has(p))
      .map(async (pageNum) => {
        const page = await pagedDocDB.getPage(this.state.docId, pageNum);
        if (page) {
          this.state.loadedPages.set(pageNum, page);
        }
      });

    await Promise.all(promises);
  }

  /**
   * 🔥 虚拟列表核心：一次性渲染所有页面（占位符 + 真实内容）
   */
  private async renderAllPagesWithVirtualList(): Promise<void> {
    console.log('[PagedEditor] 🎨 开始虚拟列表式渲染...');

    const content: any[] = [];
    const visiblePages = this.getVisiblePages(this.state.currentPage);
    const visibleSet = new Set(visiblePages);

    for (let pageNum = 1; pageNum <= this.state.totalPages; pageNum++) {
      // 添加页面分隔符（占位符模式）
      const height =
        this.state.pageHeights.get(pageNum) || ESTIMATED_PAGE_HEIGHT;
      const isPlaceholder =
        !visibleSet.has(pageNum) || !this.state.loadedPages.has(pageNum);

      content.push({
        type: 'pageBreak',
        attrs: {
          pageNum,
          isPlaceholder,
          placeholderHeight: isPlaceholder ? height : 0,
        },
      });

      if (!isPlaceholder) {
        // 可视区和缓冲区：渲染真实内容
        const page = this.state.loadedPages.get(pageNum)!;
        const pageContent = JSON.parse(page.content);
        content.push(...pageContent.content); // 展开页面内容

        this.state.renderedPages.add(pageNum);
        console.log(`[PagedEditor] ✅ 渲染真实内容: Page ${pageNum}`);
      } else {
        // 非可视区：只有分隔符占位，无额外内容
        this.state.renderedPages.delete(pageNum);
        console.log(
          `[PagedEditor] 📦 占位符: Page ${pageNum}, 高度: ${height}px`,
        );
      }
    }

    // 一次性设置整个文档内容
    this.editor.commands.setContent({
      type: 'doc',
      content,
    });

    console.log('[PagedEditor] 🎨 渲染完成');
    console.log('  - 总页数:', this.state.totalPages);
    console.log('  - 真实渲染:', Array.from(this.state.renderedPages));
  }

  /**
   * 🔥 增量更新：替换单个页面的内容（占位符 ↔ 真实内容）
   * 使用 Transaction 遵循 ProseMirror 不可变设计
   */
  private replacePageContent(
    pageNum: number,
    toPlaceholder: boolean,
    force = false,
  ): boolean {
    const range = this.findPageRange(pageNum);
    if (!range) {
      console.warn(`[PagedEditor] 无法找到 Page ${pageNum} 的范围`);
      return false;
    }

    // 边界保护：不能替换正在编辑的页面（除非 force = true）
    if (!force && !this.canReplacePage(pageNum)) {
      console.log(`[PagedEditor] 跳过替换 Page ${pageNum}（编辑或选区中）`);
      return false;
    }

    const { state, view } = this.editor;
    const { schema } = state;
    const tr = state.tr;

    try {
      // 🔥 关键：找到 pageBreak 节点的位置和后续内容范围
      let pageBreakPos = -1;
      let contentStart = -1;
      const contentEnd = range.to;

      state.doc.nodesBetween(range.from, range.to, (node, pos) => {
        if (node.type.name === 'pageBreak' && node.attrs.pageNum === pageNum) {
          pageBreakPos = pos;
          contentStart = pos + node.nodeSize;
          return false;
        }
        return true;
      });

      if (pageBreakPos < 0 || contentStart < 0) {
        console.warn(`[PagedEditor] 无法定位 Page ${pageNum} 的 pageBreak`);
        return false;
      }

      if (toPlaceholder) {
        // 真实内容 → 占位符
        const height =
          this.state.pageHeights.get(pageNum) || ESTIMATED_PAGE_HEIGHT;

        // 1. 更新 pageBreak 节点属性
        tr.setNodeMarkup(pageBreakPos, undefined, {
          pageNum,
          isPlaceholder: true,
          placeholderHeight: height,
        });

        // 2. 删除后续的真实内容（保留 pageBreak）
        if (contentStart < contentEnd) {
          tr.delete(contentStart, contentEnd);
        }

        this.state.renderedPages.delete(pageNum);
        console.log(`[PagedEditor] ✅ 替换为占位符: Page ${pageNum}`);
      } else {
        // 占位符 → 真实内容
        const page = this.state.loadedPages.get(pageNum);
        if (!page) {
          console.warn(`[PagedEditor] Page ${pageNum} 数据未加载`);
          return false;
        }

        const pageContent = JSON.parse(page.content);

        console.log(`[PagedEditor] 🔍 准备插入内容，Page ${pageNum}:`, {
          hasContent: !!pageContent.content,
          contentLength: pageContent.content?.length,
          contentStart,
          pageBreakPos,
        });

        // 1. 更新 pageBreak 节点属性（取消占位符模式）
        tr.setNodeMarkup(pageBreakPos, undefined, {
          pageNum,
          isPlaceholder: false,
          placeholderHeight: 0,
        });

        // 2. 在 pageBreak 后插入真实内容
        if (pageContent.content && pageContent.content.length > 0) {
          // 🔥 关键修复：占位符模式下 contentStart === contentEnd（没有内容需要删除）
          // 先删除占位符后的空内容（如果有）
          if (contentStart < contentEnd) {
            tr.delete(contentStart, contentEnd);
          }

          try {
            // 创建节点片段并一次性插入（而非逐个插入）
            const fragment = schema.nodeFromJSON({
              type: 'doc',
              content: pageContent.content,
            }).content;

            // 验证 fragment 是否有效
            if (fragment.size === 0) {
              console.error(`[PagedEditor] ❌ Fragment 为空，Page ${pageNum}`);
              return false;
            }

            tr.insert(contentStart, fragment);

            console.log(
              `[PagedEditor] 📝 已插入 ${pageContent.content.length} 个节点，Fragment 大小: ${fragment.size}`,
            );
          } catch (fragmentError) {
            console.error(
              `[PagedEditor] ❌ 创建 Fragment 失败:`,
              fragmentError,
            );
            console.error('页面内容:', pageContent);
            return false;
          }
        } else {
          console.warn(`[PagedEditor] ⚠️ Page ${pageNum} 内容为空`);
          // 内容为空也算成功，只是没有内容显示
        }

        this.state.renderedPages.add(pageNum);
        console.log(`[PagedEditor] ✅ 替换为真实内容: Page ${pageNum}`);
      }

      // 🔥 关键：使用单个 Transaction 应用所有变更
      view.dispatch(tr);
      return true;
    } catch (error) {
      console.error(`[PagedEditor] 替换 Page ${pageNum} 失败:`, error);
      return false;
    }
  }

  /**
   * 检查是否可以替换页面内容
   */
  private canReplacePage(pageNum: number): boolean {
    // 当前页不替换（正在查看/编辑）
    if (pageNum === this.state.currentPage) {
      return false;
    }

    // 有未保存修改不替换
    if (this.state.dirtyPages.has(pageNum)) {
      return false;
    }

    // 选区在该页内不替换
    const { from, to } = this.editor.state.selection;
    const range = this.findPageRange(pageNum);
    if (range && from >= range.from && to <= range.to) {
      return false;
    }

    return true;
  }

  /**
   * 🔥 虚拟列表核心：测量已渲染页面的真实高度
   */
  private measureRenderedPageHeights(): void {
    setTimeout(() => {
      let measuredCount = 0;
      this.editor.state.doc.descendants((node, pos) => {
        if (node.type.name === 'pageBreak') {
          const pageNum = node.attrs.pageNum;
          if (this.state.renderedPages.has(pageNum)) {
            // 查找下一个 pageBreak 的位置来计算高度
            const nextBreakPos = this.findNextPageBreakPosition(pos);
            if (nextBreakPos > 0) {
              const element = this.editor.view.domAtPos(pos)
                .node as HTMLElement;
              const nextElement = this.editor.view.domAtPos(nextBreakPos)
                .node as HTMLElement;

              if (element && nextElement) {
                const rect1 = element.getBoundingClientRect();
                const rect2 = nextElement.getBoundingClientRect();
                const height = Math.abs(rect2.top - rect1.top);

                if (height > 0) {
                  this.state.pageHeights.set(pageNum, height);
                  measuredCount++;
                }
              }
            }
          }
        }
        return true;
      });

      console.log(
        `[PagedEditor] 📏 测量完成，已记录 ${measuredCount} 个页面高度`,
      );
    }, 300);
  }

  /**
   * 查找下一个 pageBreak 的位置
   */
  private findNextPageBreakPosition(currentPos: number): number {
    let nextPos = -1;
    let found = false;

    this.editor.state.doc.descendants((node, pos) => {
      if (found) return false;
      if (node.type.name === 'pageBreak' && pos > currentPos) {
        nextPos = pos;
        found = true;
        return false;
      }
      return true;
    });

    return nextPos;
  }

  /**
   * 🔥 虚拟列表核心：滚动时更新可见页面（增量替换）
   * @param forceSwitching 是否强制切换（用于 switchToPage，绕过当前页保护）
   */
  private async updateVisiblePages(
    newVisiblePage: number,
    forceSwitching = false,
  ): Promise<void> {
    const newVisiblePages = this.getVisiblePages(newVisiblePage);
    const newVisibleSet = new Set(newVisiblePages);
    const currentRendered = new Set(this.state.renderedPages);

    // 找出需要渲染的页面（当前是占位符，需要变成真实内容）
    const pagesToRender = newVisiblePages.filter(
      (p) => !currentRendered.has(p),
    );

    // 找出需要变成占位符的页面（当前是真实内容，需要变成占位符）
    const pagesToPlaceholder = Array.from(currentRendered).filter(
      (p) => !newVisibleSet.has(p),
    );

    if (pagesToRender.length === 0 && pagesToPlaceholder.length === 0) {
      return; // 无需更新
    }

    console.log('[PagedEditor] 🔄 增量更新可见页面:');
    console.log('  - 需要渲染:', pagesToRender);
    console.log('  - 需要占位:', pagesToPlaceholder);

    // 先加载需要渲染的页面数据
    await this.loadPagesData(pagesToRender);

    // 🔥 增量替换：先替换远离的页面为占位符，再渲染新页面
    // 这样可以减少内存峰值

    // 1. 先将远离的页面替换为占位符（释放内存）
    for (const pageNum of pagesToPlaceholder) {
      // 保存脏页
      if (this.state.dirtyPages.has(pageNum)) {
        await this.savePage(pageNum);
      }
      this.replacePageContent(pageNum, true);
    }

    // 2. 再将新页面替换为真实内容
    for (const pageNum of pagesToRender) {
      // 如果是强制切换（switchToPage），允许替换当前页
      this.replacePageContent(pageNum, false, forceSwitching);
    }

    // 3. 测量新渲染页面的高度
    this.measureRenderedPageHeights();

    // 4. 清理远离的页面缓存（防止内存泄漏）
    this.cleanupDistantPages();

    console.log(
      '[PagedEditor] ✅ 增量更新完成，当前渲染:',
      Array.from(this.state.renderedPages),
    );
  }

  /**
   * 🔥 内存管理：清理远离当前页的缓存数据
   */
  private cleanupDistantPages(): void {
    const visiblePages = this.getVisiblePages(this.state.currentPage);
    const keepSet = new Set(visiblePages);

    // 计算需要保留的额外页面（扩展缓冲区，防止频繁加载）
    const extendedKeep = new Set<number>();
    for (
      let i = Math.max(1, this.state.currentPage - 3);
      i <= Math.min(this.state.totalPages, this.state.currentPage + 3);
      i++
    ) {
      extendedKeep.add(i);
    }

    // 如果缓存超过限制，清理远离的页面
    if (this.state.loadedPages.size > MAX_CACHED_PAGES) {
      const pagesToRemove: number[] = [];

      for (const [pageNum, _] of this.state.loadedPages) {
        // 不在扩展缓冲区内且不是脏页，可以清理
        if (!extendedKeep.has(pageNum) && !this.state.dirtyPages.has(pageNum)) {
          pagesToRemove.push(pageNum);
        }
      }

      // 按距离排序，优先清理最远的
      pagesToRemove.sort((a, b) => {
        const distA = Math.abs(a - this.state.currentPage);
        const distB = Math.abs(b - this.state.currentPage);
        return distB - distA;
      });

      // 清理到合理数量
      const removeCount = this.state.loadedPages.size - MAX_CACHED_PAGES;
      for (let i = 0; i < Math.min(removeCount, pagesToRemove.length); i++) {
        const pageNum = pagesToRemove[i];
        this.state.loadedPages.delete(pageNum);
        console.log(`[PagedEditor] 🧹 清理缓存: Page ${pageNum}`);
      }

      if (pagesToRemove.length > 0) {
        console.log(
          `[PagedEditor] 🧹 内存清理完成，当前缓存: ${this.state.loadedPages.size} 页`,
        );
      }
    }
  }

  /**
   * 设置滚动监听（优化版：防抖 + RAF）
   */
  private setupScrollListener(): void {
    this.scrollContainer = document.querySelector('#tiptap');
    if (!this.scrollContainer) {
      console.warn('[PagedEditor] 找不到滚动容器 #tiptap');
      return;
    }

    let rafId: number | null = null;
    let scrollTimeout: number | null = null;

    this.scrollListener = () => {
      // 清除之前的防抖定时器和 RAF
      if (scrollTimeout) {
        clearTimeout(scrollTimeout);
      }
      if (rafId) {
        cancelAnimationFrame(rafId);
      }

      // 🔥 使用 RAF 立即响应滚动（不等待防抖）
      rafId = requestAnimationFrame(() => {
        this.handleScroll();
        rafId = null;
      });

      // 🔥 优化：减少防抖延迟到 50ms，提升响应速度
      scrollTimeout = window.setTimeout(() => {
        // 滚动停止后再执行一次，确保最终状态正确
        this.handleScroll();
      }, 50);
    };

    this.scrollContainer.addEventListener('scroll', this.scrollListener, {
      passive: true, // 优化：标记为被动监听器，提升滚动性能
    });

    console.log('[PagedEditor] ✅ 滚动监听已设置（优化版）');
  }

  /**
   * 🔥 虚拟列表式滚动处理（优化版：使用 requestIdleCallback）
   */
  private handleScroll(): void {
    console.log('[PagedEditor] 🔍 handleScroll 被调用');

    if (!this.scrollContainer) {
      console.warn('[PagedEditor] ⚠️ scrollContainer 不存在');
      return;
    }

    // 如果正在手动切换页面，忽略滚动事件
    if (this.state.isSwitchingPage) {
      console.log('[PagedEditor] ⏸️ 正在切换页面，忽略滚动');
      return;
    }

    const { scrollTop, clientHeight } = this.scrollContainer;
    console.log(
      `[PagedEditor] 📏 滚动位置: scrollTop=${scrollTop}, clientHeight=${clientHeight}`,
    );

    // 🔥 基于占位符累计高度计算当前可见页码
    const visiblePage = this.calculateVisiblePageByHeight(
      scrollTop,
      clientHeight,
    );

    console.log(
      `[PagedEditor] 🔍 计算可见页: ${visiblePage}, 当前页: ${this.state.currentPage}`,
    );

    // 验证计算出的页码
    if (visiblePage < 1 || visiblePage > this.state.totalPages) {
      console.warn(
        `[PagedEditor] ⚠️ 计算出的页码 ${visiblePage} 超出范围 [1-${this.state.totalPages}]`,
      );
      return;
    }

    // 页面切换时，触发虚拟列表更新
    if (visiblePage !== this.state.currentPage) {
      console.log(
        `[PagedEditor] 📜 滚动到 Page ${visiblePage}，从 Page ${this.state.currentPage} 切换`,
      );

      // 立即更新当前页标记（不阻塞滚动）
      this.state.currentPage = visiblePage;

      // 🔥 直接更新页面内容，不使用 requestIdleCallback（避免快速滚动时延迟）
      this.updateVisiblePages(visiblePage);
    }
  }

  /**
   * 🔥 虚拟列表核心：基于累计高度计算当前可见页码
   */
  private calculateVisiblePageByHeight(
    scrollTop: number,
    clientHeight: number,
  ): number {
    const viewportCenter = scrollTop + clientHeight / 2;
    let accumulatedHeight = 0;
    let currentPage = 1;

    // 累加每一页的高度，找到视口中心所在的页面
    for (let pageNum = 1; pageNum <= this.state.totalPages; pageNum++) {
      const pageHeight =
        this.state.pageHeights.get(pageNum) || ESTIMATED_PAGE_HEIGHT;

      if (accumulatedHeight + pageHeight >= viewportCenter) {
        currentPage = pageNum;
        break;
      }

      accumulatedHeight += pageHeight;
      currentPage = pageNum; // 如果循环结束，说明在最后一页
    }

    return Math.max(1, Math.min(currentPage, this.state.totalPages));
  }

  /**
   * 设置编辑器监听
   */
  private setupEditorListeners(): void {
    this.editor.on('update', () => {
      // 标记当前页为脏
      this.state.dirtyPages.add(this.state.currentPage);

      // 启动自动保存
      this.scheduleAutoSave();
    });
  }

  /**
   * 调度自动保存
   */
  private scheduleAutoSave(): void {
    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }

    this.autoSaveTimer = window.setTimeout(() => {
      this.autoSave();
    }, 2000);
  }

  /**
   * 自动保存
   */
  private async autoSave(): Promise<void> {
    const dirtyPages = Array.from(this.state.dirtyPages);

    if (dirtyPages.length === 0) return;

    console.log('[PagedEditor] 自动保存，脏页:', dirtyPages);

    for (const pageNum of dirtyPages) {
      await this.savePage(pageNum);
    }
  }

  /**
   * 保存单个页面
   */
  private async savePage(pageNum: number): Promise<void> {
    const range = this.findPageRange(pageNum);
    if (!range) {
      console.warn(`[PagedEditor] 无法保存 Page ${pageNum}，找不到范围`);
      return;
    }

    try {
      // 提取页面内容（使用 cut 获取节点片段）
      const pageNode = this.editor.state.doc.cut(range.from, range.to);
      const content = JSON.stringify(pageNode.toJSON());

      // 提取标题（传递完整的文档节点和范围）
      const headings = this.tocManager.extractHeadings(pageNode, 0);

      // 计算字数
      const wordCount = pageNode.textContent.length;

      // 保存到存储
      const pageContent: PageContent = {
        docId: this.state.docId,
        pageNum,
        content,
        headings,
        wordCount,
        lastModified: Date.now(),
      };

      await pagedDocDB.savePage(pageContent);

      // 更新目录索引
      await this.tocManager.updatePageHeadings(pageNum, headings);

      // 清除脏标记
      this.state.dirtyPages.delete(pageNum);

      console.log(
        `[PagedEditor] 保存 Page ${pageNum} 成功，字数: ${wordCount}`,
      );
    } catch (error) {
      console.error(`[PagedEditor] 保存 Page ${pageNum} 失败:`, error);
    }
  }

  /**
   * 🔥 虚拟列表式跳转到指定标题
   */
  async scrollToHeading(itemId: string): Promise<void> {
    const item = this.tocManager.findItem(itemId);
    if (!item) {
      console.warn('[PagedEditor] 找不到目录项:', itemId);
      return;
    }

    const { pageNum } = item;

    console.log(`[PagedEditor] 🎯 跳转到标题: ${item.text}, Page ${pageNum}`);

    // 🔥 虚拟列表式：先切换到目标页面（触发重新渲染）
    await this.switchToPage(pageNum);

    // 🔥 等待渲染完成（增加到 500ms，确保 DOM 更新）
    await new Promise((resolve) => setTimeout(resolve, 500));

    // 🔥 添加重试机制：最多重试 3 次查找目标元素
    let targetElement: Element | null = null;
    let retryCount = 0;
    const maxRetries = 3;

    while (!targetElement && retryCount < maxRetries) {
      targetElement = document.querySelector(`[data-block-id="${itemId}"]`);

      if (!targetElement) {
        console.log(
          `[PagedEditor] 🔍 第 ${retryCount + 1} 次未找到目标元素，等待重试...`,
        );
        await new Promise((resolve) => setTimeout(resolve, 200));
        retryCount++;
      }
    }

    if (targetElement) {
      // 🔥 先清除 isSwitchingPage 标志，允许滚动事件正常处理
      this.state.isSwitchingPage = false;

      targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
      console.log('[PagedEditor] ✅ 跳转成功');
    } else {
      console.error('[PagedEditor] ❌ 重试 3 次后仍未找到目标元素:', itemId);
      // 降级：至少滚动到目标页面顶部
      console.log('[PagedEditor] 降级：已滚动到 Page', pageNum, '顶部');
    }
  }

  /**
   * 获取指定页面的目录
   */
  getTocForPage(pageNum: number) {
    return this.tocManager.getPageHeadings(pageNum);
  }

  /**
   * 🔥 虚拟列表式切换到指定页面
   */
  async switchToPage(pageNum: number): Promise<void> {
    if (pageNum < 1 || pageNum > this.state.totalPages) {
      console.warn('[PagedEditor] 无效的页码:', pageNum);
      return;
    }

    // 设置标志位，防止滚动事件干扰
    this.state.isSwitchingPage = true;
    console.log(`[PagedEditor] 🔄 手动切换到 Page ${pageNum}`);

    try {
      // 🔥 虚拟列表式：直接更新可见页面（触发重新渲染）
      this.state.currentPage = pageNum;
      // 传入 forceSwitching = true，允许替换当前页
      await this.updateVisiblePages(pageNum, true);

      // 🔥 滚动到目标页面的起始位置
      await new Promise((resolve) => setTimeout(resolve, 100));

      // 计算目标页面的累计高度偏移量
      let scrollOffset = 0;
      for (let i = 1; i < pageNum; i++) {
        scrollOffset += this.state.pageHeights.get(i) || ESTIMATED_PAGE_HEIGHT;
      }

      if (this.scrollContainer) {
        this.scrollContainer.scrollTop = scrollOffset;
        console.log(`[PagedEditor] ✅ 滚动到偏移量: ${scrollOffset}px`);
      }

      console.log('[PagedEditor] ✅ 页面切换完成:', pageNum);
    } finally {
      // 🔥 优化：减少延迟到 300ms（之前 500ms 太长）
      // 注意：scrollToHeading 会提前清除此标志
      setTimeout(() => {
        this.state.isSwitchingPage = false;
      }, 300);
    }
  }

  /**
   * 监听页面切换事件
   */
  onPageChange(callback: () => void): () => void {
    // 创建一个简单的事件监听器
    const listener = () => {
      callback();
    };

    // 监听当前页面变化
    let lastPage = this.state.currentPage;
    const checkPageChange = setInterval(() => {
      if (this.state.currentPage !== lastPage) {
        lastPage = this.state.currentPage;
        listener();
      }
    }, 500);

    // 返回取消订阅函数
    return () => {
      clearInterval(checkPageChange);
    };
  }

  /**
   * 获取 currentPage 属性
   */
  get currentPage(): number {
    return this.state.currentPage;
  }

  /**
   * 获取 totalPages 属性
   */
  get totalPages(): number {
    return this.state.totalPages;
  }

  /**
   * 获取 isLoading 属性
   */
  get isLoading(): boolean {
    return this.state.isLoading;
  }

  /**
   * 销毁
   */
  destroy(): void {
    // 保存所有脏页
    this.autoSave();

    // 移除监听器
    if (this.scrollContainer && this.scrollListener) {
      this.scrollContainer.removeEventListener('scroll', this.scrollListener);
    }

    if (this.autoSaveTimer) {
      clearTimeout(this.autoSaveTimer);
    }

    console.log('[PagedEditor] 已销毁');
  }
}

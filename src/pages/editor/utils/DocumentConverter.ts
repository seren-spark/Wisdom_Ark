/**
 * DocumentConverter - 文档转换工具
 *
 * 将现有的完整文档转换为分页格式：
 * - 按字数拆分页面
 * - 生成页面分隔标记
 * - 提取并保存目录索引
 */

import type { Editor } from '@tiptap/core';
import {
  pagedDocDB,
  type DocumentMeta,
  type PageContent,
  type TOCIndex,
  type HeadingInfo,
} from '../storage/PagedDocStorage';

const DEFAULT_PAGE_SIZE = 5000;

export class DocumentConverter {
  /**
   * 将完整文档转换为分页格式
   */
  static async convertToPagedDocument(
    editor: Editor,
    docId: string,
    title: string,
    pageSize: number = DEFAULT_PAGE_SIZE,
  ): Promise<void> {
    console.log('[DocumentConverter] 开始转换文档:', docId);

    const startTime = Date.now();

    // 1. 提取完整文档内容
    const fullDoc = editor.getJSON();
    const fullText = editor.getText();
    const totalWords = fullText.length;

    console.log(`[DocumentConverter] 文档总字数: ${totalWords}`);

    // 2. 按字数拆分成页面
    const pages = this.splitIntoPages(fullDoc, pageSize);
    console.log(`[DocumentConverter] 拆分为 ${pages.length} 页`);

    // 3. 提取所有标题并构建目录索引
    const tocItems = this.extractAllHeadings(pages);
    console.log(`[DocumentConverter] 提取 ${tocItems.length} 个标题`);

    // 4. 保存文档元数据
    const meta: DocumentMeta = {
      docId,
      title,
      totalPages: pages.length,
      pageSize,
      lastModified: Date.now(),
    };
    await pagedDocDB.saveDocMeta(meta);
    console.log('[DocumentConverter] 保存元数据');

    // 5. 保存所有页面
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageNum = i + 1;

      const pageContent: PageContent = {
        docId,
        pageNum,
        content: JSON.stringify(page.content),
        headings: page.headings,
        wordCount: page.wordCount,
        lastModified: Date.now(),
      };

      await pagedDocDB.savePage(pageContent);
      console.log(
        `[DocumentConverter] 保存 Page ${pageNum} (${page.wordCount} 字)`,
      );
    }

    // 6. 保存目录索引
    const tocIndex: TOCIndex = {
      docId,
      items: tocItems,
      lastModified: Date.now(),
    };
    await pagedDocDB.saveTOCIndex(tocIndex);
    console.log('[DocumentConverter] 保存目录索引');

    const elapsed = Date.now() - startTime;
    console.log(`[DocumentConverter] 转换完成，耗时 ${elapsed}ms`);
  }

  /**
   * 按字数拆分文档成多个页面
   */
  private static splitIntoPages(
    doc: any,
    pageSize: number,
  ): { content: any; headings: HeadingInfo[]; wordCount: number }[] {
    const pages: {
      content: any;
      headings: HeadingInfo[];
      wordCount: number;
    }[] = [];
    let currentPage: any = { type: 'doc', content: [] };
    let currentWordCount = 0;
    let currentHeadings: HeadingInfo[] = [];
    let posInPage = 0;

    // 递归遍历节点
    const processNode = (node: any) => {
      const nodeText = this.getNodeText(node);
      const nodeWordCount = nodeText.length;

      // 如果当前页加上这个节点会超过限制
      if (currentWordCount > 0 && currentWordCount + nodeWordCount > pageSize) {
        // 保存当前页
        pages.push({
          content: currentPage,
          headings: currentHeadings,
          wordCount: currentWordCount,
        });

        // 开始新页
        currentPage = { type: 'doc', content: [] };
        currentWordCount = 0;
        currentHeadings = [];
        posInPage = 0;
      }

      // 添加节点到当前页
      currentPage.content.push(node);
      currentWordCount += nodeWordCount;

      // 如果是标题，记录到当前页的标题列表
      if (node.type === 'heading') {
        currentHeadings.push({
          id: node.attrs?.blockId || `heading-${posInPage}`,
          text: nodeText,
          level: node.attrs?.level || 1,
          posInPage,
        });
      }

      posInPage += 1;
    };

    // 遍历所有顶级节点
    if (doc.content && Array.isArray(doc.content)) {
      doc.content.forEach((node: any) => {
        processNode(node);
      });
    }

    // 保存最后一页
    if (currentPage.content.length > 0) {
      pages.push({
        content: currentPage,
        headings: currentHeadings,
        wordCount: currentWordCount,
      });
    }

    return pages;
  }

  /**
   * 提取所有页面的标题，构建完整目录
   */
  private static extractAllHeadings(
    pages: { content: any; headings: HeadingInfo[]; wordCount: number }[],
  ): {
    id: string;
    text: string;
    level: number;
    pageNum: number;
    posInPage: number;
  }[] {
    const allItems: {
      id: string;
      text: string;
      level: number;
      pageNum: number;
      posInPage: number;
    }[] = [];

    pages.forEach((page, index) => {
      const pageNum = index + 1;
      page.headings.forEach((heading) => {
        allItems.push({
          id: heading.id,
          text: heading.text,
          level: heading.level,
          pageNum,
          posInPage: heading.posInPage,
        });
      });
    });

    return allItems;
  }

  /**
   * 获取节点的文本内容
   */
  private static getNodeText(node: any): string {
    if (node.type === 'text') {
      return node.text || '';
    }

    if (node.content && Array.isArray(node.content)) {
      return node.content.map((child: any) => this.getNodeText(child)).join('');
    }

    return '';
  }

  /**
   * 从分页文档恢复为完整文档
   */
  static async convertToFullDocument(docId: string): Promise<any> {
    console.log('[DocumentConverter] 恢复完整文档:', docId);

    // 1. 加载元数据
    const meta = await pagedDocDB.getDocMeta(docId);
    if (!meta) {
      throw new Error(`文档 ${docId} 不存在`);
    }

    // 2. 加载所有页面
    const pages: any[] = [];
    for (let i = 1; i <= meta.totalPages; i++) {
      const page = await pagedDocDB.getPage(docId, i);
      if (page) {
        pages.push(JSON.parse(page.content));
      }
    }

    // 3. 合并所有页面
    const mergedDoc = {
      type: 'doc',
      content: [],
    };

    pages.forEach((pageDoc: any) => {
      if (pageDoc.content && Array.isArray(pageDoc.content)) {
        mergedDoc.content.push(...pageDoc.content);
      }
    });

    console.log(
      '[DocumentConverter] 恢复完成，总节点数:',
      mergedDoc.content.length,
    );

    return mergedDoc;
  }

  /**
   * 清除文档数据
   */
  static async deleteDocument(docId: string): Promise<void> {
    console.log('[DocumentConverter] 删除文档:', docId);
    await pagedDocDB.deleteDocument(docId);
    console.log('[DocumentConverter] 删除完成');
  }

  /**
   * 获取文档统计信息
   */
  static async getDocumentStats(docId: string): Promise<{
    totalPages: number;
    totalWords: number;
    totalHeadings: number;
    averagePageSize: number;
  } | null> {
    const meta = await pagedDocDB.getDocMeta(docId);
    if (!meta) return null;

    const tocIndex = await pagedDocDB.getTOCIndex(docId);

    let totalWords = 0;
    for (let i = 1; i <= meta.totalPages; i++) {
      const page = await pagedDocDB.getPage(docId, i);
      if (page) {
        totalWords += page.wordCount;
      }
    }

    return {
      totalPages: meta.totalPages,
      totalWords,
      totalHeadings: tocIndex?.items.length || 0,
      averagePageSize: Math.round(totalWords / meta.totalPages),
    };
  }
}

/**
 * PageBreak - 页面分隔标记节点（虚拟列表优化版）
 *
 * 用于标记分页加载中的页面边界
 * - 支持占位符模式：轻量的 CSS 占位而非内容节点
 * - 携带页码和高度信息
 * - 用于定位页面在文档中的位置
 */

import { Node, mergeAttributes } from '@tiptap/core';

export interface PageBreakOptions {
  HTMLAttributes: Record<string, unknown>;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: {
      setPageBreak: (
        pageNum: number,
        isPlaceholder?: boolean,
        placeholderHeight?: number,
      ) => ReturnType;
      removePageBreak: (pageNum: number) => ReturnType;
    };
  }
}

export const PageBreak = Node.create<PageBreakOptions>({
  name: 'pageBreak',

  group: 'block',

  atom: true,

  selectable: false,

  addOptions() {
    return {
      HTMLAttributes: {},
    };
  },

  addAttributes() {
    return {
      pageNum: {
        default: 0,
        parseHTML: (element) => {
          const pageNum = element.getAttribute('data-page-num');
          return pageNum ? parseInt(pageNum, 10) : 0;
        },
        renderHTML: (attributes) => {
          return {
            'data-page-num': attributes.pageNum,
          };
        },
      },
      isPlaceholder: {
        default: false,
        parseHTML: (element) =>
          element.getAttribute('data-placeholder') === 'true',
        renderHTML: (attributes) => {
          if (!attributes.isPlaceholder) return {};
          return {
            'data-placeholder': 'true',
          };
        },
      },
      placeholderHeight: {
        default: 0,
        parseHTML: (element) => {
          const height = element.getAttribute('data-placeholder-height');
          return height ? parseInt(height, 10) : 0;
        },
        renderHTML: (attributes) => {
          if (!attributes.isPlaceholder || !attributes.placeholderHeight)
            return {};
          return {
            'data-placeholder-height': attributes.placeholderHeight,
          };
        },
      },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-page-break]',
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const { pageNum, isPlaceholder, placeholderHeight } = node.attrs;
    const height = placeholderHeight || 8000;

    const classList = ['page-break-marker'];
    const styles: string[] = [];

    if (isPlaceholder) {
      classList.push('page-placeholder');
      styles.push(`height: ${height}px`);
      styles.push(`min-height: ${height}px`);
      styles.push(`contain-intrinsic-size: ${height}px`);
    }

    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-page-break': 'true',
        'data-page-num': pageNum,
        'data-placeholder': isPlaceholder ? 'true' : 'false',
        'data-placeholder-height': isPlaceholder ? height : undefined,
        class: classList.join(' '),
        style: styles.length > 0 ? styles.join('; ') : undefined,
      }),
    ];
  },

  addCommands() {
    return {
      setPageBreak:
        (pageNum: number, isPlaceholder = false, placeholderHeight = 0) =>
        ({ commands }) => {
          return commands.insertContent({
            type: this.name,
            attrs: {
              pageNum,
              isPlaceholder,
              placeholderHeight: isPlaceholder ? placeholderHeight : 0,
            },
          });
        },

      removePageBreak:
        (pageNum: number) =>
        ({ state, dispatch }) => {
          if (!dispatch) return false;

          let removed = false;
          state.doc.descendants((node, pos) => {
            if (
              node.type.name === this.name &&
              node.attrs.pageNum === pageNum
            ) {
              const tr = state.tr.delete(pos, pos + node.nodeSize);
              dispatch(tr);
              removed = true;
              return false;
            }
            return true;
          });

          return removed;
        },
    };
  },
});

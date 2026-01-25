/**
 * 分页编辑器使用示例
 *
 * 展示如何集成和使用 PagedEditorManager
 */

import { useEffect, useRef } from 'react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { PageBreak } from '../extensions/PageBreak';
import { PagedEditorManager } from '../managers/PagedEditorManager';
import '../styles/paged-editor.css';

export function PagedEditorExample() {
  const editorRef = useRef<Editor | null>(null);
  const managerRef = useRef<PagedEditorManager | null>(null);

  useEffect(() => {
    // 1. 创建编辑器实例
    const editor = new Editor({
      element: document.querySelector('#paged-editor'),
      extensions: [
        StarterKit,
        PageBreak, // 添加页面分隔节点
      ],
      content: '', // 初始为空，由 PagedEditorManager 加载
    });

    editorRef.current = editor;

    // 2. 创建分页管理器
    const manager = new PagedEditorManager(editor, 'doc-001');
    managerRef.current = manager;

    // 3. 初始化（加载第一页）
    manager.init(1).then(() => {
      console.log('分页编辑器初始化完成');
    });

    // 清理
    return () => {
      manager.destroy();
      editor.destroy();
    };
  }, []);

  // 目录跳转示例
  const handleTOCClick = (itemId: string) => {
    if (managerRef.current) {
      managerRef.current.scrollToHeading(itemId);
    }
  };

  return (
    <div>
      <div id="paged-editor" />
    </div>
  );
}

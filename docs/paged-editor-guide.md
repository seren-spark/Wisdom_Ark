# 分页编辑器使用指南

## 概述

分页编辑器方案用于处理超大文档（10-50万字+），通过动态加载/卸载页面来控制内存占用和渲染性能。

## 核心架构

```
┌─────────────────────────────────────┐
│         IndexedDB 存储              │
│  - 文档元数据                        │
│  - 页面内容（分页存储）               │
│  - 目录索引（独立）                   │
└─────────────────────────────────────┘
            ↕
┌─────────────────────────────────────┐
│      PagedEditorManager             │
│  - 页面动态加载/卸载                 │
│  - 滚动监听                          │
│  - 脏页保存                          │
└─────────────────────────────────────┘
            ↕
┌─────────────────────────────────────┐
│       Tiptap Editor                 │
│  - 同时保持 3-5 页在内存             │
│  - PageBreak 节点标记边界            │
└─────────────────────────────────────┘
```

## 快速开始

### 1. 安装依赖

```typescript
import { PageBreak } from '@/pages/editor/extensions/PageBreak';
import { PagedEditorManager } from '@/pages/editor/managers/PagedEditorManager';
import '@/pages/editor/styles/paged-editor.css';
```

### 2. 创建编辑器

```typescript
const editor = new Editor({
  extensions: [
    StarterKit,
    PageBreak, // 必须添加
    BlockAttributes, // 如果需要 blockId
  ],
  content: '', // 初始为空，由管理器加载
});

const manager = new PagedEditorManager(editor, 'your-doc-id');
await manager.init(1); // 从第一页开始
```

### 3. 目录跳转

```typescript
// 点击目录项
const handleTOCClick = (itemId: string) => {
  manager.scrollToHeading(itemId);
};
```

### 4. 清理

```typescript
useEffect(() => {
  return () => {
    manager.destroy(); // 先销毁管理器
    editor.destroy(); // 再销毁编辑器
  };
}, []);
```

## 关键配置

### 页面大小限制

```typescript
// 在 PagedEditorManager.ts 中
const PAGE_SIZE_LIMIT = 5000; // 每页约 5000 字
```

### 同时保持的页数

```typescript
const PAGES_TO_KEEP = 3; // 当前页 ± 1
```

## 数据结构

### 文档元数据

```typescript
interface DocumentMeta {
  docId: string;
  title: string;
  totalPages: number;
  pageSize: number;
  lastModified: number;
}
```

### 页面内容

```typescript
interface PageContent {
  docId: string;
  pageNum: number;
  content: string; // JSON 格式
  headings: HeadingInfo[];
  wordCount: number;
  lastModified: number;
}
```

### 目录索引

```typescript
interface TOCIndex {
  docId: string;
  items: TOCItem[];
  lastModified: number;
}

interface TOCItem {
  id: string;
  text: string;
  level: number;
  pageNum: number; // 所在页码
  posInPage: number; // 在该页中的位置
}
```

## 工作流程

### 初始化流程

1. 加载文档元数据（总页数等）
2. 加载目录索引（完整的）
3. 加载初始页面（当前页 ± 1）
4. 设置滚动监听
5. 监听编辑器变化

### 滚动流程

1. 监听滚动事件（RAF 节流）
2. 计算当前可见页码
3. 加载缺失的页面（当前页 ± 1）
4. 卸载远离的页面（保存后删除）

### 保存流程

1. 编辑时标记当前页为脏
2. 2秒后自动保存
3. 提取页面内容和标题
4. 保存到 IndexedDB
5. 更新目录索引

### 目录跳转流程

1. 从目录索引查找目标位置
2. 检查目标页是否已加载
3. 如果未加载，先加载目标页
4. 计算实际位置（考虑只加载了部分页）
5. 跳转并聚焦

## 注意事项

### ✅ 必须做到

1. **页面边界清晰**
   - 使用 PageBreak 节点标记
   - 每个页面必须有唯一的 pageNum

2. **目录独立存储**
   - 不依赖当前加载的文档
   - 编辑时同步更新

3. **脏页及时保存**
   - 卸载前强制保存
   - 防止数据丢失

4. **保留足够缓冲**
   - 始终保持当前页 ± 1 页
   - 避免频繁加载/卸载

5. **防止选区跨页卸载**
   - 检查选区范围
   - 如果选区与页面有交集，不能卸载

### ❌ 绝对不要做

1. **在页面中间编辑时卸载该页**
   → 会丢失用户输入

2. **频繁加载/卸载页面**
   → 性能差，用户体验差

3. **不保存就卸载脏页**
   → 数据丢失

4. **目录依赖当前 doc 遍历**
   → 只能看到已加载的标题

5. **跨页选区时卸载页面**
   → 选区会断裂

## 边界情况处理

### 跨页选区

```typescript
private canUnloadPage(pageNum: number): boolean {
  const { from, to } = this.editor.state.selection;
  const range = this.findPageRange(pageNum);

  if (!range) return false;

  // 如果选区与该页有交集，不能卸载
  if (from < range.to && to > range.from) {
    return false;
  }

  return true;
}
```

### 跨页编辑

当用户删除跨越页面边界的内容时：

1. 检测是否删除了 PageBreak 节点
2. 如果是，触发页面合并
3. 重新编号后续页面

### 页面溢出

当页面内容超过 PAGE_SIZE_LIMIT 时：

1. 检测字数
2. 触发页面分裂
3. 重新编号后续页面

## 性能指标

| 指标         | 目标值   | 说明                |
| ------------ | -------- | ------------------- |
| 同时加载页数 | 3-5 页   | 当前页 ± 1-2        |
| 每页字数     | ~5000 字 | 可配置              |
| 页面加载时间 | < 100ms  | 从 IndexedDB 读取   |
| 页面卸载时间 | < 50ms   | 包括保存时间        |
| 自动保存延迟 | 2 秒     | 防抖                |
| 内存占用     | < 50MB   | 3-5 页 + 编辑器状态 |

## 调试

### 开启调试模式

```typescript
// 在 PageBreak 节点上添加 data-debug 属性
<div data-page-break="true" data-debug="true" data-page-num="1" />
```

这会显示页面分隔线，方便调试。

### 查看存储数据

```javascript
// 打开浏览器控制台
const db = await window.indexedDB.open('PagedDocuments', 1);

// 查看所有页面
const tx = db.transaction(['pages'], 'readonly');
const pages = await tx.objectStore('pages').getAll();
console.log(pages);
```

### 查看目录索引

```javascript
const tocIndex = await pagedDocDB.getTOCIndex('your-doc-id');
console.log(tocIndex);
```

## 常见问题

### Q: 为什么编辑后立即滚动到其他页，内容会丢失？

A: 因为自动保存有 2 秒延迟。解决方案：

- 在卸载页面前强制保存脏页
- 或者缩短自动保存延迟

### Q: 目录点击后跳转不准确？

A: 检查：

1. 目标页是否已加载
2. posInPage 是否正确
3. 页面范围计算是否正确

### Q: 页面加载很慢？

A: 优化方向：

1. 减小页面大小（如改为 3000 字）
2. 使用 Web Worker 解析内容
3. 预加载相邻页面

### Q: 如何处理超大页面（如长代码块）？

A: 方案：

1. 将代码块视为原子单位，不拆分
2. 如果单个页面超过限制，允许例外
3. 或者使用更大的页面限制

## 完整示例

参考：`src/pages/editor/examples/paged-editor-usage.tsx`

## 总结

分页加载方案适用于 **10-50万字+** 的超大文档，通过：

- ✅ 独立的目录索引
- ✅ 动态页面加载/卸载
- ✅ 自动保存机制
- ✅ 边界检查保护

来实现稳定、高效的编辑体验。

**权衡**：实现复杂度换取内存占用的降低和性能的提升。

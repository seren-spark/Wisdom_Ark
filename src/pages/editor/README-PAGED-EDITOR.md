# 分页编辑器实现完成

## ✅ 已完成的工作

### 核心组件

1. **PageBreak 扩展** (`extensions/PageBreak.ts`)
   - 页面分隔标记节点
   - 不可见的原子节点
   - 携带页码信息

2. **存储层** (`storage/PagedDocStorage.ts`)
   - IndexedDB 数据库封装
   - 文档元数据管理
   - 页面内容存储
   - 目录索引存储

3. **目录索引管理器** (`managers/TOCIndexManager.ts`)
   - 独立的目录索引
   - 标题提取和更新
   - 跨页目录跳转支持

4. **分页编辑器管理器** (`managers/PagedEditorManager.ts`)
   - 页面动态加载/卸载
   - 滚动监听和页面切换
   - 自动保存脏页
   - 选区边界检查

5. **文档转换工具** (`utils/DocumentConverter.ts`)
   - 完整文档 → 分页格式
   - 分页格式 → 完整文档
   - 统计信息查询

### 支持文件

- **CSS 样式** (`styles/paged-editor.css`)
- **使用示例** (`examples/paged-editor-usage.tsx`)
- **完整文档** (`docs/paged-editor-guide.md`)

---

## 🚀 快速开始

### 1. 转换现有文档为分页格式

```typescript
import { DocumentConverter } from '@/pages/editor/utils/DocumentConverter';

// 将当前编辑器中的文档转换为分页格式
await DocumentConverter.convertToPagedDocument(
  editor, // 现有的 TipTap 编辑器实例
  'doc-001', // 文档 ID
  '我的文档', // 文档标题
  5000, // 每页字数（可选，默认 5000）
);
```

### 2. 使用分页编辑器

```typescript
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { PageBreak } from '@/pages/editor/extensions/PageBreak';
import { PagedEditorManager } from '@/pages/editor/managers/PagedEditorManager';
import '@/pages/editor/styles/paged-editor.css';

// 创建编辑器
const editor = new Editor({
  extensions: [
    StarterKit,
    PageBreak, // 必须添加
  ],
  content: '', // 初始为空
});

// 创建分页管理器
const manager = new PagedEditorManager(editor, 'doc-001');

// 初始化（加载第一页）
await manager.init(1);

// 清理
manager.destroy();
editor.destroy();
```

### 3. 目录跳转

```typescript
// 获取目录项
const tocItems = manager.tocManager.getItems();

// 跳转到指定标题
await manager.scrollToHeading(itemId);
```

---

## 📊 架构对比

### 当前 CSS 虚拟化（已有实现）

```
✅ 优点：
- 稳定可靠
- 编辑体验完美
- 实现简单

❌ 缺点：
- DOM 节点全部在内存（~2000 节点）
- 内存占用较高（~100MB）
- 上限约 10 万字
```

### 分页加载（新实现）

```
✅ 优点：
- 内存占用低（只保持 3-5 页）
- 真正的 DOM 卸载
- 支持无限长文档

❌ 缺点：
- 实现复杂
- 需要独立的目录索引
- 跨页操作需要特殊处理
```

---

## 🎯 使用场景建议

| 文档规模       | 推荐方案               |
| -------------- | ---------------------- |
| **< 10 万字**  | CSS 虚拟化（当前实现） |
| **10-50 万字** | **分页加载**（新实现） |
| **> 50 万字**  | 分页加载 + 服务端优化  |

---

## 📁 文件结构

```
src/pages/editor/
├── extensions/
│   ├── PageBreak.ts              # 页面分隔节点
│   └── VirtualScroll.ts          # CSS 虚拟化（现有）
├── storage/
│   └── PagedDocStorage.ts        # IndexedDB 存储
├── managers/
│   ├── TOCIndexManager.ts        # 目录索引管理
│   └── PagedEditorManager.ts     # 分页逻辑核心
├── utils/
│   └── DocumentConverter.ts      # 文档转换工具
├── styles/
│   └── paged-editor.css          # 样式
├── examples/
│   └── paged-editor-usage.tsx    # 使用示例
└── README-PAGED-EDITOR.md        # 本文档

docs/
└── paged-editor-guide.md         # 完整使用指南
```

---

## 🔧 配置选项

### 页面大小

```typescript
// 在 PagedEditorManager.ts 中
const PAGE_SIZE_LIMIT = 5000; // 每页约 5000 字
```

### 同时保持的页数

```typescript
// 在 PagedEditorManager.ts 中
const PAGES_TO_KEEP = 3; // 当前页 ± 1
```

### 自动保存延迟

```typescript
// 在 scheduleAutoSave 方法中
this.autoSaveTimer = window.setTimeout(() => {
  this.autoSave();
}, 2000); // 2 秒
```

---

## ⚠️ 关键注意事项

### ✅ 必须做到

1. **页面边界清晰**：使用 PageBreak 节点标记
2. **目录独立存储**：不依赖当前加载的文档
3. **脏页及时保存**：卸载前强制保存
4. **保留足够缓冲**：始终保持当前页 ± 1 页
5. **防止选区跨页卸载**：检查选区范围

### ❌ 绝对不要做

1. **在编辑时卸载该页**：会丢失用户输入
2. **频繁加载/卸载**：性能差，体验差
3. **不保存就卸载脏页**：数据丢失
4. **目录依赖 doc 遍历**：只能看到已加载的标题
5. **跨页选区时卸载**：选区会断裂

---

## 🧪 测试步骤

### 1. 转换测试文档

```typescript
// 使用现有的大文档进行测试
import { DocumentConverter } from './utils/DocumentConverter';

await DocumentConverter.convertToPagedDocument(
  editor,
  'test-doc',
  '测试文档',
  3000, // 使用较小的页面便于测试
);
```

### 2. 查看转换结果

```typescript
const stats = await DocumentConverter.getDocumentStats('test-doc');
console.log(stats);
// 输出：{ totalPages: 5, totalWords: 15000, totalHeadings: 20, ... }
```

### 3. 测试分页编辑器

```typescript
const pagedEditor = new Editor({
  extensions: [StarterKit, PageBreak],
});

const manager = new PagedEditorManager(pagedEditor, 'test-doc');
await manager.init(1);

// 滚动测试页面加载/卸载
// 编辑测试自动保存
// 目录跳转测试
```

---

## 🐛 调试

### 查看控制台日志

所有组件都包含详细的 console.log：

- `[PagedEditor]` - 管理器日志
- `[DocumentConverter]` - 转换日志
- `[TOCIndexManager]` - 目录日志

### 查看 IndexedDB 数据

1. 打开浏览器开发者工具
2. Application → Storage → IndexedDB
3. 找到 `PagedDocuments` 数据库
4. 查看 `documents`、`pages`、`tocIndexes` 表

### 开启调试模式

在 PageBreak 节点上添加 `data-debug="true"` 属性会显示页面分隔线。

---

## 📖 完整文档

详细的使用指南、API 文档和边界情况处理请查看：
**`docs/paged-editor-guide.md`**

---

## 🎉 总结

分页编辑器方案已经**完全实现**，包括：

- ✅ 所有核心组件
- ✅ 存储层和数据模型
- ✅ 文档转换工具
- ✅ 使用示例和完整文档

**适用场景**：10-50 万字的超大文档

**下一步**：

1. 在实际项目中测试
2. 根据反馈优化性能
3. 添加更多边界情况处理

如有问题，请查看 `docs/paged-editor-guide.md` 中的详细说明。

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Space, Tooltip } from 'antd';
import { CheckOutlined, CloseOutlined, EditOutlined } from '@ant-design/icons';
import AISuggestionBus, { type AISuggestion } from '@/utils/AISuggestionBus';
import { mockMarked } from '@/utils/mdRendering';
import marked from '@/utils/marked';
import './index.scss';

interface AISuggestionPreviewProps {
  editor: any;
}

export default React.memo(function AISuggestionPreview({
  editor,
}: AISuggestionPreviewProps) {
  const bus = useMemo(() => AISuggestionBus.getInstance(), []);
  const [suggestion, setSuggestion] = useState<AISuggestion | null>(null);
  const [editable, setEditable] = useState(false);
  const [draft, setDraft] = useState('');
  const [renderedHtml, setRenderedHtml] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    return bus.subscribe((s) => {
      setSuggestion(s);
      setEditable(false);
      setDraft(s?.text ?? '');

      // 自动渲染 Markdown
      if (s?.text) {
        mockMarked.parse(s.text).then((html) => {
          setRenderedHtml(html);
        });
      } else {
        setRenderedHtml('');
      }
    });
  }, [bus]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!suggestion) return;
      // Tab/Enter accept, Esc cancel
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        handleAccept();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        bus.clear();
      }
    };
    if (suggestion) {
      window.addEventListener('keydown', onKey, { capture: true });
    }
    return () =>
      window.removeEventListener('keydown', onKey, { capture: true } as any);
  }, [suggestion]);

  const handleAccept = () => {
    if (!suggestion) return;
    const textToInsert = editable ? draft : suggestion.text;

    // 🔥 将 Markdown 文本转换为 HTML，让 Tiptap 正确解析
    const htmlContent = String(marked.parse(textToInsert));

    if (
      suggestion.mode === 'insert' &&
      typeof suggestion.position === 'number'
    ) {
      editor
        .chain()
        .focus()
        .insertContentAt(suggestion.position, htmlContent)
        .run();
    } else if (suggestion.mode === 'replace' && suggestion.range) {
      editor
        .chain()
        .focus()
        .deleteRange({ from: suggestion.range.from, to: suggestion.range.to })
        .insertContentAt(suggestion.range.from, htmlContent)
        .run();
    } else if (suggestion.mode === 'replace_all') {
      editor.commands.setContent(htmlContent);
    }
    bus.clear();
  };

  if (!suggestion) return null;

  return (
    <div className="ai-suggestion-preview">
      <span className="ai-suggestion-preview__label">AI建议</span>
      {editable ? (
        <textarea
          ref={inputRef}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          className="ai-suggestion-preview__textarea"
        />
      ) : (
        <div
          className="ai-suggestion-preview__content"
          dangerouslySetInnerHTML={{ __html: renderedHtml }}
        />
      )}
      <Space>
        <Tooltip
          title={editable ? '保存并插入 (Enter/Tab)' : '插入 (Enter/Tab)'}
        >
          <Button
            type="primary"
            icon={<CheckOutlined />}
            onClick={handleAccept}
          />
        </Tooltip>
        <Tooltip title={editable ? '退出编辑' : '编辑建议'}>
          <Button
            icon={<EditOutlined />}
            onClick={() => setEditable((v) => !v)}
          />
        </Tooltip>
        <Tooltip title="取消 (Esc)">
          <Button danger icon={<CloseOutlined />} onClick={() => bus.clear()} />
        </Tooltip>
      </Space>
    </div>
  );
});

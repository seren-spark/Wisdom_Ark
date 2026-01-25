import React, { useState, useCallback } from 'react';
import {
  Button,
  Dropdown,
  Space,
  message,
  Modal,
  Input,
  Slider,
  Switch,
  Card,
  Statistic,
} from 'antd';
import {
  RobotOutlined,
  EditOutlined,
  ExpandOutlined,
  CheckCircleOutlined,
  LoadingOutlined,
  SettingOutlined,
  BarChartOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import { HybridFIMService } from '@/utils/hybridFIMService';
import AISuggestionBus from '@/utils/AISuggestionBus';
import { SmartPositionDetection } from '@/utils/smartPositionDetection';

interface AIEditorToolbarProps {
  editor: any;
}

export default function AIEditorToolbar({ editor }: AIEditorToolbarProps) {
  const [loading, setLoading] = useState(false);
  //   const [fimService] = useState(() => new HybridFIMService()); // 不需要传入API Key
  const [settings, setSettings] = useState({
    useRealFIM: true,
    fallbackOnError: true,
    maxTokens: 200,
    temperature: 0.7,
    topP: 0.9,
  });
  const [settingsModalVisible, setSettingsModalVisible] = useState(false);
  const [statsModalVisible, setStatsModalVisible] = useState(false);
  const [fimService] = useState(
    () =>
      new HybridFIMService(
        (import.meta.env.VITE_HUGGINGFACE_TOKEN as string) || '',
      ),
  );

  // 智能FIM补全
  const handleSmartFIM = useCallback(async () => {
    setLoading(true);
    try {
      const position = SmartPositionDetection.detectBestInsertionPoint(editor);
      const contextInfo = SmartPositionDetection.getContextInfo(
        editor,
        position,
      );

      const result = await fimService.fillInMiddle(
        contextInfo.prefix,
        contextInfo.suffix,
        {
          useRealFIM: settings.useRealFIM,
          fallbackOnError: settings.fallbackOnError,
          maxTokens: settings.maxTokens,
          temperature: settings.temperature,
          topP: settings.topP,
        },
      );
      console.log('result', result);

      // push suggestion instead of direct insert
      AISuggestionBus.getInstance().show({
        id: `${Date.now()}`,
        text: result,
        mode: 'insert',
        position,
      });
      message.success('已生成AI建议，按 Tab/Enter 确认，Esc 取消');
    } catch (error) {
      message.error('智能FIM补全失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [editor, fimService, settings]);

  // 智能改错
  const handleSmartCorrect = useCallback(async () => {
    setLoading(true);
    try {
      const fullText = editor.getText();
      const result = await fimService.correctText(fullText);
      AISuggestionBus.getInstance().show({
        id: `${Date.now()}`,
        text: result,
        mode: 'replace_all',
      });
      message.success('已生成改错建议，按 Tab/Enter 确认，Esc 取消');
    } catch (error) {
      message.error('智能改错失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [editor, fimService]);

  // 智能扩写
  const handleSmartExpand = useCallback(async () => {
    setLoading(true);
    try {
      const fullText = editor.getText();
      const result = await fimService.expandText(fullText);
      AISuggestionBus.getInstance().show({
        id: `${Date.now()}`,
        text: result,
        mode: 'replace_all',
      });
      message.success('已生成扩写建议，按 Tab/Enter 确认，Esc 取消');
      console.log('扩写result', result);
    } catch (error) {
      message.error('智能扩写失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [editor, fimService]);

  // 选中文本改错
  const handleSelectedCorrect = useCallback(async () => {
    const { from, to } = editor.state.selection;
    const selectedText = editor.state.doc.textBetween(from, to);
    if (!selectedText.trim()) {
      message.warning('请先选择要检查的内容');
      return;
    }
    setLoading(true);
    try {
      const result = await fimService.correctText(selectedText);
      AISuggestionBus.getInstance().show({
        id: `${Date.now()}`,
        text: result,
        mode: 'replace',
        range: { from, to },
      });
      message.success('已生成选中改错建议，按 Tab/Enter 确认，Esc 取消');
    } catch (error) {
      message.error('选中文本改错失败，请重试');
    } finally {
      setLoading(false);
    }
  }, [editor, fimService]);

  const menuItems = [
    {
      key: 'smart-fim',
      label: '智能FIM补全',
      icon: <ThunderboltOutlined />,
      onClick: handleSmartFIM,
    },
    {
      key: 'smart-correct',
      label: '智能改错',
      icon: <CheckCircleOutlined />,
      onClick: handleSmartCorrect,
    },
    {
      key: 'selected-correct',
      label: '选中改错',
      icon: <EditOutlined />,
      onClick: handleSelectedCorrect,
    },
    {
      key: 'smart-expand',
      label: '智能扩写',
      icon: <ExpandOutlined />,
      onClick: handleSmartExpand,
    },
    {
      key: 'settings',
      label: '设置',
      icon: <SettingOutlined />,
      onClick: () => setSettingsModalVisible(true),
    },
    {
      key: 'stats',
      label: '性能统计',
      icon: <BarChartOutlined />,
      onClick: () => setStatsModalVisible(true),
    },
  ];

  const stats = fimService.getPerformanceStats();

  return (
    <>
      <Dropdown
        menu={{ items: menuItems }}
        trigger={['click']}
        placement="bottomLeft"
      >
        <Button
          icon={loading ? <LoadingOutlined /> : <RobotOutlined />}
          loading={loading}
          type="text"
        >
          AI助手
        </Button>
      </Dropdown>

      {/* 设置模态框 */}
      <Modal
        title="AI助手设置"
        open={settingsModalVisible}
        onOk={() => setSettingsModalVisible(false)}
        onCancel={() => setSettingsModalVisible(false)}
        width={600}
      >
        <Card title="FIM模型设置" style={{ marginBottom: 16 }}>
          <div style={{ marginBottom: 16 }}>
            <label>使用真实FIM模型：</label>
            <Switch
              checked={settings.useRealFIM}
              onChange={(checked) =>
                setSettings((prev) => ({ ...prev, useRealFIM: checked }))
              }
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label>错误时降级：</label>
            <Switch
              checked={settings.fallbackOnError}
              onChange={(checked) =>
                setSettings((prev) => ({ ...prev, fallbackOnError: checked }))
              }
            />
          </div>
        </Card>

        <Card title="生成参数">
          <div style={{ marginBottom: 16 }}>
            <label>最大Token数：</label>
            <Slider
              min={50}
              max={500}
              value={settings.maxTokens}
              onChange={(value) =>
                setSettings((prev) => ({ ...prev, maxTokens: value }))
              }
              marks={{
                50: '50',
                200: '200',
                500: '500',
              }}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label>温度：</label>
            <Slider
              min={0.1}
              max={1.0}
              step={0.1}
              value={settings.temperature}
              onChange={(value) =>
                setSettings((prev) => ({ ...prev, temperature: value }))
              }
              marks={{
                0.1: '0.1',
                0.5: '0.5',
                1.0: '1.0',
              }}
            />
          </div>

          <div style={{ marginBottom: 16 }}>
            <label>Top-P：</label>
            <Slider
              min={0.1}
              max={1.0}
              step={0.1}
              value={settings.topP}
              onChange={(value) =>
                setSettings((prev) => ({ ...prev, topP: value }))
              }
              marks={{
                0.1: '0.1',
                0.5: '0.5',
                1.0: '1.0',
              }}
            />
          </div>
        </Card>
      </Modal>

      {/* 性能统计模态框 */}
      <Modal
        title="性能统计"
        open={statsModalVisible}
        onOk={() => setStatsModalVisible(false)}
        onCancel={() => setStatsModalVisible(false)}
        width={500}
      >
        <Card title="FIM模型统计">
          <Space direction="vertical" style={{ width: '100%' }}>
            <Statistic title="真实FIM调用次数" value={stats.realFIMCalls} />
            <Statistic
              title="真实FIM成功率"
              value={stats.realFIMSuccessRate}
              suffix="%"
            />
            <Statistic
              title="真实FIM平均时间"
              value={stats.averageRealFIMTime}
              suffix="ms"
            />
            <Statistic
              title="Prompt FIM调用次数"
              value={stats.promptFIMCalls}
            />
            <Statistic
              title="Prompt FIM成功率"
              value={stats.promptFIMSuccessRate}
              suffix="%"
            />
            <Statistic
              title="Prompt FIM平均时间"
              value={stats.averagePromptFIMTime}
              suffix="ms"
            />
          </Space>
        </Card>
      </Modal>
    </>
  );
}

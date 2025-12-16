import React, { useState, useRef } from 'react';
import {
  Upload,
  Button,
  Card,
  Progress,
  Space,
  Tag,
  Typography,
  List,
  Tooltip,
  message,
} from 'antd';
import {
  UploadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  DeleteOutlined,
  CheckCircleOutlined,
  CloseCircleOutlined,
  InboxOutlined,
  FileOutlined,
} from '@ant-design/icons';

import { checkFile, initFile, mergeChunks as mergeFile } from '@/api/file';

const { Title, Text } = Typography;
const { Dragger } = Upload;

interface UploadTask {
  file: File;
  md5: string;
  progress: number;
  speed?: number;
  status:
    | 'calculating'
    | 'waiting'
    | 'uploading'
    | 'paused'
    | 'success'
    | 'error';
  uploadedChunks: number[];
  totalChunks: number;
  chunkSize?: number;
  uploadUrls?: string[];
  error?: string;
  uploadedBytes: number;
  startTime?: number;
}

const ChunkedUploadComponent: React.FC = () => {
  const [tasks, setTasks] = useState<Map<string, UploadTask>>(new Map());
  const tasksRef = useRef(tasks);
  const abortControllersRef = useRef<Map<string, AbortController>>(new Map());
  const speedIntervalRef = useRef<Map<string, NodeJS.Timeout>>(new Map());
  const progressThrottleRef = useRef<Map<string, { ts: number; pct: number }>>(
    new Map(),
  );

  const CHUNK_SIZE = 5 * 1024 * 1024;
  const CONCURRENT_LIMIT = 6; // 并发上传数量

  const log = (step: string, data?: unknown) => {
    const timestamp = new Date().toLocaleTimeString();
    console.log(`[${timestamp}] ${step}`, data || '');
  };

  const isAbortError = (error: unknown): boolean =>
    typeof error === 'object' &&
    error !== null &&
    'name' in error &&
    (error as { name?: string }).name === 'AbortError';

  const getErrorMessage = (error: unknown, fallback = '上传失败'): string => {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    return fallback;
  };

  const calculateMD5 = (file: File): Promise<string> => {
    log('🔄 开始计算文件MD5(Worker)', {
      fileName: file.name,
      fileSize: file.size,
    });
    return new Promise((resolve, reject) => {
      const worker = new Worker(
        new URL('../../workers/md5Worker.ts', import.meta.url),
        { type: 'module' },
      );

      worker.onmessage = (e: MessageEvent) => {
        const { type, md5, progress, error } = (e.data || {}) as any;
        if (type === 'progress') {
          if (progress % 25 === 0 || progress === 100) {
            log(`📊 MD5进度: ${progress}%`, { fileName: file.name });
          }
        } else if (type === 'done') {
          log('✅ MD5计算完成', { md5, fileName: file.name });
          worker.terminate();
          resolve(md5 as string);
        } else if (type === 'error') {
          log('❌ MD5计算失败', { fileName: file.name, error });
          worker.terminate();
          reject(new Error((error as string) || 'MD5计算失败'));
        }
      };

      worker.onerror = (err) => {
        log('❌ MD5 Worker异常', err);
        worker.terminate();
        reject(new Error('MD5 Worker异常'));
      };

      worker.postMessage({ file, chunkSize: CHUNK_SIZE });
    });
  };

  const checkFileExists = async (md5: string): Promise<boolean> => {
    log('🔍 检查文件是否存在', { md5 });
    try {
      const resp = await checkFile(md5);
      const exists = resp?.code === 700;
      log(exists ? '✅ 文件已存在,秒传' : '📝 文件不存在,需要上传', {
        md5,
        code: resp?.code,
      });
      return exists;
    } catch (error) {
      log('📝 文件不存在或检查失败', { md5, error });
      return false;
    }
  };

  const initUpload = async (file: File, md5: string) => {
    log('🚀 调用后端初始化接口', {
      fileName: file.name,
      md5,
      fileSize: file.size,
      chunkSize: CHUNK_SIZE,
      totalChunks: Math.ceil(file.size / CHUNK_SIZE),
    });

    const requestBody = {
      originalName: file.name,
      md5: md5,
      chunkSize: CHUNK_SIZE,
      chunkNum: Math.ceil(file.size / CHUNK_SIZE),
      contentType: file.type || 'application/octet-stream',
    };

    log('📤 请求参数', requestBody);

    const resp = await initFile(requestBody);
    if (!resp || !(resp.code === 200 || resp.code >= 700)) {
      log('❌ 初始化失败', { code: resp?.code, message: resp?.message });
      throw new Error(resp?.message || '初始化上传失败');
    }
    const result = resp.data;
    log('✅ 后端初始化成功,返回数据:', result);

    return result;
  };

  const extractInitInfo = (
    payload: unknown,
  ): { uploadUrls: string[]; uploadedParts: number[]; chunkSize?: number } => {
    const uploadUrls: string[] = [];
    const uploadedParts: number[] = [];
    let chunkSize: number | undefined;
    if (payload && typeof payload === 'object') {
      const rec = payload as Record<string, any>;
      const urlKeys = [
        'uploadUrls',
        'urlList',
        'urls',
        'preSignedUrls',
        'preSignedUrlList',
        'presignedUrls',
        'presignedUrlList',
        'uploadUrlList',
      ];
      for (const k of urlKeys) {
        const v = rec[k];
        if (Array.isArray(v)) {
          v.forEach((it: any) =>
            uploadUrls.push(
              typeof it === 'string' ? it : it?.url || it?.uploadUrl,
            ),
          );
          break;
        }
      }
      const partsKeys = ['uploadedParts', 'uploaded', 'uploaded_chunks'];
      for (const k of partsKeys) {
        const v = rec[k];
        if (Array.isArray(v)) {
          v.forEach((n: any) => {
            const idx = parseInt(n, 10);
            if (!Number.isNaN(idx)) uploadedParts.push(idx);
          });
          break;
        }
      }
      chunkSize = rec.chunkSize ?? rec.data?.chunkSize;
    }
    return { uploadUrls, uploadedParts, chunkSize };
  };

  const uploadChunk = async (
    file: File,
    chunkIndex: number,
    uploadUrl: string,
    signal: AbortSignal,
    md5: string,
    chunkSize: number,
  ): Promise<{ success: boolean; bytes: number }> => {
    const start = chunkIndex * chunkSize;
    const end = Math.min(start + chunkSize, file.size);
    const chunk = file.slice(start, end);
    const chunkBytes = chunk.size;

    void 0;

    try {
      const response = await fetch(uploadUrl, {
        method: 'PUT',
        body: chunk,
        signal,
        headers: {
          'Content-Type': 'application/octet-stream',
        },
      });

      if (response.ok) {
        return { success: true, bytes: chunkBytes };
      }

      const errorText = await response.text();
      log(`❌ 分片 ${chunkIndex + 1} 上传失败`, {
        status: response.status,
        statusText: response.statusText,
        error: errorText,
      });
      throw new Error(`分片 ${chunkIndex + 1} 上传失败`);
    } catch (error: unknown) {
      if (isAbortError(error)) {
        log(`⏸️ 分片 ${chunkIndex + 1} 上传被暂停`);
        return { success: false, bytes: 0 };
      }
      log(`❌ 分片 ${chunkIndex + 1} 上传异常`, error);
      throw error instanceof Error ? error : new Error(getErrorMessage(error));
    }
  };

  const mergeChunks = async (md5: string) => {
    log('🔗 调用后端合并接口', { md5 });

    const resp = await mergeFile(md5);
    if (!resp || !(resp.code === 200 || resp.code >= 700)) {
      log('❌ 合并失败', { code: resp?.code, message: resp?.message });
      throw new Error(resp?.message || '合并文件失败');
    }
    const result = resp.data;
    log('✅ 后端合并成功', result);
    return result;
  };

  const updateTask = (
    md5: string,
    updates: Partial<UploadTask> | ((task: UploadTask) => UploadTask),
  ) => {
    setTasks((prev) => {
      const newTasks = new Map(prev);
      const task = newTasks.get(md5);
      if (task) {
        const nextTask =
          typeof updates === 'function'
            ? updates(task)
            : { ...task, ...updates };
        newTasks.set(md5, nextTask);
      }
      tasksRef.current = newTasks;
      return newTasks;
    });
  };

  // 启动速度计算定时器
  const startSpeedCalculation = (md5: string) => {
    // 清除旧的定时器
    const oldInterval = speedIntervalRef.current.get(md5);
    if (oldInterval) {
      clearInterval(oldInterval);
    }

    let lastUploadedBytes = 0;
    let lastTime = Date.now();

    const interval = setInterval(() => {
      const task = tasksRef.current.get(md5);
      if (!task || task.status !== 'uploading') {
        clearInterval(interval);
        speedIntervalRef.current.delete(md5);
        return;
      }

      const now = Date.now();
      const timeDiff = (now - lastTime) / 1000; // 秒
      const bytesDiff = task.uploadedBytes - lastUploadedBytes;

      if (timeDiff > 0) {
        const speed = bytesDiff / (1024 * 1024) / timeDiff; // MB/s
        if (speed > 0 && isFinite(speed)) {
          updateTask(md5, { speed });
        }
      }

      lastUploadedBytes = task.uploadedBytes;
      lastTime = now;
    }, 1000);

    speedIntervalRef.current.set(md5, interval);
  };

  // 停止速度计算
  const stopSpeedCalculation = (md5: string) => {
    const interval = speedIntervalRef.current.get(md5);
    if (interval) {
      clearInterval(interval);
      speedIntervalRef.current.delete(md5);
    }
  };

  const performUpload = async (md5: string) => {
    const initialTask = tasksRef.current.get(md5);
    if (!initialTask) return;

    let uploadUrls = initialTask.uploadUrls ?? [];
    const uploadedChunkSet = new Set(initialTask.uploadedChunks);
    const abortController = new AbortController();
    abortControllersRef.current.set(md5, abortController);

    updateTask(md5, {
      status: 'uploading',
      startTime: Date.now(),
      uploadedBytes: initialTask.uploadedBytes || 0,
    });

    // 启动速度计算
    startSpeedCalculation(md5);

    try {
      log('========== 开始上传流程 ==========', {
        fileName: initialTask.file.name,
        md5,
      });

      log('步骤1: 检查文件是否已存在');
      const exists = await checkFileExists(md5);
      if (exists) {
        log('🎉 文件已存在,秒传成功!', { fileName: initialTask.file.name });
        message.success(`${initialTask.file.name} 秒传成功！`);
        updateTask(md5, { status: 'success', progress: 100 });
        stopSpeedCalculation(md5);
        return;
      }

      if (!uploadUrls.length) {
        log('步骤2: 调用后端初始化接口');
        const initResult = await initUpload(initialTask.file, md5);
        if (!initResult) {
          throw new Error('初始化上传失败,未获取到返回数据');
        }
        const {
          uploadUrls: urls,
          uploadedParts,
          chunkSize,
        } = extractInitInfo(initResult);
        if (chunkSize) {
          const total = Math.ceil(initialTask.file.size / chunkSize);
          updateTask(md5, { chunkSize, totalChunks: total });
        }
        if (uploadedParts && uploadedParts.length) {
          uploadedParts.forEach((p) => uploadedChunkSet.add(p));
        }
        uploadUrls = urls;
        if (!Array.isArray(uploadUrls) || uploadUrls.length === 0) {
          log('⚠️ 未获取到上传地址列表，尝试直接合并', { md5 });
          const mergeResult = await mergeChunks(md5);
          message.success(`${initialTask.file.name} 上传成功！`);
          updateTask(md5, { status: 'success', progress: 100 });
          log('🎉 直接合并成功（复用已上传分片）', { md5, mergeResult });
          stopSpeedCalculation(md5);
          return;
        }
        updateTask(md5, { uploadUrls });
      } else {
        log('♻️ 复用已有上传地址', { count: uploadUrls.length });
      }

      const partUrlMap = new Map<number, string>();
      uploadUrls.forEach((item, idx) => {
        const u =
          typeof item === 'string'
            ? item
            : (item as any)?.url || (item as any)?.uploadUrl;
        if (!u) return;
        let partIndex = idx;
        try {
          const parsed = new URL(u);
          const pn = parsed.searchParams.get('partNumber');
          if (pn) {
            const n = parseInt(pn, 10);
            if (!Number.isNaN(n) && n > 0) partIndex = n - 1;
          }
        } catch {
          // ignore parse error
        }
        partUrlMap.set(partIndex, u);
      });

      if (partUrlMap.size === 0) {
        log('❌ 未获取到上传地址列表', { md5 });
        throw new Error('未获取到上传地址列表');
      }

      const expectedChunks = Math.ceil(
        initialTask.file.size /
          (tasksRef.current.get(md5)?.chunkSize || CHUNK_SIZE),
      );
      if (uploadUrls.length !== expectedChunks) {
        log('⚠️ 上传URL数量与分片数不匹配', {
          urlCount: uploadUrls.length,
          chunkCount: expectedChunks,
        });
      }

      log('📋 获取到上传地址列表', {
        count: uploadUrls.length,
        mappedCount: partUrlMap.size,
      });

      // 并发上传实现
      log(`步骤3: 开始并发上传分片到MinIO (并发数: ${CONCURRENT_LIMIT})`);

      const effectiveChunkSize =
        tasksRef.current.get(md5)?.chunkSize || CHUNK_SIZE;
      const totalChunksLocal = Math.ceil(
        initialTask.file.size / effectiveChunkSize,
      );

      const pendingChunks: number[] = [];
      for (let i = 0; i < totalChunksLocal; i++) {
        if (!uploadedChunkSet.has(i)) {
          pendingChunks.push(i);
        }
      }

      log(`待上传分片: ${pendingChunks.length}/${totalChunksLocal}`);

      // 并发上传控制
      const uploadQueue = [...pendingChunks];
      const activeUploads = new Set<Promise<void>>();

      while (uploadQueue.length > 0 || activeUploads.size > 0) {
        // 检查是否被暂停
        if (abortController.signal.aborted) {
          log('⏸️ 用户暂停上传', { uploadedChunks: uploadedChunkSet.size });
          updateTask(md5, { status: 'paused' });
          stopSpeedCalculation(md5);
          return;
        }

        // 补充上传任务到并发限制
        while (
          uploadQueue.length > 0 &&
          activeUploads.size < CONCURRENT_LIMIT
        ) {
          const chunkIndex = uploadQueue.shift()!;
          const currentTask = tasksRef.current.get(md5);

          if (!currentTask) {
            log('⚠️ 未找到上传任务,终止上传', { md5 });
            stopSpeedCalculation(md5);
            return;
          }

          const uploadUrl =
            partUrlMap.get(chunkIndex) || uploadUrls[chunkIndex];
          if (!uploadUrl) {
            // 视为已上传（后端仅返回未上传分片的URL）
            uploadedChunkSet.add(chunkIndex);
            continue;
          }

          const uploadPromise = uploadChunk(
            currentTask.file,
            chunkIndex,
            uploadUrl,
            abortController.signal,
            md5,
            currentTask.chunkSize || CHUNK_SIZE,
          )
            .then(({ success, bytes }) => {
              if (success) {
                uploadedChunkSet.add(chunkIndex);

                const currentTask = tasksRef.current.get(md5);
                if (currentTask) {
                  const newUploadedBytes =
                    (currentTask.uploadedBytes || 0) + bytes;
                  const progress = Math.round(
                    (uploadedChunkSet.size / totalChunksLocal) * 100,
                  );
                  const now = performance.now();
                  const prev = progressThrottleRef.current.get(md5) || {
                    ts: 0,
                    pct: 0,
                  };
                  if (
                    progress === 100 ||
                    progress - prev.pct >= 5 ||
                    now - prev.ts >= 200
                  ) {
                    updateTask(md5, (task) => ({
                      ...task,
                      uploadedChunks: Array.from(uploadedChunkSet).sort(
                        (a, b) => a - b,
                      ),
                      progress,
                      uploadedBytes: newUploadedBytes,
                    }));
                    progressThrottleRef.current.set(md5, {
                      ts: now,
                      pct: progress,
                    });
                  }
                }
              }
            })
            .finally(() => {
              activeUploads.delete(uploadPromise);
            });

          activeUploads.add(uploadPromise);
        }

        // 等待任一上传完成
        if (activeUploads.size > 0) {
          await Promise.race(activeUploads);
        }
      }

      stopSpeedCalculation(md5);

      log('步骤4: 所有分片已上传到MinIO,调用后端合并接口');
      const mergeResult = await mergeChunks(md5);

      message.success(`${initialTask.file.name} 上传成功！`);
      updateTask(md5, { status: 'success', progress: 100, speed: 0 });
      log('🎉 文件上传成功!', {
        fileName: initialTask.file.name,
        md5,
        mergeResult,
      });
      log('========== 上传流程结束 ==========');
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error);
      const stack = error instanceof Error ? error.stack : undefined;
      log('❌ 上传流程出错', { error: errorMessage, stack });
      message.error(`上传失败: ${errorMessage}`);
      updateTask(md5, {
        status: 'error',
        error: errorMessage || '上传失败',
        speed: 0,
      });
      stopSpeedCalculation(md5);
    } finally {
      abortControllersRef.current.delete(md5);
      stopSpeedCalculation(md5);
    }
  };

  const handleFileSelect = async (file: File) => {
    try {
      log('========== 处理新文件 ==========', {
        fileName: file.name,
        fileSize: formatFileSize(file.size),
        fileType: file.type,
      });

      const md5 = await calculateMD5(file);
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

      const task: UploadTask = {
        file,
        md5,
        progress: 0,
        status: 'calculating',
        uploadedChunks: [],
        totalChunks,
        uploadedBytes: 0,
      };

      const nextTasks = new Map(tasksRef.current);
      nextTasks.set(md5, task);
      tasksRef.current = nextTasks;
      setTasks(nextTasks);
      log('📝 任务已创建', { md5, totalChunks });

      updateTask(md5, { status: 'waiting' });
      performUpload(md5);
    } catch (error: unknown) {
      const errorMessage = getErrorMessage(error, '处理文件失败');
      log('❌ 处理文件失败', { fileName: file.name, error: errorMessage });
      message.error(`处理文件失败: ${errorMessage}`);
    }
    return false;
  };

  const pauseUpload = (md5: string) => {
    log('⏸️ 暂停上传', { md5 });
    const controller = abortControllersRef.current.get(md5);
    if (controller) {
      controller.abort();
      abortControllersRef.current.delete(md5);
    }
    stopSpeedCalculation(md5);
    message.info('已暂停上传');
  };

  const resumeUpload = (md5: string) => {
    log('▶️ 恢复上传', { md5 });
    message.info('继续上传中...');
    performUpload(md5);
  };

  const removeTask = (md5: string) => {
    log('🗑️ 删除任务', { md5 });
    pauseUpload(md5);
    stopSpeedCalculation(md5);
    setTasks((prev) => {
      const newTasks = new Map(prev);
      newTasks.delete(md5);
      tasksRef.current = newTasks;
      return newTasks;
    });
  };

  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + ' KB';
    if (bytes < 1024 * 1024 * 1024)
      return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  };

  const formatSpeed = (mbps?: number): string => {
    if (!mbps || !isFinite(mbps) || mbps <= 0) return '-';
    return `${mbps.toFixed(2)} MB/s`;
  };

  const getStatusTag = (status: UploadTask['status']) => {
    const statusConfig = {
      calculating: { color: 'processing', text: '计算中' },
      waiting: { color: 'default', text: '等待中' },
      uploading: { color: 'processing', text: '上传中' },
      paused: { color: 'warning', text: '已暂停' },
      success: { color: 'success', text: '已完成' },
      error: { color: 'error', text: '失败' },
    };
    const config = statusConfig[status];
    return <Tag color={config.color}>{config.text}</Tag>;
  };

  const getProgressStatus = (status: UploadTask['status']) => {
    if (status === 'success') return 'success';
    if (status === 'error') return 'exception';
    return 'active';
  };

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px' }}>
      <Card>
        <Title level={2} style={{ marginBottom: 24 }}>
          <UploadOutlined /> 文件分片上传 (并发上传 x{CONCURRENT_LIMIT})
        </Title>

        <Dragger
          multiple
          showUploadList={false}
          beforeUpload={handleFileSelect}
          style={{ marginBottom: 24 }}
        >
          <p className="ant-upload-drag-icon">
            <InboxOutlined style={{ fontSize: 64, color: '#1890ff' }} />
          </p>
          <p className="ant-upload-text" style={{ fontSize: 18 }}>
            点击或拖拽文件到此区域上传
          </p>
          <p
            className="ant-upload-hint"
            style={{ fontSize: 14, color: '#999' }}
          >
            支持单个或批量上传，支持断点续传、秒传和{CONCURRENT_LIMIT}路并发上传
          </p>
        </Dragger>

        {tasks.size > 0 && (
          <div>
            <Title level={4} style={{ marginBottom: 16 }}>
              上传列表 ({tasks.size})
            </Title>
            <List
              dataSource={Array.from(tasks.values())}
              renderItem={(task) => (
                <Card size="small" style={{ marginBottom: 16 }} hoverable>
                  <Space
                    direction="vertical"
                    style={{ width: '100%' }}
                    size="middle"
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                      }}
                    >
                      <Space>
                        <FileOutlined
                          style={{ fontSize: 20, color: '#1890ff' }}
                        />
                        <div>
                          <Text strong style={{ fontSize: 15 }}>
                            {task.file.name}
                          </Text>
                          <br />
                          <Text type="secondary" style={{ fontSize: 13 }}>
                            {formatFileSize(task.file.size)} ·{' '}
                            {task.totalChunks} 个分片
                          </Text>
                        </div>
                      </Space>
                      <Space>
                        {getStatusTag(task.status)}
                        {task.status === 'uploading' && (
                          <Tooltip title="暂停">
                            <Button
                              type="text"
                              icon={<PauseCircleOutlined />}
                              onClick={() => pauseUpload(task.md5)}
                            />
                          </Tooltip>
                        )}
                        {task.status === 'paused' && (
                          <Tooltip title="继续">
                            <Button
                              type="text"
                              icon={<PlayCircleOutlined />}
                              onClick={() => resumeUpload(task.md5)}
                              style={{ color: '#52c41a' }}
                            />
                          </Tooltip>
                        )}
                        {task.status === 'success' && (
                          <CheckCircleOutlined
                            style={{ fontSize: 20, color: '#52c41a' }}
                          />
                        )}
                        {task.status === 'error' && (
                          <Tooltip title={task.error}>
                            <CloseCircleOutlined
                              style={{ fontSize: 20, color: '#ff4d4f' }}
                            />
                          </Tooltip>
                        )}
                        <Tooltip title="删除">
                          <Button
                            type="text"
                            danger
                            icon={<DeleteOutlined />}
                            onClick={() => removeTask(task.md5)}
                          />
                        </Tooltip>
                      </Space>
                    </div>

                    <div>
                      <Progress
                        percent={task.progress}
                        status={getProgressStatus(task.status)}
                        strokeColor={{
                          '0%': '#108ee9',
                          '100%': '#87d068',
                        }}
                      />
                      <div
                        style={{
                          display: 'flex',
                          justifyContent: 'space-between',
                          marginTop: 4,
                        }}
                      >
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          {task.status === 'calculating' &&
                            '正在计算文件MD5...'}
                          {task.status === 'waiting' && '等待上传...'}
                          {task.status === 'uploading' &&
                            `上传中 ${task.progress}%`}
                          {task.status === 'paused' &&
                            `已暂停 ${task.progress}%`}
                          {task.status === 'success' && '上传完成'}
                          {task.status === 'error' && `上传失败: ${task.error}`}
                        </Text>
                        <Text type="secondary" style={{ fontSize: 12 }}>
                          下载速度: {formatSpeed(task.speed)}
                        </Text>
                      </div>
                    </div>
                  </Space>
                </Card>
              )}
            />
          </div>
        )}
      </Card>
    </div>
  );
};

export default ChunkedUploadComponent;

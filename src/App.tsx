import React, { useState } from 'react';
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import type { DragEndEvent } from '@dnd-kit/core';
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  horizontalListSortingStrategy,
  useSortable,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  Play, Pause, Plus, Trash2, FolderPlus, Download,
  Settings, Type, Film, Zap, Clock, FolderOpen, Music2,
  Layers, Archive, ChevronDown, ChevronRight, X, Copy, Image as ImageIcon
} from 'lucide-react';
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { set as idbSet, get as idbGet, del as idbDel } from 'idb-keyval';

import coreURL from '@ffmpeg/core?url';
import wasmURL from '@ffmpeg/core/wasm?url';

// ==========================================
// Types & Store
// ==========================================

export type VideoFile = {
  id: string;
  file: File;
  name: string;
  url: string;      // Blob URL
  thumbnail: string | null; // DataURL
  duration: number; // 秒数
};

export type MaterialPool = {
  id: string;
  name: string;
  files: VideoFile[];
};

export type TimelineSegment = {
  id: string;
  poolId: string;
  duration: number; // in seconds
};

export type BgmFile = {
  id: string;
  file: File;
  name: string;
  url: string; // Blob URL
};

export type BgmSettings = {
  files: BgmFile[];
  bgmVolume: number;   // 0-1
  videoVolume: number; // 0-1
};

export type TextStyle = {
  fontFamily: string;
  fontSize: number;
  color: string;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  shadowDistance: number;
  shadowAngle: number;
};

export type TextElement = {
  id: string;
  text: string;
  pos: { x: number; y: number };
  style: TextStyle;
};

export type ImageElement = {
  id: string;
  file: File;
  url: string; // ObjectURL for preview
  pos: { x: number; y: number };
  scale: number;
};

export type GlobalSettings = {
  texts: TextElement[];
  images: ImageElement[];
  antiDupConfig: {
    enabled: boolean;
    intensity: 'light' | 'medium' | 'heavy';
  };
};

export type ExportStatus = 'idle' | 'processing' | 'done' | 'error';

export type ExportTask = {
  id: string;
  status: ExportStatus;
  progress: number;
  resultUrl: string | null;
  createdAt: string;      // 格式如 "20260222_230809"
  errorMessage?: string;
};

interface MatrixStore {
  pools: MaterialPool[];
  timeline: TimelineSegment[];
  settings: GlobalSettings;
  bgm: BgmSettings;
  exports: ExportTask[];
  ffmpegStatus: 'idle' | 'loading' | 'ready' | 'error';

  // Fonts
  customFonts: { name: string; url: string }[];
  addCustomFont: (name: string, url: string) => void;

  // Actions
  addPool: () => void;
  removePool: (id: string) => void;
  updatePoolName: (id: string, name: string) => void;
  addFilesToPool: (poolId: string, files: VideoFile[]) => void;
  removeFileFromPool: (poolId: string, fileId: string) => void;
  clearPool: (poolId: string) => void;
  updateFileThumbnail: (poolId: string, fileId: string, thumbnail: string, duration: number) => void;

  addTimelineSegment: (poolId: string, duration?: number) => void;
  updateTimelineSegment: (segId: string, updates: Partial<TimelineSegment>) => void;
  removeTimelineSegment: (segId: string) => void;
  duplicateTimelineSegment: (segId: string) => void;
  reorderTimelineSegments: (oldIndex: number, newIndex: number) => void;

  updateSettings: (updates: Partial<GlobalSettings>) => void;
  addTextElement: () => void;
  removeTextElement: (id: string) => void;
  updateTextElement: (id: string, updates: Partial<TextElement>) => void;

  addImageElement: (file: File) => void;
  removeImageElement: (id: string) => void;
  updateImageElement: (id: string, updates: Partial<ImageElement>) => void;

  updateBgm: (updates: Partial<BgmSettings>) => void;

  addExportTask: (task: ExportTask) => void;
  updateExportTask: (id: string, updates: Partial<ExportTask>) => void;
  setFfmpegStatus: (status: 'idle' | 'loading' | 'ready' | 'error') => void;
}

export const useStore = create<MatrixStore>((set) => ({
  pools: [
    { id: 'p1', name: '新建素材池_1', files: [] }
  ],
  timeline: [],
  bgm: { files: [], bgmVolume: 0.5, videoVolume: 1.0 },
  settings: {
    texts: [
      {
        id: 'default-text-' + Date.now(),
        text: '新字幕内容',
        pos: { x: 0, y: 0 },
        style: { fontFamily: 'SimHei, Heiti SC, sans-serif', fontSize: 32, color: '#ffffff', shadowColor: '#000000', shadowOpacity: 0.9, shadowBlur: 15, shadowDistance: 5, shadowAngle: -45 }
      }
    ],
    images: [],
    antiDupConfig: {
      enabled: false,
      intensity: 'light'
    }
  },
  customFonts: [],
  exports: [],
  ffmpegStatus: 'idle',

  addCustomFont: (name, url) => set((state) => ({
    customFonts: [...state.customFonts, { name, url }]
  })),

  addPool: () => set((state) => ({
    pools: [...state.pools, { id: uuidv4(), name: `新建素材池_${state.pools.length + 1}`, files: [] }]
  })),

  removePool: (id) => set((state) => ({
    pools: state.pools.filter(p => p.id !== id),
    timeline: state.timeline.filter(t => t.poolId !== id)
  })),

  updatePoolName: (id, name) => set((state) => ({
    pools: state.pools.map(p => p.id === id ? { ...p, name } : p)
  })),

  addFilesToPool: (poolId, newFiles) => set((state) => ({
    pools: state.pools.map(p => {
      if (p.id !== poolId) return p;
      // 去重：按文件名
      const existingNames = new Set(p.files.map(f => f.name));
      const filtered = newFiles.filter(f => !existingNames.has(f.name));
      return { ...p, files: [...p.files, ...filtered] };
    })
  })),

  removeFileFromPool: (poolId, fileId) => set((state) => ({
    pools: state.pools.map(p => p.id === poolId ? { ...p, files: p.files.filter(f => f.id !== fileId) } : p)
  })),

  clearPool: (poolId) => set((state) => ({
    pools: state.pools.map(p => p.id === poolId ? { ...p, files: [] } : p)
  })),

  updateFileThumbnail: (poolId, fileId, thumbnail, duration) => set((state) => ({
    pools: state.pools.map(p => p.id === poolId
      ? { ...p, files: p.files.map(f => f.id === fileId ? { ...f, thumbnail, duration } : f) }
      : p)
  })),

  addTimelineSegment: (poolId, customDuration) => set((state) => {
    let finalDuration = customDuration || 2.5;

    if (!customDuration) {
      const pool = state.pools.find(p => p.id === poolId);
      if (pool && pool.files.length > 0) {
        // 过滤出已经抽出 duration (>0) 的视频，取其最小值
        const validDurations = pool.files.map(f => f.duration).filter(d => d > 0);
        if (validDurations.length > 0) {
          finalDuration = Math.min(...validDurations);
        }
      }
    }

    return {
      timeline: [...state.timeline, { id: uuidv4(), poolId, duration: finalDuration }]
    };
  }),

  updateTimelineSegment: (segId, updates) => set((state) => ({
    timeline: state.timeline.map(t => t.id === segId ? { ...t, ...updates } : t)
  })),

  removeTimelineSegment: (segId) => set((state) => ({
    timeline: state.timeline.filter(t => t.id !== segId)
  })),

  duplicateTimelineSegment: (segId) => set((state) => {
    const targetIndex = state.timeline.findIndex(t => t.id === segId);
    if (targetIndex === -1) return state;
    const targetSegment = state.timeline[targetIndex];
    const newSegment = { ...targetSegment, id: uuidv4() };
    const newTimeline = [...state.timeline];
    newTimeline.splice(targetIndex + 1, 0, newSegment); // insert right after the target
    return { timeline: newTimeline };
  }),

  reorderTimelineSegments: (oldIndex, newIndex) => set((state) => ({
    timeline: arrayMove(state.timeline, oldIndex, newIndex)
  })),

  updateSettings: (updates) => set((state) => ({
    settings: { ...state.settings, ...updates }
  })),

  updateBgm: (updates) => set((state) => ({
    bgm: { ...state.bgm, ...updates }
  })),

  addExportTask: (task) => set((state) => ({
    exports: [task, ...state.exports] // prepend
  })),

  updateExportTask: (id, updates) => set((state) => ({
    exports: state.exports.map(t => t.id === id ? { ...t, ...updates } : t)
  })),

  setFfmpegStatus: (status) => set({ ffmpegStatus: status }),

  addTextElement: () => set((state) => ({
    settings: {
      ...state.settings,
      texts: [...state.settings.texts, {
        id: 'text-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
        text: '新字幕内容',
        pos: { x: 0, y: 0 },
        style: { fontFamily: 'SimHei, Heiti SC, sans-serif', fontSize: 32, color: '#ffffff', shadowColor: '#000000', shadowOpacity: 0.9, shadowBlur: 10, shadowDistance: 5, shadowAngle: -45 }
      }]
    }
  })),

  removeTextElement: (id) => set((state) => ({
    settings: {
      ...state.settings,
      texts: state.settings.texts.filter(t => t.id !== id)
    }
  })),

  updateTextElement: (id, updates) => set((state) => ({
    settings: {
      ...state.settings,
      texts: state.settings.texts.map(t => t.id === id ? { ...t, ...updates } : t)
    }
  })),

  addImageElement: (file) => set((state) => ({
    settings: {
      ...state.settings,
      images: [...state.settings.images, {
        id: 'img-' + Date.now().toString() + '-' + Math.random().toString(36).substr(2, 5),
        file,
        url: URL.createObjectURL(file),
        pos: { x: 0, y: 0 },
        scale: 1.0
      }]
    }
  })),

  removeImageElement: (id) => set((state) => ({
    settings: {
      ...state.settings,
      images: state.settings.images.filter(img => img.id !== id)
    }
  })),

  updateImageElement: (id, updates) => set((state) => ({
    settings: {
      ...state.settings,
      images: state.settings.images.map(img => img.id === id ? { ...img, ...updates } : img)
    }
  }))
}));

// ==========================================
// Tooling: FFmpeg & Extractors
// ==========================================

// FFmpeg 实例 (单例，防止重复加载)
let ffmpeg: FFmpeg | null = null;

const getFFmpeg = async () => {
  if (ffmpeg) return ffmpeg;
  const store = useStore.getState();
  store.setFfmpegStatus('loading');

  try {
    ffmpeg = new FFmpeg();

    // 使用本地 vite?url 引用和取消预构建，彻底实现秒速加载和防注入
    await ffmpeg.load({
      coreURL,
      wasmURL,
    });

    store.setFfmpegStatus('ready');
    return ffmpeg;
  } catch (error) {
    console.error("FFmpeg load error:", error);
    store.setFfmpegStatus('error');
    throw error;
  }
};


// 并发控制器（允许同时提取 maxConcurrent 个视频）
class Semaphore {
  private queue: (() => void)[] = [];
  private currentCount = 0;
  private maxConcurrent: number;

  constructor(maxConcurrent: number) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire() {
    return new Promise<void>(resolve => {
      if (this.currentCount < this.maxConcurrent) {
        this.currentCount++;
        resolve();
      } else {
        this.queue.push(resolve);
      }
    });
  }

  release() {
    this.currentCount--;
    if (this.queue.length > 0) {
      this.currentCount++;
      const next = this.queue.shift();
      next?.();
    }
  }
}

const thumbnailSemaphore = new Semaphore(4); // 最多 4 个视频同时抽帧

async function extractVideoThumbnail(url: string, seekTime = 0.5): Promise<{ thumbnail: string, duration: number }> {
  await thumbnailSemaphore.acquire();

  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.style.display = 'none';
    video.muted = true;
    video.playsInline = true;

    let duration = 0;

    video.onloadedmetadata = () => {
      duration = video.duration;
      const targetTime = Math.min(seekTime, duration / 2 || 0);
      // 避免 seek 超出范围
      if (duration > 0) {
        video.currentTime = targetTime;
      } else {
        video.currentTime = 0;
      }
    };

    video.onseeked = () => {
      try {
        const canvas = document.createElement('canvas');
        canvas.width = video.videoWidth || 640;
        canvas.height = video.videoHeight || 360;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          const dataUrl = canvas.toDataURL('image/jpeg', 0.8);
          resolve({ thumbnail: dataUrl, duration });
        } else {
          reject(new Error("Canvas context failed"));
        }
      } catch (err) {
        reject(err);
      } finally {
        // 清理
        video.onloadedmetadata = null;
        video.onseeked = null;
        video.onerror = null;
        thumbnailSemaphore.release();
      }
    };

    video.onerror = (e) => {
      video.onloadedmetadata = null;
      video.onseeked = null;
      video.onerror = null;
      thumbnailSemaphore.release();
      reject(new Error("Video load error " + e));
    };

    video.src = url;
    video.load();
  });
}

// 颜色分配器，用于给不同的 pool 分配固定的强调色
const POOL_COLORS = [
  'red', 'blue', 'emerald', 'orange', 'purple', 'cyan', 'pink', 'indigo'
];
const getPoolColor = (index: number) => POOL_COLORS[index % POOL_COLORS.length];

// ==========================================
// UI Components
// ==========================================

const GlassPanel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = '' }) => (
  <div className={`bg-white/5 backdrop-blur-xl border border-white/10 ${className}`}>
    {children}
  </div>
);

// ==========================================
// Main Compiler & Exporter
// ==========================================

// 全局导出取消信号（由 Header 中的停止按鈕调用）
let exportCancelSignal = false;
export const cancelExport = () => { exportCancelSignal = true; };

export const performExport = async (store: MatrixStore, quantity: number = 1) => {
  exportCancelSignal = false; // 每次开始导出重置状态
  const { timeline, addExportTask, updateExportTask } = store;

  if (timeline.length === 0) {
    alert("时间轴为空，无法导出！");
    return;
  }

  // 硬件并发量 - 1 留给主 UI 线程，最小为 1，最大限制在 4 防爆内存
  const maxWorkers = navigator.hardwareConcurrency
    ? Math.max(1, Math.min(navigator.hardwareConcurrency - 1, 4))
    : 2;

  console.log(`Starting export pool with max concurrency: ${maxWorkers}`);

  const taskQueue: string[] = [];

  // 前期初始化所有任务 ID 并压入 UI 列表
  for (let q = 0; q < quantity; q++) {
    const taskId = uuidv4();
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const createdAt = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}_${pad(q)}`;
    addExportTask({
      id: taskId,
      status: 'idle', // 初始状态为 idle 等待入池
      progress: 0,
      resultUrl: null,
      createdAt,
    });
    taskQueue.push(taskId);
  }

  // 消费队列并发控制逻辑
  let runningWorkers = 0;
  let currentIndex = 0;

  return new Promise<void>((resolve) => {
    const runNext = async () => {
      if (exportCancelSignal) {
        // Mark remaining tasks as error due to cancellation
        while (currentIndex < taskQueue.length) {
          updateExportTask(taskQueue[currentIndex++], { status: 'error', errorMessage: 'Export cancelled' });
        }
      }

      if (currentIndex >= taskQueue.length) {
        if (runningWorkers === 0) resolve();
        return;
      }

      if (runningWorkers >= maxWorkers) return;

      const idx = currentIndex++;
      runningWorkers++;
      const taskId = taskQueue[idx];

      try {
        await runSingleFfmpegTask(taskId, store);
      } catch (err: any) {
        console.error(`Task ${taskId} execution failed`, err);
      } finally {
        runningWorkers--;
        runNext(); // trigger the next worker slot
      }
    };

    // Kick off initial workers
    for (let i = 0; i < maxWorkers; i++) {
      runNext();
    }
  });
};

const runSingleFfmpegTask = async (taskId: string, store: MatrixStore) => {
  const { pools, timeline, bgm, settings, updateExportTask } = store;

  updateExportTask(taskId, { status: 'processing', progress: 0 });

  const totalExportDuration = timeline.reduce((acc, seg) => acc + seg.duration, 0);

  const ff = new FFmpeg();

  try {
    await ff.load({ coreURL, wasmURL });

    // 监听独立实例的 progress //
    ff.on('log', ({ message }) => {
      const timeMatch = message.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d{2})/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const minutes = parseInt(timeMatch[2], 10);
        const seconds = parseFloat(timeMatch[3]);
        const currentSeconds = hours * 3600 + minutes * 60 + seconds;
        let progress = currentSeconds / totalExportDuration;
        updateExportTask(taskId, { progress: Math.min(Math.max(progress, 0), 0.99) });
      }
    });

    ff.on('progress', ({ progress }) => {
      if (progress > 0) {
        updateExportTask(taskId, { progress: Math.min(Math.max(progress, 0), 0.99) });
      }
    });

    // 2. 解析 Timeline，准备选材 (The Compiler)
    const inputs: { filename: string; file: File; duration: number }[] = [];

    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const pool = pools.find(p => p.id === seg.poolId);
      if (!pool || pool.files.length === 0) {
        throw new Error(`轨道第 ${i + 1} 段 (所属池: ${pool?.name || seg.poolId}) 中没有可用素材！`);
      }

      // 此处为简化，随机从该池内抽取一个视频
      const randFile = pool.files[Math.floor(Math.random() * pool.files.length)];

      const inputName = `input_${i}_${randFile.name.replace(/[^a-zA-Z0-9.]/g, '')}`; // 规范化文件名用于 ffmpeg
      inputs.push({
        filename: inputName,
        file: randFile.file,
        duration: seg.duration
      });
    }

    // 3. 写入内存文件系统 (MEMFS)
    for (const input of inputs) {
      await ff.writeFile(input.filename, await fetchFile(input.file));
    }


    // 4. 构建 filter_complex 指令
    // 我们需要把每段切片，缩放/裁剪并重新校准时间戳
    let filterComplex = '';
    const outSpecs: string[] = [];

    // 判断是否启用了 BGM
    const hasBgm = bgm.files.length > 0;
    // 随机选取一首 BGM
    let bgmFilename = '';
    if (hasBgm) {
      const bgmFile = bgm.files[Math.floor(Math.random() * bgm.files.length)];
      bgmFilename = `bgm_${bgmFile.name.replace(/[^a-zA-Z0-9.]/g, '')}`;
      await ff.writeFile(bgmFilename, await fetchFile(bgmFile.file));
    }

    const bgmInputIndex = inputs.length; // BGM input 的 index（最后一个）

    inputs.forEach((input, index) => {
      let vFilter = `[${index}:v]trim=0:${input.duration},setpts=PTS-STARTPTS`;
      let aFilter = `[${index}:a]atrim=0:${input.duration},asetpts=PTS-STARTPTS,volume=${bgm.videoVolume}`;

      if (settings.antiDupConfig?.enabled) {
        const intensity = settings.antiDupConfig.intensity;

        // --- Light: Color Shift ---
        const c = (1 + (Math.random() * 0.04 - 0.02)).toFixed(3); // 0.98~1.02
        const b = (Math.random() * 0.04 - 0.02).toFixed(3);       // -0.02~0.02
        const s = (1 + (Math.random() * 0.04 - 0.02)).toFixed(3); // 0.98~1.02
        vFilter += `,eq=contrast=${c}:brightness=${b}:saturation=${s}`;

        // --- Medium: Micro Zoom & Pan ---
        if (intensity === 'medium' || intensity === 'heavy') {
          const zoom = 1.015; // 1.5% zoom
          const randX = Math.random().toFixed(3);
          const randY = Math.random().toFixed(3);
          vFilter += `,scale=${zoom}*iw:${zoom}*ih,crop=iw/${zoom}:ih/${zoom}:x='${randX}*(iw-ow)':y='${randY}*(ih-oh)'`;
        }

        // --- Heavy: Tempo & Pitch Shift ---
        if (intensity === 'heavy') {
          const speed = (1 + (Math.random() * 0.04 - 0.02)).toFixed(3); // 0.98~1.02
          vFilter += `,setpts=PTS/${speed}`;
          aFilter += `,atempo=${speed}`;
        }
      }

      // Apply final scaling and padding to all videos uniformly
      vFilter += `,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[v${index}]; `;
      aFilter += `[a${index}]; `;

      filterComplex += vFilter + aFilter;
      outSpecs.push(`[v${index}][a${index}]`);
    });

    // 拼接最终连片: concat 所有视频+音频
    filterComplex += `${outSpecs.join('')}concat=n=${inputs.length}:v=1:a=1[outv_concat][outa_raw]; `;

    // ── Canvas 文字叠加（取代 drawtext，100% 兼容中文和特殊字符）──
    const OW = 1080, OH = 1920;
    const scaleM = OH / 600;
    let titleOverlayFilename = '';
    const hasAnyTitle = settings.texts && settings.texts.length > 0 && settings.texts.some(t => t.text.trim() !== '');

    if (hasAnyTitle) {
      const cvs = document.createElement('canvas');
      cvs.width = OW; cvs.height = OH;
      const ctx = cvs.getContext('2d')!;
      ctx.clearRect(0, 0, OW, OH);

      const drawCanvasText = (text: string, style: TextStyle, pos: { x: number; y: number }) => {
        if (!text || !text.trim()) return;
        ctx.save();
        const sr = parseInt(style.shadowColor.slice(1, 3), 16);
        const sg = parseInt(style.shadowColor.slice(3, 5), 16);
        const sb = parseInt(style.shadowColor.slice(5, 7), 16);
        ctx.shadowColor = `rgba(${sr},${sg},${sb},${style.shadowOpacity})`;
        ctx.shadowBlur = style.shadowBlur * scaleM;
        ctx.shadowOffsetX = style.shadowDistance * Math.cos(style.shadowAngle * Math.PI / 180) * scaleM;
        ctx.shadowOffsetY = style.shadowDistance * -Math.sin(style.shadowAngle * Math.PI / 180) * scaleM;
        ctx.font = `bold ${Math.round(style.fontSize * scaleM)}px "${style.fontFamily}"`;
        ctx.fillStyle = style.color;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, OW / 2 + pos.x * scaleM, OH / 2 + pos.y * scaleM);
        ctx.restore();
      };

      settings.texts.forEach(t => {
        drawCanvasText(t.text, t.style, t.pos);
      });

      const pngBytes = await new Promise<Uint8Array>((resolve) => {
        cvs.toBlob(async (blob) => {
          if (!blob) { resolve(new Uint8Array()); return; }
          resolve(new Uint8Array(await blob.arrayBuffer()));
        }, 'image/png');
      });

      if (pngBytes.length > 0) {
        titleOverlayFilename = 'title_overlay.png';
        await ff.writeFile(titleOverlayFilename, pngBytes);
        const overlayIdx = inputs.length + (hasBgm ? 1 : 0);
        filterComplex += `[outv_concat][${overlayIdx}:v]overlay=0:0[outv_texts]; `;
      } else {
        filterComplex += `[outv_concat]copy[outv_texts]; `;
      }
    } else {
      filterComplex += `[outv_concat]copy[outv_texts]; `;
    }

    // ── 图片贴纸叠加 ──
    const imageFilenames: string[] = [];
    const hasImages = settings.images && settings.images.length > 0;

    if (hasImages) {
      let lastImageOut = 'outv_texts';
      for (let i = 0; i < settings.images.length; i++) {
        const imgElem = settings.images[i];
        const imgExt = imgElem.file.name.split('.').pop() || 'png';
        const imgName = `custom_img_${i}.${imgExt}`;
        await ff.writeFile(imgName, await fetchFile(imgElem.file));
        imageFilenames.push(imgName);

        const imgInputIdx = inputs.length + (hasBgm ? 1 : 0) + (titleOverlayFilename ? 1 : 0) + i;
        const nextOut = i === settings.images.length - 1 ? 'outv' : `outv_img_${i}`;

        // x=W/2 + pos.x - w/2  => 将锚点置于贴图中心，并支持 scale
        filterComplex += `[${imgInputIdx}:v]scale=iw*${imgElem.scale}:ih*${imgElem.scale}[scaled_img_${i}]; `;
        filterComplex += `[${lastImageOut}][scaled_img_${i}]overlay=(W-w)/2+${imgElem.pos.x * scaleM}:(H-h)/2+${imgElem.pos.y * scaleM}[${nextOut}]; `;
        lastImageOut = nextOut;
      }
    } else {
      filterComplex += `[outv_texts]copy[outv]; `;
    }

    if (hasBgm) {
      // BGM 裁剪到总时长 + 调节音量
      filterComplex += `[${bgmInputIndex}:a]atrim=0:${totalExportDuration},asetpts=PTS-STARTPTS,volume=${bgm.bgmVolume}[bgm_trimmed]; `;
      // amix 混合原音频和 BGM
      filterComplex += `[outa_raw][bgm_trimmed]amix=inputs=2:duration=first:dropout_transition=0[outa]`;
    } else {
      // 无 BGM 直接重命名
      filterComplex += `[outa_raw]acopy[outa]`;
    }

    // 组装 -i 参数 (视频 + BGM + 文字叠层 + 图片叠层)
    const ffmpegArgs: string[] = [];
    inputs.forEach(i => { ffmpegArgs.push('-i', i.filename); });
    if (hasBgm) ffmpegArgs.push('-i', bgmFilename);
    if (titleOverlayFilename) ffmpegArgs.push('-i', titleOverlayFilename);
    imageFilenames.forEach(img => { ffmpegArgs.push('-i', img); });

    if (settings.antiDupConfig?.enabled) {
      ffmpegArgs.push('-map_metadata', '-1'); // Strip all metadata
    }

    ffmpegArgs.push('-filter_complex', filterComplex);
    ffmpegArgs.push('-map', '[outv]');
    ffmpegArgs.push('-map', '[outa]');
    ffmpegArgs.push('-c:v', 'libx264');
    ffmpegArgs.push('-c:a', 'aac');
    ffmpegArgs.push('-preset', 'ultrafast');
    ffmpegArgs.push('-pix_fmt', 'yuv420p');
    ffmpegArgs.push('output.mp4');

    console.log("Executing FFmpeg with args:", ffmpegArgs);

    const retCode = await ff.exec(ffmpegArgs);
    if (retCode !== 0) throw new Error(`FFmpeg 执行失败，退出码: ${retCode}`);

    const outputData = await ff.readFile('output.mp4');
    const blob = new Blob([outputData as any], { type: 'video/mp4' });
    const resultUrl = URL.createObjectURL(blob);

    await ff.deleteFile('output.mp4');
    for (const input of inputs) { await ff.deleteFile(input.filename); }
    if (hasBgm && bgmFilename) { await ff.deleteFile(bgmFilename); }
    if (titleOverlayFilename) { try { await ff.deleteFile(titleOverlayFilename); } catch (_) { } }
    for (const imgName of imageFilenames) { try { await ff.deleteFile(imgName); } catch (_) { } }

    updateExportTask(taskId, {
      status: 'done',
      progress: 1,
      resultUrl
    });

  } catch (err: any) {
    if (exportCancelSignal) {
      updateExportTask(taskId, { status: 'error', errorMessage: '已手动取消任务' });
    } else {
      console.error(`Task ${taskId} FFmpeg Export Error:`, err);
      updateExportTask(taskId, {
        status: 'error',
        errorMessage: err.message || '导出视频时发生未知错误',
      });
    }
  } finally {
    // ✅ 关键清理：直接释放独立实例底层 Worker 内容内存
  }
};

// -------------------------
// BGM 音乐池面板 (BGM Panel)
// -------------------------
const BgmPanel = () => {
  const { bgm, updateBgm } = useStore();

  const handleBgmImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;
    const validFiles = Array.from(files).filter(f =>
      f.type.startsWith('audio/') ||
      /\.(mp3|m4a|aac|wav|ogg|flac)$/i.test(f.name)
    );
    if (validFiles.length === 0) return;

    const newBgmFiles: BgmFile[] = validFiles.map(f => ({
      id: uuidv4(),
      file: f,
      name: f.name,
      url: URL.createObjectURL(f)
    }));
    const existingNames = new Set(bgm.files.map(f => f.name));
    const filtered = newBgmFiles.filter(f => !existingNames.has(f.name));
    updateBgm({ files: [...bgm.files, ...filtered] });
    // 清空输入元素以支持重复导入
    e.target.value = '';
  };

  return (
    <div className="border-t border-white/5 mt-2 pt-3 space-y-3">
      <div className="flex items-center justify-between px-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-white/50">
          <Music2 className="w-3.5 h-3.5 text-purple-400" />
          BGM 音乐池
        </div>
        <label className="cursor-pointer flex items-center gap-1 text-[10px] text-purple-400 hover:text-purple-300 bg-purple-500/10 px-2 py-1 rounded border border-purple-500/20 hover:border-purple-400/40 transition">
          <Plus className="w-3 h-3" />
          导入音乐
          <input type="file" className="hidden" accept="audio/*,.mp3,.m4a,.aac,.wav" multiple // @ts-ignore
            // @ts-ignore
            webkitdirectory="true" directory="true" onChange={handleBgmImport} />
        </label>
      </div>

      {bgm.files.length === 0 ? (
        <label className="flex flex-col items-center justify-center gap-2 py-4 border border-dashed border-purple-500/20 rounded-lg text-white/30 text-[11px] cursor-pointer hover:border-purple-500/40 hover:text-white/50 transition">
          <Music2 className="w-5 h-5 text-purple-500/40" />
          点击或选择文件夹导入 MP3 / WAV 音乐
          <input type="file" className="hidden" accept="audio/*,.mp3,.m4a,.aac,.wav" multiple
            // @ts-ignore
            webkitdirectory="true" directory="true" onChange={handleBgmImport} />
        </label>
      ) : (
        <div className="space-y-1 max-h-32 overflow-y-auto pr-1">
          {bgm.files.map(f => (
            <div key={f.id} className="flex items-center gap-2 px-2 py-1.5 rounded bg-purple-500/10 border border-purple-500/10 group">
              <Music2 className="w-3 h-3 text-purple-400 shrink-0" />
              <span className="flex-1 text-[10px] text-white/60 truncate">{f.name}</span>
              <button
                onClick={() => updateBgm({ files: bgm.files.filter(x => x.id !== f.id) })}
                className="opacity-0 group-hover:opacity-100 transition text-red-400/60 hover:text-red-400"
              ><X className="w-3 h-3" /></button>
            </div>
          ))}
        </div>
      )}

      {/* 音量控制 */}
      <div className="space-y-2 px-1">
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/40 w-16 shrink-0">原音声音</span>
          <input
            type="range" min="0" max="1" step="0.05"
            value={bgm.videoVolume}
            onChange={e => updateBgm({ videoVolume: parseFloat(e.target.value) })}
            className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-white/50"
          />
          <span className="text-[10px] text-white/40 w-8 text-right">{Math.round(bgm.videoVolume * 100)}%</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-purple-400 w-16 shrink-0">BGM 音量</span>
          <input
            type="range" min="0" max="1" step="0.05"
            value={bgm.bgmVolume}
            onChange={e => updateBgm({ bgmVolume: parseFloat(e.target.value) })}
            className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-purple-500"
          />
          <span className="text-[10px] text-purple-400 w-8 text-right">{Math.round(bgm.bgmVolume * 100)}%</span>
        </div>
      </div>
    </div>
  );
};

// -------------------------
// 1. 顶部导航 (Header)
// -------------------------
const Header = () => {
  const { ffmpegStatus } = useStore();

  return (
    <header className="h-16 shrink-0 flex items-center justify-between px-6 bg-white/5 border-b border-white/10 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <div className="w-8 h-8 rounded bg-gradient-to-br from-orange-500 to-red-600 flex items-center justify-center">
          <Layers className="text-white w-5 h-5" />
        </div>
        <h1 className="text-lg font-bold bg-gradient-to-r from-white to-white/60 bg-clip-text text-transparent">
          MatrixCut AI 矩阵混剪平台
        </h1>

        {/* FFmpeg Status Indicator */}
        <div className="ml-4 flex items-center gap-2 px-3 py-1 rounded-full bg-black/40 border border-white/5">
          <div className={`w-2 h-2 rounded-full ${ffmpegStatus === 'ready' ? 'bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]' :
            ffmpegStatus === 'loading' ? 'bg-orange-500 animate-pulse' :
              ffmpegStatus === 'error' ? 'bg-red-500' : 'bg-white/20'
            }`} />
          <span className="text-xs font-medium text-white/60">
            WASM引擎: {
              ffmpegStatus === 'ready' ? '就绪' :
                ffmpegStatus === 'loading' ? '下载中...' :
                  ffmpegStatus === 'error' ? '加载失败' : '休眠'
            }
          </span>
        </div>
      </div>

      <div className="flex items-center gap-8">
        <div className="flex items-center gap-6">
          <div className="flex bg-black/40 rounded-lg p-1 border border-white/5">
            <input id="exportQty" type="number" defaultValue="5" min="1" max="100" className="w-16 bg-transparent text-center text-sm outline-none text-white/90" />
            <span className="px-2 text-white/40 text-sm flex items-center">条</span>
          </div>

          <button
            onClick={() => {
              const qty = parseInt((document.getElementById('exportQty') as HTMLInputElement).value) || 1;
              performExport(useStore.getState(), qty);
            }}
            className="bg-orange-500 hover:bg-orange-600 text-white px-6 py-2 rounded-lg font-medium shadow-lg shadow-orange-500/20 active:scale-95 transition-all text-sm flex items-center gap-2"
          >
            <Zap className="w-4 h-4 fill-current" /> 一键批量生成
          </button>

          <button
            onClick={cancelExport}
            className="bg-red-500/20 hover:bg-red-500/40 text-red-400 border border-red-500/30 px-4 py-2 rounded-lg font-medium active:scale-95 transition-all text-sm flex items-center gap-2"
            title="停止当前批量生成"
          >
            <X className="w-4 h-4" /> 停止
          </button>
        </div>
      </div>
    </header>
  );
};

// -------------------------
// 2. 左侧素材池 (Material Pool)
// -------------------------
const MaterialPoolPanel = () => {
  const { pools, addPool, removePool, updatePoolName, addFilesToPool, removeFileFromPool, clearPool, updateFileThumbnail } = useStore();
  const [expandedPools, setExpandedPools] = useState<Record<string, boolean>>({});
  const [previewFile, setPreviewFile] = useState<VideoFile | null>(null);

  const toggleExpand = (poolId: string) => {
    setExpandedPools(prev => ({ ...prev, [poolId]: !prev[poolId] }));
  };

  const handleDirectorySelect = async (e: React.ChangeEvent<HTMLInputElement>, poolId: string) => {
    const files = e.target.files;
    if (!files) return;

    // 过滤 mp4/mov
    const validFiles = Array.from(files).filter(f =>
      f.type.startsWith('video/mp4') || f.type.startsWith('video/quicktime') ||
      f.name.toLowerCase().endsWith('.mp4') || f.name.toLowerCase().endsWith('.mov')
    );

    if (validFiles.length === 0) return;

    // Extract folder name from the first file's webkitRelativePath
    const firstPath = validFiles[0].webkitRelativePath || '';
    const folderName = firstPath.split('/')[0] || '新建素材文件夹';

    // 构建入库对象
    const newVideoFiles: VideoFile[] = validFiles.map(f => ({
      id: uuidv4(),
      file: f,
      name: f.name,
      url: URL.createObjectURL(f),
      thumbnail: null,
      duration: 0
    }));

    const pool = pools.find(p => p.id === poolId);
    const isFirstImport = pool && pool.files.length === 0;

    addFilesToPool(poolId, newVideoFiles);

    // 智能联动：如果这是该池子第一次导入目录
    if (isFirstImport) {
      // 1. 自动重命名素材池为文件夹名字
      updatePoolName(poolId, folderName);

      // 2. 检查轨道里是否已经有这个池子的片段，没有则在最后追加一段默认结构
      const currentTimeline = useStore.getState().timeline;
      if (!currentTimeline.some(t => t.poolId === poolId)) {
        useStore.getState().addTimelineSegment(poolId, 3.0);
      }

      // 3. 顺便帮用户在下面补齐一个新的空素材池坑位（如果是往最后一个池子里传）
      const currentPools = useStore.getState().pools;
      if (currentPools.length > 0 && currentPools[currentPools.length - 1].id === poolId) {
        addPool();
      }
    }

    // 异步排队抽帧
    newVideoFiles.forEach(async (vf) => {
      try {
        const { thumbnail, duration } = await extractVideoThumbnail(vf.url);
        updateFileThumbnail(poolId, vf.id, thumbnail, duration);
      } catch (err) {
        console.error("Thumbnail extraction failed for", vf.name, err);
      }
    });

    // reset input
    e.target.value = '';
  };

  return (
    <div className="w-80 shrink-0 flex flex-col border-r border-white/10 bg-black/20">
      <div className="p-4 border-b border-white/10 flex items-center justify-between">
        <h2 className="text-sm font-medium text-white/90 flex items-center gap-2">
          <FolderPlus className="w-4 h-4 text-orange-500" />
          分段素材池
        </h2>
        <button
          onClick={addPool}
          className="w-6 h-6 rounded bg-white/5 flex items-center justify-center hover:bg-white/10 transition"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">
        {pools.map((pool) => {
          return (
            <GlassPanel key={pool.id} className="rounded-xl overflow-hidden shadow-lg">
              <div className="p-3 bg-white/5 border-b border-white/5 flex items-center justify-between group">
                <input
                  type="text"
                  value={pool.name}
                  onChange={(e) => updatePoolName(pool.id, e.target.value)}
                  className="bg-transparent border-none outline-none text-sm font-medium text-white/90 w-full focus:ring-1 focus:ring-orange-500/50 rounded px-1 -ml-1"
                />
                <button
                  onClick={() => removePool(pool.id)}
                  className="opacity-0 group-hover:opacity-100 transition text-white/40 hover:text-red-400"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>

              <div className="p-3">
                {pool.files.length === 0 ? (
                  <label className="w-full h-24 border border-dashed border-white/10 rounded-lg text-white/40 hover:text-white/80 hover:bg-white/5 transition flex flex-col items-center justify-center gap-2 cursor-pointer">
                    <FolderPlus className="w-5 h-5 text-orange-500/50" />
                    <span className="text-xs">点击导入目录添加素材</span>
                    <input
                      type="file"
                      className="hidden"
                      // @ts-ignore
                      webkitdirectory="true"
                      directory="true"
                      multiple
                      onChange={(e) => handleDirectorySelect(e, pool.id)}
                    />
                  </label>
                ) : (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-xs text-white/60 font-medium">共 {pool.files.length} 个视频</div>
                      {pool.files.length > 5 && (
                        <button
                          onClick={() => toggleExpand(pool.id)}
                          className="flex items-center gap-1 text-[10px] text-orange-400 hover:text-orange-300 transition bg-orange-500/10 px-2 py-1 rounded"
                        >
                          {expandedPools[pool.id] ? (
                            <><ChevronDown className="w-3 h-3" /> 收起</>
                          ) : (
                            <><ChevronRight className="w-3 h-3" /> 展开全部</>
                          )}
                        </button>
                      )}
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      {(expandedPools[pool.id] ? pool.files : pool.files.slice(0, 5)).map(file => (
                        <div
                          key={file.id}
                          onClick={() => setPreviewFile(file)}
                          className={`aspect-square rounded-md relative group flex items-center justify-center bg-zinc-900 border border-white/10 overflow-hidden cursor-pointer hover:border-orange-500/50 transition`}
                          title={file.name}
                        >
                          {file.thumbnail ? (
                            <img src={file.thumbnail} alt="thumb" className="w-full h-full object-cover" />
                          ) : (
                            <div className="animate-pulse w-full h-full bg-white/10 flex items-center justify-center">
                              <Film className="w-4 h-4 text-white/20" />
                            </div>
                          )}

                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              removeFileFromPool(pool.id, file.id);
                            }}
                            className="absolute top-1 right-1 w-5 h-5 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition hover:bg-red-500/80"
                          >
                            <Trash2 className="w-3 h-3 text-white" />
                          </button>

                          {file.duration > 0 && (
                            <div className="absolute bottom-1 right-1 bg-black/60 text-[8px] px-1 rounded backdrop-blur-sm text-white/90">
                              {file.duration.toFixed(1)}s
                            </div>
                          )}
                        </div>
                      ))}

                      {/* File Uploader 伪装成 Plus 按钮 */}
                      <label className="aspect-square rounded-md border border-dashed border-white/20 hover:border-orange-500/50 hover:bg-orange-500/5 flex flex-col items-center justify-center gap-1 transition text-white/40 hover:text-orange-500 cursor-pointer">
                        <Plus className="w-4 h-4" />
                        <input
                          type="file"
                          className="hidden"
                          // @ts-ignore
                          webkitdirectory="true"
                          directory="true"
                          multiple
                          onChange={(e) => handleDirectorySelect(e, pool.id)}
                        />
                      </label>
                    </div>

                    <div className="flex gap-2">
                      <label className="flex-1 text-xs text-center py-2 border border-dashed border-white/10 rounded-lg text-white/50 hover:text-white/80 hover:bg-white/5 transition flex items-center justify-center gap-1 cursor-pointer">
                        <FolderPlus className="w-3 h-3" /> 继续导入目录
                        <input
                          type="file"
                          className="hidden"
                          // @ts-ignore
                          webkitdirectory="true"
                          directory="true"
                          multiple
                          onChange={(e) => handleDirectorySelect(e, pool.id)}
                        />
                      </label>
                      {pool.files.length > 0 && (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            if (window.confirm(`确定要清空「${pool.name}」中的所有素材吗？`)) {
                              clearPool(pool.id);
                            }
                          }}
                          className="px-3 text-xs text-center border border-dashed border-red-500/30 rounded-lg text-red-500/50 hover:text-red-400 hover:bg-red-500/10 transition flex items-center justify-center"
                          title="一键清空"
                        >
                          <Trash2 className="w-3 h-3" />
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            </GlassPanel>
          )
        })}
      </div>

      {/* BGM 音乐池 */}
      <div className="px-4 pb-4">
        <BgmPanel />
      </div>

      {/* Video Preview Modal */}
      {previewFile && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/90 backdrop-blur-sm"
          onClick={() => setPreviewFile(null)}
        >
          <button
            className="absolute top-6 right-6 p-2 rounded-full bg-white/10 hover:bg-white/20 text-white transition"
            onClick={(e) => {
              e.stopPropagation();
              setPreviewFile(null);
            }}
          >
            <X className="w-6 h-6" />
          </button>

          <div onClick={(e) => e.stopPropagation()} className="relative max-w-[90vw] max-h-[90vh]">
            <video
              src={previewFile.url}
              autoPlay
              controls
              className="max-h-[85vh] rounded-lg shadow-2xl border border-white/10"
            />
            <div className="absolute -bottom-8 left-0 text-white/70 text-sm">
              {previewFile.name}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// -------------------------
// 3. 中间预览区域 (Workspace)
// -------------------------

const SortableSegment = ({
  seg,
  isEditing,
  isSelected,
  setEditingSegId,
  onSelect,
  colorClasses,
  boundPool,
  pools,
  updateTimelineSegment,
  removeTimelineSegment,
  duplicateTimelineSegment,
  addTimelineSegment,
  isLast
}: any) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: seg.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    zIndex: isDragging ? 100 : (isEditing ? 50 : 1),
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className={`flex flex-col items-center group relative flex-shrink-0 ${isDragging ? 'opacity-50 scale-105' : ''}`}
    >
      <div
        onClick={(e) => {
          e.stopPropagation();
          if (e.shiftKey) {
            // Shift+点击：切换如屏选状态
            onSelect(seg.id);
          } else {
            // 普通点击：单独编辑
            setEditingSegId(isEditing ? null : seg.id);
          }
        }}
        style={{ width: `${Math.max(60, Math.floor(seg.duration * 32))}px` }}
        className={`h-16 border flex flex-col justify-center px-2 hover:brightness-125 transition-all text-xs overflow-hidden cursor-pointer rounded relative
          ${isSelected ? 'border-blue-400 ring-2 ring-blue-400/40 bg-blue-500/20' : isEditing ? 'border-orange-500 ring-2 ring-orange-500/30 ' + colorClasses : colorClasses}
          ${isDragging ? 'shadow-2xl shadow-orange-500/20 border-orange-500/50' : ''}`}
      >
        {isSelected && (
          <div className="absolute top-1 right-1 w-3.5 h-3.5 bg-blue-400 rounded-full flex items-center justify-center">
            <svg viewBox="0 0 10 10" className="w-2 h-2 fill-white">
              <polyline points="1.5,5 4,7.5 8.5,2.5" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        )}
        <div className="font-medium text-white/90 truncate w-full text-center">{boundPool?.name || '未知项'}</div>
        <div className="text-white/50 text-[10px] select-none text-center">{seg.duration.toFixed(1)}s</div>
      </div>

      {isEditing && (
        <div
          onClick={e => e.stopPropagation()} // 防止点击内部触发拖拽
          className="absolute -top-12 left-1/2 -translate-x-1/2 bg-zinc-900 border border-white/20 p-2 rounded-lg shadow-2xl flex flex-col gap-2 z-50 w-48 cursor-default"
        >
          <select
            value={seg.poolId}
            onChange={e => updateTimelineSegment(seg.id, { poolId: e.target.value })}
            className="bg-black/50 text-white/90 text-xs p-1 rounded border border-white/10 outline-none w-full"
          >
            {pools.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>

          <div className="flex items-center gap-1">
            <span className="text-white/50 text-[10px]">时长</span>
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={seg.duration}
              onChange={e => updateTimelineSegment(seg.id, { duration: parseFloat(e.target.value) || 0.1 })}
              className="bg-black/50 text-white/90 text-xs p-1 rounded border border-white/10 w-16 text-center outline-none"
            />
            <span className="text-white/50 text-[10px]">s</span>

            <div className="flex-1 flex justify-end gap-1">
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  duplicateTimelineSegment(seg.id);
                  setEditingSegId(null); // Optional: close editor after duplication
                }}
                className="text-white/60 hover:text-white hover:bg-white/10 p-1 rounded transition"
                title="复制片段"
              >
                <Copy className="w-3 h-3" />
              </button>
              <button onClick={() => removeTimelineSegment(seg.id)} className="text-red-400 hover:bg-white/10 p-1 rounded transition" title="删除片段">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Add segment in-between */}
      {!isLast && (
        <div
          className="absolute -right-4 top-1/2 -translate-y-1/2 w-6 h-6 z-10 bg-black border border-white/10 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition shadow-lg cursor-pointer hover:bg-orange-500/20"
          onClick={(e) => {
            e.stopPropagation();
            addTimelineSegment(pools[0]?.id);
          }}
        >
          <Plus className="w-3 h-3 text-white/50 hover:text-white" />
        </div>
      )}
    </div>
  );
};

const DraggableOverlay = ({
  children,
  pos,
  onPosChange,
  className
}: {
  children: React.ReactNode;
  pos: { x: number; y: number };
  onPosChange: (pos: { x: number; y: number }) => void;
  className?: string;
}) => {
  const isDragging = React.useRef(false);
  const startMouse = React.useRef({ x: 0, y: 0 });
  const startPos = React.useRef({ x: 0, y: 0 });

  const handlePointerDown = (e: React.PointerEvent) => {
    isDragging.current = true;
    startMouse.current = { x: e.clientX, y: e.clientY };
    startPos.current = { ...pos };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (isDragging.current) {
      const dx = e.clientX - startMouse.current.x;
      const dy = e.clientY - startMouse.current.y;
      onPosChange({ x: startPos.current.x + dx, y: startPos.current.y + dy });
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (isDragging.current) {
      isDragging.current = false;
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    }
  };

  return (
    <div
      className={`absolute cursor-move z-20 w-fit whitespace-nowrap px-4 py-2 hover:ring-2 hover:ring-orange-500/50 hover:bg-black/20 transition-colors rounded ${className}`}
      style={{ left: '50%', top: '50%', transform: `translate(calc(-50% + ${pos.x}px), calc(-50% + ${pos.y}px))` }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {children}
    </div>
  );
};

const WorkspaceArea = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewIndices, setPreviewIndices] = useState<Record<string, number>>({});
  const [selectedSegIds, setSelectedSegIds] = useState<Set<string>>(new Set());
  const { timeline, pools, settings, bgm, addTimelineSegment, updateTimelineSegment, removeTimelineSegment, duplicateTimelineSegment, reorderTimelineSegments, updateTextElement, updateImageElement } = useStore();
  const videoRef = React.useRef<HTMLVideoElement>(null);
  const bgmAudioRef = React.useRef<HTMLAudioElement | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // 切换单个片段的选择状态
  const handleToggleSelect = (segId: string) => {
    setSelectedSegIds(prev => {
      const next = new Set(prev);
      next.has(segId) ? next.delete(segId) : next.add(segId);
      return next;
    });
  };

  // 批量更新所有选中片段的属性
  const handleBulkUpdate = (updates: { duration?: number; poolId?: string }) => {
    selectedSegIds.forEach(id => updateTimelineSegment(id, updates));
  };

  // 批量删除所有选中片段
  const handleBulkDelete = () => {
    selectedSegIds.forEach(id => removeTimelineSegment(id));
    setSelectedSegIds(new Set());
  };

  const handleExportScheme = () => {
    const data = {
      version: 1,
      settings,
      timeline,
      pools: pools.map(p => ({ id: p.id, name: p.name }))
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    saveAs(blob, 'matrix_scheme.json');
  };

  const handleImportScheme = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (evt) => {
      try {
        const data = JSON.parse(evt.target?.result as string);
        if (data.version === 1) {
          useStore.setState({
            settings: data.settings,
            timeline: data.timeline,
            pools: data.pools.map((p: any) => ({ ...p, files: [] }))
          });
          alert('方案已读取！为了保障安全与内存占用，方案仅保存结构，请重新为各素材池添加入库实际的视频文件。');
        } else {
          alert('不支持的方案版本格式格式');
        }
      } catch (err) {
        alert('读取方案失败：解析错误或文件损坏\n' + err);
      }
    };
    reader.readAsText(file);
    // clean up input
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  // 后台静默预加载 FFmpeg 核心引擎
  React.useEffect(() => {
    getFFmpeg().catch(err => console.error('Silent preload of FFmpeg failed:', err));
  }, []);

  // IndexedDB 数据持久化 (Draft System)
  const [isDraftLoading, setIsDraftLoading] = useState(true);

  React.useEffect(() => {
    // 1. Initial Load from IndexedDB
    idbGet('matrix_draft').then(draft => {
      if (draft && draft.version === 1) {
        // Restore Object URLs for files
        const restoredPools = draft.pools.map((p: any) => ({
          ...p,
          files: p.files.map((f: any) => ({
            ...f,
            url: URL.createObjectURL(f.file), // Regenerate URL
            thumbnail: f.thumbnail // Assuming thumbnail is base64
          }))
        }));

        const restoredBgm = {
          ...draft.bgm,
          files: draft.bgm.files.map((f: any) => ({
            ...f,
            url: URL.createObjectURL(f.file)
          }))
        };

        const restoredSettings = {
          ...draft.settings,
          images: draft.settings?.images ? draft.settings.images.map((img: any) => ({
            ...img,
            url: URL.createObjectURL(img.file)
          })) : []
        };

        useStore.setState({
          pools: restoredPools,
          timeline: draft.timeline,
          settings: restoredSettings,
          bgm: restoredBgm
        });
        console.log('Restored draft from IndexedDB');
      }
    }).catch(err => console.error('Draft load error:', err))
      .finally(() => setIsDraftLoading(false));
  }, []);

  React.useEffect(() => {
    // 2. Auto-save to IndexedDB (debounced bypass by using a timeout and cleaning it up)
    if (isDraftLoading) return; // Don't overwrite draft while initially loading

    const handler = setTimeout(() => {
      const draft = {
        version: 1,
        pools,
        timeline,
        settings,
        bgm
      };
      // idb-keyval natively supports storing File objects within objects
      idbSet('matrix_draft', draft).catch(err => console.error('Draft save error:', err));
    }, 1000); // 1s debounce

    return () => clearTimeout(handler);
  }, [pools, timeline, settings, bgm, isDraftLoading]);



  // Local state for inline editing
  const [editingSegId, setEditingSegId] = useState<string | null>(null);

  const totalDuration = timeline.reduce((acc, seg) => acc + seg.duration, 0);

  // BGM 预览音频同步控制
  React.useEffect(() => {
    if (isPlaying) {
      // 开始播放时，随机选一首 BGM
      if (bgm.files.length > 0) {
        const picked = bgm.files[Math.floor(Math.random() * bgm.files.length)];
        if (!bgmAudioRef.current) {
          bgmAudioRef.current = new Audio(picked.url);
        } else {
          bgmAudioRef.current.src = picked.url;
        }
        bgmAudioRef.current.volume = bgm.bgmVolume;
        bgmAudioRef.current.loop = true;
        bgmAudioRef.current.play().catch(() => { });
      }
    } else {
      // 暂停时停止 BGM
      bgmAudioRef.current?.pause();
    }
  }, [isPlaying]);

  // BGM 音量实时更新
  React.useEffect(() => {
    if (bgmAudioRef.current) bgmAudioRef.current.volume = bgm.bgmVolume;
  }, [bgm.bgmVolume]);

  // 播放控制效果
  React.useEffect(() => {
    let animationFrameId: number;
    let lastTime = performance.now();

    const tick = (now: number) => {
      if (isPlaying) {
        const delta = (now - lastTime) / 1000;
        setCurrentTime(prev => Math.min(prev + delta, totalDuration));
      }
      lastTime = now;
      if (isPlaying) {
        animationFrameId = requestAnimationFrame(tick);
      }
    };

    if (isPlaying) {
      animationFrameId = requestAnimationFrame(tick);
    }

    return () => cancelAnimationFrame(animationFrameId);
  }, [isPlaying, totalDuration]);

  // 当时间到达终点时，自动停止并归零
  React.useEffect(() => {
    if (isPlaying && totalDuration > 0 && currentTime >= totalDuration) {
      setIsPlaying(false);
      setCurrentTime(0);
    }
  }, [currentTime, totalDuration, isPlaying]);

  // 根据 currentTime 计算当前正在播放的分段和素材
  const getCurrentPlayingInfo = () => {
    let accumulatedTime = 0;
    for (const seg of timeline) {
      if (currentTime >= accumulatedTime && currentTime <= accumulatedTime + seg.duration) {
        const boundPool = pools.find(p => p.id === seg.poolId);
        // 使用针对该分段临时固定的随机索引，避免在播放过程中突然切换视频
        const fileIndex = previewIndices[seg.id] || 0;
        const file = boundPool?.files[fileIndex] || null;
        return { seg, file };
      }
      accumulatedTime += seg.duration;
    }
    // Return last segment info if at the end
    const lastSeg = timeline[timeline.length - 1];
    if (lastSeg) {
      const boundPool = pools.find(p => p.id === lastSeg.poolId);
      const fileIndex = previewIndices[lastSeg.id] || 0;
      return { seg: lastSeg, file: boundPool?.files[fileIndex] || null };
    }
    return { seg: null, file: null };
  };

  const { seg: currentSeg, file: currentFile } = timeline.length > 0 ? getCurrentPlayingInfo() : { seg: null, file: null };

  React.useEffect(() => {
    if (videoRef.current && isPlaying) {
      // 强制在新切段跳回0秒
      videoRef.current.currentTime = 0;
      videoRef.current.play().catch(e => console.error("Play error:", e));
    }
  }, [currentSeg?.id, currentFile?.url]);

  React.useEffect(() => {
    if (videoRef.current) {
      if (isPlaying) {
        videoRef.current.play().catch(e => console.error("Play error:", e));
      } else {
        videoRef.current.pause();
      }
    }
  }, [isPlaying]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: {
        distance: 5, // 拖动5像素后才认为是拖拽，防止和点击事件冲突
      },
    }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
    })
  );

  const handleDragEnd = (event: DragEndEvent) => {
    const { active, over } = event;

    if (over && active.id !== over.id) {
      const oldIndex = timeline.findIndex(t => t.id === active.id);
      const newIndex = timeline.findIndex(t => t.id === over.id);
      reorderTimelineSegments(oldIndex, newIndex);
    }
  };

  return (
    <div className="flex-1 flex flex-col relative bg-[#050505]">
      {/* 预览器顶部 */}
      <div className="flex-1 flex items-center justify-center p-8 relative overflow-hidden">
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-96 h-96 bg-orange-500/10 blur-[100px] rounded-full" />

        <div className={`relative aspect-[9/16] h-full max-h-[600px] bg-black rounded-2xl shadow-2xl border border-white/10 overflow-hidden flex items-center justify-center group transition-transform duration-500`}>
          {currentFile ? (
            <div className={`absolute inset-0 bg-zinc-900 flex items-center justify-center`}>
              <video
                ref={videoRef}
                key={currentSeg?.id} // 强制视频组件在切段时重新挂载以从 0 秒重播
                src={currentFile.url}
                className="w-full h-full object-cover"
              />
              {isPlaying && (
                <div className="absolute top-4 right-4 z-30 bg-red-500/80 text-white text-[10px] px-2 py-1 rounded shadow animate-pulse">REC</div>
              )}
            </div>
          ) : (
            <div className={`absolute inset-0 bg-zinc-900 flex items-center justify-center`}>
              <div className="text-xl font-bold font-mono text-white/50 tracking-widest uppercase flex flex-col items-center">
                <Film className="w-16 h-16 text-white/10 mb-4" />
                无素材
              </div>
            </div>
          )}

          {!isPlaying && timeline.length === 0 && (
            <Film className="w-16 h-16 text-white/10 absolute z-0" />
          )}

          <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-black/20 z-10 pointer-events-none" />

          {settings.texts && settings.texts.map(textElem => (
            <DraggableOverlay
              key={textElem.id}
              pos={textElem.pos}
              onPosChange={(pos) => updateTextElement(textElem.id, { pos })}
            >
              <p
                className="font-bold pointer-events-none text-center"
                style={{
                  fontFamily: textElem.style.fontFamily,
                  fontSize: `${textElem.style.fontSize}px`,
                  color: textElem.style.color,
                  textShadow: `${textElem.style.shadowDistance * Math.cos(textElem.style.shadowAngle * Math.PI / 180)}px ${textElem.style.shadowDistance * -Math.sin(textElem.style.shadowAngle * Math.PI / 180)}px ${textElem.style.shadowBlur}px rgba(${parseInt(textElem.style.shadowColor.slice(1, 3), 16)}, ${parseInt(textElem.style.shadowColor.slice(3, 5), 16)}, ${parseInt(textElem.style.shadowColor.slice(5, 7), 16)}, ${textElem.style.shadowOpacity})`
                }}
              >
                {textElem.text}
              </p>
            </DraggableOverlay>
          ))}

          {settings.images && settings.images.map(imgElem => (
            <DraggableOverlay
              key={imgElem.id}
              pos={imgElem.pos}
              onPosChange={(pos) => updateImageElement(imgElem.id, { pos })}
            >
              <img
                src={imgElem.url}
                alt="overlay"
                className="pointer-events-none select-none max-w-none origin-center"
                style={{ transform: `scale(${imgElem.scale})` }}
              />
            </DraggableOverlay>
          ))}

          <button
            onClick={() => {
              if (isPlaying) {
                setIsPlaying(false);
                return;
              }
              if (timeline.length === 0) {
                alert("当前轨道为空，请先添加结构！");
                return;
              }
              // Check if any segment is missing media
              const emptySegments = timeline.filter(seg => {
                const pool = pools.find(p => p.id === seg.poolId);
                return !pool || pool.files.length === 0;
              });

              if (emptySegments.length > 0) {
                alert("您目前的轨道结构中有片段尚未导入素材，请先为左侧对应的素材池添加视频！");
                return;
              }

              // 如果是从头开始播放，或者已经播放到底，重新洗牌预览池
              if (currentTime === 0 || currentTime >= totalDuration) {
                const newIndices: Record<string, number> = {};
                timeline.forEach(seg => {
                  const pool = pools.find(p => p.id === seg.poolId);
                  if (pool && pool.files.length > 0) {
                    newIndices[seg.id] = Math.floor(Math.random() * pool.files.length);
                  }
                });
                setPreviewIndices(newIndices);
              }

              setIsPlaying(true);
            }}
            className="absolute z-30 w-16 h-16 bg-orange-500/90 text-white rounded-full flex items-center justify-center shadow-lg shadow-orange-500/30 backdrop-blur-sm transition-transform hover:scale-105 active:scale-95"
          >
            {isPlaying ? <Pause className="w-8 h-8 fill-current" /> : <Play className="w-8 h-8 fill-current ml-1" />}
          </button>
        </div>
      </div>

      {/* 轨道 */}
      <div
        className="h-64 shrink-0 border-t border-white/10 bg-zinc-950 flex flex-col"
        onClick={() => setEditingSegId(null)}
      >
        <div className="h-10 border-b border-white/5 flex items-center px-4 justify-between bg-white/[0.02]">
          <div className="flex gap-2 relative">
            <button onClick={handleExportScheme} className="px-3 py-1 bg-white/5 hover:bg-white/10 rounded text-xs text-white/80 transition shadow-sm border border-white/5 flex items-center gap-1.5"><Download className="w-3 h-3" /> 保存剪辑方案</button>
            <button onClick={() => fileInputRef.current?.click()} className="px-3 py-1 hover:bg-white/5 rounded text-xs text-white/80 transition border border-white/10 flex items-center gap-1.5"><FolderOpen className="w-3 h-3" /> 读取方案</button>
            <input
              type="file"
              accept=".json"
              ref={fileInputRef}
              onChange={handleImportScheme}
              className="hidden"
            />
          </div>
          <div className="text-xs text-white/40 flex items-center gap-2">
            <Clock className="w-3.5 h-3.5" />
            <span className="font-mono text-orange-400">{currentTime.toFixed(1)}s</span> / {totalDuration.toFixed(1)}s
          </div>
        </div>

        <div className="flex-1 p-4 overflow-x-auto custom-scrollbar" onClick={() => setSelectedSegIds(new Set())}>

          {/* 批量操作浮动工具栏 */}
          {selectedSegIds.size >= 1 && (
            <div
              className="mb-3 flex items-center gap-3 px-3 py-2 bg-blue-500/15 border border-blue-400/30 rounded-lg"
              onClick={e => e.stopPropagation()}
            >
              <span className="text-blue-300 text-xs font-medium shrink-0">已选 {selectedSegIds.size} 段</span>
              <div className="flex items-center gap-1.5">
                <span className="text-white/40 text-xs">统一时长</span>
                <input
                  type="number" step="0.1" min="0.1" defaultValue="3"
                  className="w-16 bg-black/40 text-white/90 text-xs px-2 py-1 rounded border border-white/10 outline-none text-center"
                  id="bulkDuration"
                />
                <span className="text-white/40 text-xs">s</span>
                <button
                  onClick={() => handleBulkUpdate({ duration: parseFloat((document.getElementById('bulkDuration') as HTMLInputElement)?.value) || 3 })}
                  className="text-[10px] px-2 py-1 bg-blue-500/20 text-blue-300 border border-blue-400/30 rounded hover:bg-blue-500/30 transition"
                >应用</button>
              </div>
              <div className="flex items-center gap-1.5">
                <span className="text-white/40 text-xs">统一素材池</span>
                <select
                  className="bg-black/50 text-white/80 text-xs px-2 py-1 rounded border border-white/10 outline-none"
                  onChange={e => e.target.value && handleBulkUpdate({ poolId: e.target.value })}
                  defaultValue=""
                >
                  <option value="">选择素材池…</option>
                  {pools.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <button
                onClick={handleBulkDelete}
                className="ml-auto flex items-center gap-1 text-xs text-red-400 hover:text-red-300 border border-red-500/30 px-2 py-1 rounded hover:bg-red-500/10 transition"
              ><Trash2 className="w-3 h-3" />删除所选</button>
              <button
                onClick={() => setSelectedSegIds(new Set())}
                className="text-white/40 hover:text-white text-xs px-2"
              >取消选中</button>
            </div>
          )}

          <div className="flex gap-2 min-w-max items-center h-full relative">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              onDragEnd={handleDragEnd}
            >
              <SortableContext
                items={timeline.map(t => t.id)}
                strategy={horizontalListSortingStrategy}
              >
                {timeline.map((seg, idx) => {
                  const boundPool = pools.find(p => p.id === seg.poolId);
                  const poolIdx = pools.findIndex(p => p.id === seg.poolId);
                  const colorName = getPoolColor(Math.max(0, poolIdx));
                  const isEditing = editingSegId === seg.id;
                  const colorClasses = `border-${colorName}-500/50 bg-${colorName}-500/10`;

                  return (
                    <SortableSegment
                      key={seg.id}
                      seg={seg}
                      idx={idx}
                      isEditing={isEditing}
                      isSelected={selectedSegIds.has(seg.id)}
                      setEditingSegId={setEditingSegId}
                      onSelect={handleToggleSelect}
                      colorClasses={colorClasses}
                      boundPool={boundPool}
                      pools={pools}
                      updateTimelineSegment={updateTimelineSegment}
                      removeTimelineSegment={removeTimelineSegment}
                      duplicateTimelineSegment={duplicateTimelineSegment}
                      addTimelineSegment={addTimelineSegment}
                      isLast={idx === timeline.length - 1}
                    />
                  );
                })}
              </SortableContext>
            </DndContext>

            <button
              onClick={(e) => {
                e.stopPropagation();
                addTimelineSegment(pools[0]?.id);
              }}
              className="h-16 w-32 ml-4 rounded border border-dashed border-white/20 bg-white/5 hover:bg-white/10 flex items-center justify-center text-white/40 hover:text-white/80 transition shrink-0"
            >
              <Plus className="w-4 h-4 mr-1" /> 添加结构
            </button>
          </div>
        </div>
      </div>
    </div >
  );
};

// -------------------------
// 4. 右侧设置与导出 (Settings)
// -------------------------
const SettingsPanel = () => {
  const { settings, exports, customFonts, updateSettings, addCustomFont, addTextElement, removeTextElement, updateTextElement, addImageElement, removeImageElement, updateImageElement } = useStore();
  const [isZipping, setIsZipping] = useState(false);
  const fontInputRef = React.useRef<HTMLInputElement>(null);
  const imageInputRef = React.useRef<HTMLInputElement>(null);

  const handleClearDraft = async () => {
    if (window.confirm("确定要清空本地草稿吗？此操作将丢失所有未导出的进度与上传素材的关联！")) {
      await idbDel('matrix_draft');
      window.location.reload();
    }
  };

  const handleFontUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // 1. 获取本地文件的 URL
      const fontUrl = URL.createObjectURL(file);
      // 2. 生成一个唯一字体名，去掉后缀保留基本名
      const baseName = file.name.replace(/\.[^/.]+$/, "");
      const fontFamilyName = `CustomFont_${Date.now()}_${baseName}`;

      // 3. 使用 FontFace API 加载字体
      const fontFace = new FontFace(fontFamilyName, `url(${fontUrl})`);
      const loadedFace = await fontFace.load();

      // 4. 将加载完成的字体添加到 document
      document.fonts.add(loadedFace);

      // 5. 将新字体存入全局 store
      addCustomFont(baseName, fontFamilyName);

      alert(`字体 "${baseName}" 已成功加载并可在设置中使用！`);
    } catch (err) {
      console.error('Font load error:', err);
      alert('字体加载失败，请检查文件格式是否有效');
    }

    if (fontInputRef.current) fontInputRef.current.value = '';
  };

  const handleImageUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    addImageElement(file);
    e.target.value = '';
  };

  const handleDownloadZip = async () => {
    const doneExports = exports.filter(e => e.status === 'done' && e.resultUrl);
    if (doneExports.length === 0) {
      alert('没有已完成的视频可供打包！');
      return;
    }

    try {
      setIsZipping(true);
      const zip = new JSZip();

      // Fetch all blobs and add to zip
      await Promise.all(doneExports.map(async (exp) => {
        const response = await fetch(exp.resultUrl!);
        const blob = await response.blob();
        zip.file(`${exp.createdAt}.mp4`, blob);
      }));

      const zipBlob = await zip.generateAsync({ type: 'blob' });
      saveAs(zipBlob, 'matrix_cut_exports.zip');
    } catch (err) {
      console.error('ZIP Pack error:', err);
      alert('打包压缩包时发生错误');
    } finally {
      setIsZipping(false);
    }
  };

  return (
    <div className="w-80 shrink-0 border-l border-white/10 bg-black/20 flex flex-col">
      <div className="p-4 border-b border-white/10">
        <h2 className="text-sm font-medium text-white/90 flex items-center gap-2">
          <Settings className="w-4 h-4 text-orange-500" />
          全局设定配置
        </h2>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-6 custom-scrollbar">

        {/* 字体管理 */}
        <GlassPanel className="p-4 rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white/60 flex items-center gap-1.5 uppercase tracking-wider">
              <Type className="w-3.5 h-3.5" /> 本地字体
            </h3>
            <div className="flex gap-2">
              <button
                onClick={handleClearDraft}
                className="text-[10px] bg-red-500/20 hover:bg-red-500/40 text-red-300 px-2 py-1 rounded border border-red-500/30 transition flex items-center"
              >
                清空草稿
              </button>
              <button
                onClick={() => fontInputRef.current?.click()}
                className="text-xs bg-white/10 hover:bg-white/20 text-white px-2 py-1 rounded border border-white/10 transition flex items-center gap-1"
              >
                <Plus className="w-3 h-3" /> 添加字体
              </button>
            </div>
            <input
              type="file"
              accept=".ttf,.otf,.woff,.woff2"
              ref={fontInputRef}
              onChange={handleFontUpload}
              className="hidden"
            />
          </div>
          {customFonts.length > 0 ? (
            <div className="flex flex-wrap gap-2">
              {customFonts.map(f => (
                <div key={f.url} className="text-[10px] bg-black/40 border border-white/10 px-2 py-1 rounded text-white/80">
                  {f.name}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-[10px] text-white/40">暂无自定义字体</div>
          )}
        </GlassPanel>

        {/* 图文覆盖 */}
        <GlassPanel className="p-4 rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white/60 flex items-center gap-1.5 uppercase tracking-wider">
              <Type className="w-3.5 h-3.5" /> 图文覆盖
            </h3>
            <button
              onClick={addTextElement}
              className="text-[10px] bg-blue-500/20 text-blue-300 hover:bg-blue-500/40 px-2 py-1 rounded border border-blue-500/30 transition flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> 添加字幕
            </button>
          </div>

          <div className="space-y-4">
            {(!settings.texts || settings.texts.length === 0) ? (
              <div className="text-[10px] text-white/40 text-center py-4">暂无字幕，点击右上方添加</div>
            ) : (
              settings.texts.map((textElem, index) => (
                <div key={textElem.id} className="space-y-2 pt-3 border-t border-white/5 first:border-0 first:pt-0">
                  <div className="flex items-center justify-between">
                    <label className="text-[10px] font-medium text-white/50 flex items-center">
                      字幕列 {index + 1}
                    </label>
                    <button
                      onClick={() => removeTextElement(textElem.id)}
                      className="text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition"
                    >
                      删除
                    </button>
                  </div>

                  <input
                    type="text"
                    value={textElem.text}
                    onChange={e => updateTextElement(textElem.id, { text: e.target.value })}
                    className="w-full bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500/50"
                  />

                  <div className="space-y-2 mt-2">
                    <div className="flex bg-black/40 border border-white/10 rounded px-2 py-1 items-center justify-between">
                      <span className="text-[10px] text-white/40">字形参数</span>
                      <div className="flex items-center gap-2">
                        <select
                          value={textElem.style.fontFamily}
                          onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, fontFamily: e.target.value } })}
                          className="w-24 bg-zinc-800 rounded px-1 text-[10px] text-white outline-none"
                        >
                          <option value="serif">宋体/Serif</option>
                          <option value="sans-serif">无衬线/Sans</option>
                          <option value="monospace">等宽/Mono</option>
                          <option value="SimHei, Heiti SC, sans-serif">默认黑体</option>
                          <option value="'Microsoft YaHei', PingFang SC, sans-serif">雅黑/苹方</option>
                          <option value="KaiTi, Kaiti SC, serif">楷体</option>
                          <option value="FangSong, FangSong SC, serif">仿宋</option>
                          <option value="cursive">手写签名字体/Cursive</option>
                          <option value="fantasy">艺术强调体/Fantasy</option>
                          {customFonts.map(f => <option key={f.url} value={f.name}>{f.name}</option>)}
                        </select>
                        <input type="number" min="10" max="100" title="字号" value={textElem.style.fontSize} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, fontSize: parseInt(e.target.value) || 24 } })} className="w-12 bg-zinc-800 rounded px-1 text-[10px] text-white outline-none" />
                        <input type="color" title="颜色" value={textElem.style.color} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, color: e.target.value } })} className="w-6 h-4 bg-transparent cursor-pointer rounded-sm" />
                      </div>
                    </div>

                    <div className="bg-black/40 border border-white/10 rounded p-2 space-y-3">
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-white/40 flex items-center gap-1">✅ 阴影高级配置</span>
                        <input type="color" value={textElem.style.shadowColor} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, shadowColor: e.target.value } })} className="w-5 h-4 bg-transparent cursor-pointer rounded-sm" />
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/40 w-12 shrink-0">不透明度</span>
                        <input type="range" min="0" max="1" step="0.05" value={textElem.style.shadowOpacity} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, shadowOpacity: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                        <span className="text-[10px] text-white/40 w-8 text-right">{Math.round(textElem.style.shadowOpacity * 100)}%</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/40 w-12 shrink-0">模糊度</span>
                        <input type="range" min="0" max="100" value={textElem.style.shadowBlur} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, shadowBlur: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                        <span className="text-[10px] text-white/40 w-8 text-right">{textElem.style.shadowBlur}%</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/40 w-12 shrink-0">距离</span>
                        <input type="range" min="0" max="100" value={textElem.style.shadowDistance} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, shadowDistance: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                        <span className="text-[10px] text-white/40 w-8 text-right">{textElem.style.shadowDistance}</span>
                      </div>

                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-white/40 w-12 shrink-0">角度</span>
                        <input type="range" min="-180" max="180" value={textElem.style.shadowAngle} onChange={e => updateTextElement(textElem.id, { style: { ...textElem.style, shadowAngle: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                        <span className="text-[10px] text-white/40 w-8 text-right">{textElem.style.shadowAngle}°</span>
                      </div>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </GlassPanel>

        {/* 自定义贴纸/图层 (PNG) */}
        <GlassPanel className="p-4 rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white/60 flex items-center gap-1.5 uppercase tracking-wider">
              <ImageIcon className="w-3.5 h-3.5" /> 自定义图片水印/徽标
            </h3>
            <button
              onClick={() => imageInputRef.current?.click()}
              className="text-[10px] bg-blue-500/20 text-blue-300 hover:bg-blue-500/40 px-2 py-1 rounded border border-blue-500/30 transition flex items-center gap-1"
            >
              <Plus className="w-3 h-3" /> 导入 PNG
            </button>
            <input
              type="file"
              accept="image/png"
              ref={imageInputRef}
              onChange={handleImageUpload}
              className="hidden"
            />
          </div>

          <div className="space-y-4">
            {(!settings.images || settings.images.length === 0) ? (
              <div className="text-[10px] text-white/40 text-center py-4">暂无图片标记，点击右上方导入</div>
            ) : (
              settings.images.map((imgElem, index) => (
                <div key={imgElem.id} className="space-y-2 pt-3 border-t border-white/5 first:border-0 first:pt-0 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <img src={imgElem.url} alt="thumbnail" className="w-8 h-8 object-contain bg-black/50 rounded border border-white/10" />
                    <div className="flex flex-col">
                      <span className="text-[10px] font-medium text-white/50">图层 {index + 1}: {imgElem.file.name.substring(0, 10)}</span>
                      <div className="flex items-center gap-1 mt-1">
                        <span className="text-[8px] text-white/40">缩放大小:</span>
                        <input
                          type="range"
                          min="0.01"
                          max="3"
                          step="0.01"
                          value={imgElem.scale}
                          onChange={e => updateImageElement(imgElem.id, { scale: parseFloat(e.target.value) || 1 })}
                          className="w-16 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500"
                        />
                        <input
                          type="number"
                          min="1"
                          max="300"
                          value={Math.round(imgElem.scale * 100)}
                          onChange={e => updateImageElement(imgElem.id, { scale: (parseFloat(e.target.value) || 100) / 100 })}
                          className="w-10 bg-zinc-800 rounded px-1 text-[10px] text-white outline-none text-right"
                        />
                        <span className="text-[10px] text-white/40">%</span>
                      </div>
                    </div>
                  </div>
                  <button
                    onClick={() => removeImageElement(imgElem.id)}
                    className="text-[10px] text-red-400 hover:text-red-300 hover:bg-red-500/10 px-1.5 py-0.5 rounded transition"
                  >
                    删除
                  </button>
                </div>
              ))
            )}
          </div>
        </GlassPanel>

        {/* 深度隐形消重引擎 */}
        <GlassPanel className="p-4 rounded-xl space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-semibold text-white/60 flex items-center gap-1.5 uppercase tracking-wider">
              <Film className="w-3.5 h-3.5" /> 深度隐形消重引擎
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                className="sr-only peer"
                checked={settings.antiDupConfig?.enabled || false}
                onChange={(e) => updateSettings({
                  antiDupConfig: {
                    ...(settings.antiDupConfig || { intensity: 'light' }),
                    enabled: e.target.checked
                  }
                })}
              />
              <div className="w-9 h-5 bg-white/10 peer-focus:outline-none rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:bg-orange-500"></div>
            </label>
          </div>

          {settings.antiDupConfig?.enabled && (
            <div className="space-y-3 pt-2 border-t border-white/5">
              <p className="text-[10px] text-white/40 leading-relaxed">
                引擎会在后台针对导出片段应用肉眼极难察觉的像素扰动与底层参数重构，以规避机器特征查重。
              </p>

              <div className="space-y-2">
                <span className="text-[10px] font-medium text-white/50">消重强度分级：</span>
                <div className="flex gap-2">
                  <button
                    onClick={() => updateSettings({ antiDupConfig: { ...settings.antiDupConfig, intensity: 'light' } })}
                    className={`flex-1 py-1.5 text-xs rounded border transition ${settings.antiDupConfig.intensity === 'light' ? 'bg-orange-500/20 text-orange-400 border-orange-500/50' : 'bg-black/40 text-white/60 border-white/10 hover:bg-white/5'}`}
                  >
                    轻度
                  </button>
                  <button
                    onClick={() => updateSettings({ antiDupConfig: { ...settings.antiDupConfig, intensity: 'medium' } })}
                    className={`flex-1 py-1.5 text-xs rounded border transition ${settings.antiDupConfig.intensity === 'medium' ? 'bg-orange-500/20 text-orange-400 border-orange-500/50' : 'bg-black/40 text-white/60 border-white/10 hover:bg-white/5'}`}
                  >
                    中度
                  </button>
                  <button
                    onClick={() => updateSettings({ antiDupConfig: { ...settings.antiDupConfig, intensity: 'heavy' } })}
                    className={`flex-1 py-1.5 text-xs rounded border transition ${settings.antiDupConfig.intensity === 'heavy' ? 'bg-orange-500/20 text-orange-400 border-orange-500/50' : 'bg-black/40 text-white/60 border-white/10 hover:bg-white/5'}`}
                  >
                    残暴
                  </button>
                </div>

                <div className="bg-black/40 border border-white/5 rounded p-2 mt-2">
                  <span className="text-[10px] text-white/40 leading-tight">
                    {settings.antiDupConfig.intensity === 'light' && '轻度：随机微调三色平衡，底层重编码去元数据。适合高质微幅二创。'}
                    {settings.antiDupConfig.intensity === 'medium' && '中度：含轻度效果，附加极度轻微(1~2%)的呼吸放大与随机画面位移截取。'}
                    {settings.antiDupConfig.intensity === 'heavy' && '残暴：含中度效果，附加毫秒级的时间轴随机伸缩微调，彻底撕裂音频波形与关键帧时间戳比对。'}
                  </span>
                </div>
              </div>
            </div>
          )}
        </GlassPanel>


        {/* 导出队列 */}
        <GlassPanel className="p-4 rounded-xl flex flex-col flex-1 min-h-[200px]">
          <h3 className="text-xs font-semibold text-white/60 mb-3 flex items-center gap-1.5 uppercase tracking-wider">
            <Download className="w-3.5 h-3.5" /> 产出队列
          </h3>

          <div className="flex-1 space-y-2 overflow-y-auto pr-1">
            {exports.length === 0 ? (
              <div className="flex items-center justify-between p-2 rounded bg-white/[0.03] border border-white/5 text-sm">
                <span className="text-white/80 truncate w-32">暂无导出任务</span>
              </div>
            ) : (
              exports.map(exp => (
                <div key={exp.id} className="p-3 rounded-lg bg-zinc-900/80 border border-white/10 space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-medium text-white/80">
                      {exp.status === 'idle' ? '⏳ 等待排队中...' :
                        exp.status === 'processing' ? '正在混剪合成...' :
                          exp.status === 'done' ? '✅ 视频生成完毕' : '❌ 发生异常'}
                    </span>
                    <span className="text-xs font-mono text-orange-400">
                      {exp.status === 'processing' ? `${Math.floor(exp.progress * 100)}%` : ''}
                    </span>
                  </div>

                  {exp.status === 'processing' && (
                    <div className="w-full bg-black/50 rounded-full h-1.5 overflow-hidden">
                      <div className="bg-orange-500 h-1.5 rounded-full transition-all duration-300" style={{ width: `${exp.progress * 100}%` }} />
                    </div>
                  )}

                  {exp.status === 'error' && (
                    <div className="text-[10px] text-red-400 leading-tight">
                      {exp.errorMessage}
                    </div>
                  )}

                  {exp.status === 'done' && exp.resultUrl && (
                    <div className="flex gap-2 pt-1 mt-2 border-t border-white/5">
                      <a href={exp.resultUrl} target="_blank" rel="noreferrer" className="flex-1 text-center py-1.5 bg-white/5 hover:bg-white/10 rounded border border-white/10 text-xs transition">
                        预览
                      </a>
                      <a href={exp.resultUrl} download={`${exp.createdAt}.mp4`} className="flex-1 flex items-center justify-center gap-1 py-1.5 bg-orange-500/20 text-orange-400 hover:bg-orange-500/30 rounded border border-orange-500/30 text-xs transition">
                        <Download className="w-3 h-3" /> 下载
                      </a>
                    </div>
                  )}
                </div>
              ))
            )}
          </div>

          <button
            onClick={handleDownloadZip}
            disabled={isZipping || exports.filter(e => e.status === 'done').length === 0}
            className={`mt-4 w-full h-9 border border-white/10 text-white rounded text-sm font-medium flex items-center justify-center gap-2 transition-colors ${isZipping ? 'bg-orange-500/50 cursor-wait' : 'bg-white/10 hover:bg-white/20'}`}
          >
            {isZipping ? (
              <span className="animate-pulse">正在打包压缩...</span>
            ) : (
              <><Archive className="w-4 h-4" />打包所有成品 (ZIP)</>
            )}
          </button>
        </GlassPanel>

      </div>
    </div>
  );
};


// ==========================================
// Main App Shell
// ==========================================
export default function App() {
  return (
    <div className="h-screen w-full flex flex-col bg-zinc-950 text-white overflow-hidden font-sans">
      <Header />
      <div className="flex-1 flex overflow-hidden">
        <MaterialPoolPanel />
        <WorkspaceArea />
        <SettingsPanel />
      </div>

      {/* 注入全局暗黑滚动条样式 */}
      <style dangerouslySetInnerHTML={{
        __html: `
        .custom-scrollbar::-webkit-scrollbar {
          width: 6px;
          height: 6px;
        }
        .custom-scrollbar::-webkit-scrollbar-track {
          background: rgba(255, 255, 255, 0.02); 
        }
        .custom-scrollbar::-webkit-scrollbar-thumb {
          background: rgba(255, 255, 255, 0.1); 
          border-radius: 4px;
        }
        .custom-scrollbar::-webkit-scrollbar-thumb:hover {
          background: rgba(255, 255, 255, 0.2); 
        }
      `}} />
    </div>
  );
}

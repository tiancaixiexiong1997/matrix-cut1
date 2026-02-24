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
  Layers, Archive, ChevronDown, ChevronRight, X, Copy
} from 'lucide-react';
import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import JSZip from 'jszip';
import { saveAs } from 'file-saver';

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
  fontSize: number;
  color: string;
  shadowColor: string;
  shadowOpacity: number;
  shadowBlur: number;
  shadowDistance: number;
  shadowAngle: number;
};

export type GlobalSettings = {
  mainTitle: string;
  subTitle: string;
  mainTitlePos: { x: number; y: number };
  subTitlePos: { x: number; y: number };
  mainTitleStyle: TextStyle;
  subTitleStyle: TextStyle;
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
    mainTitle: '为什么你做不出爆款？',
    subTitle: '掌握这个黄金三秒法则',
    mainTitlePos: { x: 0, y: -220 }, // 相对于中心的偏移
    subTitlePos: { x: 0, y: 220 },
    mainTitleStyle: { fontSize: 32, color: '#ffffff', shadowColor: '#000000', shadowOpacity: 0.9, shadowBlur: 15, shadowDistance: 5, shadowAngle: -45 },
    subTitleStyle: { fontSize: 24, color: '#fb923c', shadowColor: '#000000', shadowOpacity: 0.9, shadowBlur: 10, shadowDistance: 5, shadowAngle: -45 }
  },
  exports: [],
  ffmpegStatus: 'idle',

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

  addTimelineSegment: (poolId, duration = 2.5) => set((state) => ({
    timeline: [...state.timeline, { id: uuidv4(), poolId, duration }]
  })),

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
  const { pools, timeline, bgm, settings, addExportTask, updateExportTask } = store;

  if (timeline.length === 0) {
    alert("时间轴为空，无法导出！");
    return;
  }

  const totalExportDuration = timeline.reduce((acc, seg) => acc + seg.duration, 0);

  // 顺序执行队列以防 FFmpeg 内存崩溃
  for (let q = 0; q < quantity; q++) {
    // 如果用户点击了停止按鈕，跳出循环
    if (exportCancelSignal) break;
    // 1. 初始化任务
    const taskId = uuidv4();
    // 格式化当前时间为 "20260222_230809" 形式
    const now = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const createdAt = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    addExportTask({
      id: taskId,
      status: 'processing',
      progress: 0,
      resultUrl: null,
      createdAt,
    });

    try {
      const ff = await getFFmpeg();

      // 清理上一次的日志监听器，防止多开叠层
      ff.off('log', () => { });
      ff.off('progress', () => { });

      // 监听 ffmpeg 日志以便排查卡死问题，并手动计算 progress (防止 WASM 不派发 progress 事件)
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

      // 备用兜底 progress
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

      // 预写入字体文件，支持烧录中文文字
      await ff.writeFile('notosans.ttf', await fetchFile('/fonts/NotoSansSC-Black.ttf'));

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
        // 原视频降噪，使用 videoVolume
        filterComplex += `[${index}:v]trim=0:${input.duration},setpts=PTS-STARTPTS,scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2[v${index}]; `;
        filterComplex += `[${index}:a]atrim=0:${input.duration},asetpts=PTS-STARTPTS,volume=${bgm.videoVolume}[a${index}]; `;
        outSpecs.push(`[v${index}][a${index}]`);
      });

      // 拼接最终连片: concat 所有视频+音频
      const vStream = '[outv_raw]';
      filterComplex += `${outSpecs.join('')}concat=n=${inputs.length}:v=1:a=1${vStream}[outa_raw]; `;

      // 处理字幕与标题烧录 (Video Text Overlay)
      const drawTextFilters: string[] = [];
      const scaleMultiplier = 1920 / 600; // 预览界面基准高度约 600px，输出为 1920px，缩放比例为 3.2

      const addDrawText = (text: string, style: TextStyle, pos: { x: number, y: number }) => {
        if (!text || text.trim() === '') return;
        const fontcolor = style.color.replace('#', '0x') + 'FF';
        const shadowAlpha = Math.round(style.shadowOpacity * 255).toString(16).padStart(2, '0').toUpperCase();
        const shadowcolor = style.shadowColor.replace('#', '0x') + shadowAlpha;
        const shadowx = Math.round(style.shadowDistance * Math.cos(style.shadowAngle * Math.PI / 180) * scaleMultiplier);
        const shadowy = Math.round(style.shadowDistance * -Math.sin(style.shadowAngle * Math.PI / 180) * scaleMultiplier);

        const fontSize = Math.round(style.fontSize * scaleMultiplier);
        const offsetX = Math.round(pos.x * scaleMultiplier);
        const offsetY = Math.round(pos.y * scaleMultiplier);

        // 使用单引号闭合 text，并把用户可能输入的单引号替换为全角单引号防止截断
        const safeText = text.replace(/'/g, '’');
        const absX = `(w-tw)/2+${offsetX}`;
        const absY = `(h-th)/2+${offsetY}`;

        drawTextFilters.push(`drawtext=fontfile=notosans.ttf:text='${safeText}':fontcolor=${fontcolor}:fontsize=${fontSize}:x=${absX}:y=${absY}:shadowcolor=${shadowcolor}:shadowx=${shadowx}:shadowy=${shadowy}`);
      };

      addDrawText(settings.mainTitle, settings.mainTitleStyle, settings.mainTitlePos);
      addDrawText(settings.subTitle, settings.subTitleStyle, settings.subTitlePos);

      if (drawTextFilters.length > 0) {
        filterComplex += `${vStream}${drawTextFilters.join(',')}[outv]; `;
      } else {
        filterComplex += `${vStream}copy[outv]; `;
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

      // 组装所有 -i 参数 (视频 + 可选 BGM)
      const ffmpegArgs: string[] = [];
      inputs.forEach(i => {
        ffmpegArgs.push('-i', i.filename);
      });
      if (hasBgm) ffmpegArgs.push('-i', bgmFilename);

      ffmpegArgs.push('-filter_complex', filterComplex);
      ffmpegArgs.push('-map', '[outv]');
      ffmpegArgs.push('-map', '[outa]');

      // aac重编码确保音频正常播放
      ffmpegArgs.push('-c:v', 'libx264');
      ffmpegArgs.push('-c:a', 'aac');
      ffmpegArgs.push('-preset', 'ultrafast');
      ffmpegArgs.push('-pix_fmt', 'yuv420p'); // 增加色彩空间兼容性
      ffmpegArgs.push('output.mp4');

      console.log("Executing FFmpeg with args:", ffmpegArgs);

      // 5. 执行渲染
      const retCode = await ff.exec(ffmpegArgs);
      if (retCode !== 0) {
        throw new Error(`FFmpeg 执行失败，退出码: ${retCode}`);
      }

      // 6. 读取结果
      const outputData = await ff.readFile('output.mp4');
      const blob = new Blob([outputData as any], { type: 'video/mp4' });
      const resultUrl = URL.createObjectURL(blob);

      // 7. 清理内存，防止浏览器 OOM崩溃
      await ff.deleteFile('output.mp4');
      for (const input of inputs) {
        await ff.deleteFile(input.filename);
      }
      if (hasBgm && bgmFilename) {
        await ff.deleteFile(bgmFilename);
      }

      // 更新 UI 任务状态
      updateExportTask(taskId, {
        status: 'done',
        progress: 1,
        resultUrl
      });

    } catch (err: any) {
      console.error("FFmpeg Export Error: ", err);
      updateExportTask(taskId, {
        status: 'error',
        errorMessage: err.message || '导出视频时发生未知错误',
      });
    }
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
  text,
  pos,
  onPosChange,
  className
}: {
  text: React.ReactNode;
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
      {text}
    </div>
  );
};

const WorkspaceArea = () => {
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [previewIndices, setPreviewIndices] = useState<Record<string, number>>({});
  const [selectedSegIds, setSelectedSegIds] = useState<Set<string>>(new Set());
  const { timeline, pools, settings, bgm, addTimelineSegment, updateTimelineSegment, removeTimelineSegment, duplicateTimelineSegment, reorderTimelineSegments, updateSettings } = useStore();
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

          <DraggableOverlay
            text={
              <h2
                className="font-bold font-serif pointer-events-none text-center"
                style={{
                  fontSize: `${settings.mainTitleStyle.fontSize}px`,
                  color: settings.mainTitleStyle.color,
                  textShadow: `${settings.mainTitleStyle.shadowDistance * Math.cos(settings.mainTitleStyle.shadowAngle * Math.PI / 180)}px ${settings.mainTitleStyle.shadowDistance * -Math.sin(settings.mainTitleStyle.shadowAngle * Math.PI / 180)}px ${settings.mainTitleStyle.shadowBlur}px rgba(${parseInt(settings.mainTitleStyle.shadowColor.slice(1, 3), 16)}, ${parseInt(settings.mainTitleStyle.shadowColor.slice(3, 5), 16)}, ${parseInt(settings.mainTitleStyle.shadowColor.slice(5, 7), 16)}, ${settings.mainTitleStyle.shadowOpacity})`
                }}
              >
                {settings.mainTitle}
              </h2>
            }
            pos={settings.mainTitlePos}
            onPosChange={(pos) => updateSettings({ mainTitlePos: pos })}
          />
          <DraggableOverlay
            text={
              <p
                className="font-medium pointer-events-none text-center inline-block"
                style={{
                  fontSize: `${settings.subTitleStyle.fontSize}px`,
                  color: settings.subTitleStyle.color,
                  textShadow: `${settings.subTitleStyle.shadowDistance * Math.cos(settings.subTitleStyle.shadowAngle * Math.PI / 180)}px ${settings.subTitleStyle.shadowDistance * -Math.sin(settings.subTitleStyle.shadowAngle * Math.PI / 180)}px ${settings.subTitleStyle.shadowBlur}px rgba(${parseInt(settings.subTitleStyle.shadowColor.slice(1, 3), 16)}, ${parseInt(settings.subTitleStyle.shadowColor.slice(3, 5), 16)}, ${parseInt(settings.subTitleStyle.shadowColor.slice(5, 7), 16)}, ${settings.subTitleStyle.shadowOpacity})`
                }}
              >
                {settings.subTitle}
              </p>
            }
            pos={settings.subTitlePos}
            onPosChange={(pos) => updateSettings({ subTitlePos: pos })}
          />

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
  const { settings, exports, updateSettings } = useStore();
  const [isZipping, setIsZipping] = useState(false);

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
      await Promise.all(doneExports.map(async (exp, index) => {
        const response = await fetch(exp.resultUrl!);
        const blob = await response.blob();
        zip.file(`matrix_video_${index + 1}_${exp.id.slice(0, 4)}.mp4`, blob);
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

        {/* 文本覆盖 */}
        <GlassPanel className="p-4 rounded-xl space-y-4">
          <h3 className="text-xs font-semibold text-white/60 mb-2 flex items-center gap-1.5 uppercase tracking-wider">
            <Type className="w-3.5 h-3.5" /> 图文覆盖
          </h3>
          <div className="space-y-4">
            {/* 主标题设置 */}
            <div className="space-y-2">
              <label className="text-xs font-medium text-white/50 flex items-center justify-between">主标题内容</label>
              <input
                type="text"
                value={settings.mainTitle}
                onChange={e => updateSettings({ mainTitle: e.target.value })}
                className="w-full bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-sm text-white focus:outline-none focus:border-orange-500/50"
              />
              <div className="space-y-2 mt-2">
                <div className="flex bg-black/40 border border-white/10 rounded px-2 py-1 items-center justify-between">
                  <span className="text-[10px] text-white/40">字形参数</span>
                  <div className="flex items-center gap-2">
                    <input type="number" min="10" max="100" title="字号" value={settings.mainTitleStyle.fontSize} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, fontSize: parseInt(e.target.value) || 32 } })} className="w-12 bg-zinc-800 rounded px-1 text-[10px] text-white outline-none" />
                    <input type="color" title="颜色" value={settings.mainTitleStyle.color} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, color: e.target.value } })} className="w-6 h-4 bg-transparent cursor-pointer rounded-sm" />
                  </div>
                </div>

                <div className="bg-black/40 border border-white/10 rounded p-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-white/40 flex items-center gap-1">✅ 阴影高级配置</span>
                    <input type="color" value={settings.mainTitleStyle.shadowColor} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, shadowColor: e.target.value } })} className="w-5 h-4 bg-transparent cursor-pointer rounded-sm" />
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">不透明度</span>
                    <input type="range" min="0" max="1" step="0.05" value={settings.mainTitleStyle.shadowOpacity} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, shadowOpacity: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{Math.round(settings.mainTitleStyle.shadowOpacity * 100)}%</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">模糊度</span>
                    <input type="range" min="0" max="100" value={settings.mainTitleStyle.shadowBlur} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, shadowBlur: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{settings.mainTitleStyle.shadowBlur}%</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">距离</span>
                    <input type="range" min="0" max="100" value={settings.mainTitleStyle.shadowDistance} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, shadowDistance: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{settings.mainTitleStyle.shadowDistance}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">角度</span>
                    <input type="range" min="-180" max="180" value={settings.mainTitleStyle.shadowAngle} onChange={e => updateSettings({ mainTitleStyle: { ...settings.mainTitleStyle, shadowAngle: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{settings.mainTitleStyle.shadowAngle}°</span>
                  </div>
                </div>
              </div>
            </div>

            {/* 副标题设置 */}
            <div className="space-y-2 pt-3 border-t border-white/5">
              <label className="text-xs font-medium text-white/50 flex items-center justify-between">副标题内容</label>
              <input
                type="text"
                value={settings.subTitle}
                onChange={e => updateSettings({ subTitle: e.target.value })}
                className="w-full bg-black/40 border border-white/10 rounded px-2.5 py-1.5 text-sm text-orange-400 focus:outline-none focus:border-orange-500/50"
              />
              <div className="space-y-2 mt-2">
                <div className="flex bg-black/40 border border-white/10 rounded px-2 py-1 items-center justify-between">
                  <span className="text-[10px] text-white/40">字形参数</span>
                  <div className="flex items-center gap-2">
                    <input type="number" min="10" max="100" title="字号" value={settings.subTitleStyle.fontSize} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, fontSize: parseInt(e.target.value) || 24 } })} className="w-12 bg-zinc-800 rounded px-1 text-[10px] text-white outline-none" />
                    <input type="color" title="颜色" value={settings.subTitleStyle.color} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, color: e.target.value } })} className="w-6 h-4 bg-transparent cursor-pointer rounded-sm" />
                  </div>
                </div>

                <div className="bg-black/40 border border-white/10 rounded p-2 space-y-3">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] text-white/40 flex items-center gap-1">✅ 阴影高级配置</span>
                    <input type="color" value={settings.subTitleStyle.shadowColor} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, shadowColor: e.target.value } })} className="w-5 h-4 bg-transparent cursor-pointer rounded-sm" />
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">不透明度</span>
                    <input type="range" min="0" max="1" step="0.05" value={settings.subTitleStyle.shadowOpacity} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, shadowOpacity: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{Math.round(settings.subTitleStyle.shadowOpacity * 100)}%</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">模糊度</span>
                    <input type="range" min="0" max="100" value={settings.subTitleStyle.shadowBlur} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, shadowBlur: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{settings.subTitleStyle.shadowBlur}%</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">距离</span>
                    <input type="range" min="0" max="100" value={settings.subTitleStyle.shadowDistance} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, shadowDistance: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{settings.subTitleStyle.shadowDistance}</span>
                  </div>

                  <div className="flex items-center gap-2">
                    <span className="text-[10px] text-white/40 w-12 shrink-0">角度</span>
                    <input type="range" min="-180" max="180" value={settings.subTitleStyle.shadowAngle} onChange={e => updateSettings({ subTitleStyle: { ...settings.subTitleStyle, shadowAngle: parseFloat(e.target.value) || 0 } })} className="flex-1 h-1 bg-zinc-800 rounded-lg appearance-none cursor-pointer accent-orange-500" />
                    <span className="text-[10px] text-white/40 w-8 text-right">{settings.subTitleStyle.shadowAngle}°</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
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
                      {exp.status === 'processing' ? '正在混剪合成...' : exp.status === 'done' ? '✅ 视频生成完毕' : '❌ 发生异常'}
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

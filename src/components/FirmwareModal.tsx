import React, { useState } from 'react';
import {
  downloadTDeckFirmwareZip,
  TDECK_MAIN_CPP,
  TDECK_PLATFORMIO_INI,
  TDECK_README_MD,
} from '../firmware/tdeckFirmware';
import { WorldState } from '../sim/types';
import { downloadMemoryFile, RECORD_BYTES } from '../sim/memoryStore';
import { Check, Copy, Download, RotateCcw, X } from 'lucide-react';

interface FirmwareModalProps {
  worldRef: React.MutableRefObject<WorldState>;
  selectedAI: number;
  onClose: () => void;
  onResetWorld: () => void;
}

type CodeTab = 'main.cpp' | 'platformio.ini' | 'README.md';

export function FirmwareModal({
  worldRef,
  selectedAI,
  onClose,
  onResetWorld,
}: FirmwareModalProps) {
  const [tab, setTab] = useState<CodeTab>('main.cpp');
  const [copied, setCopied] = useState(false);

  const state = worldRef.current;
  const ai = state.ais[selectedAI];
  const codeText =
    tab === 'main.cpp'
      ? TDECK_MAIN_CPP
      : tab === 'platformio.ini'
      ? TDECK_PLATFORMIO_INI
      : TDECK_README_MD;

  const handleCopy = () => {
    navigator.clipboard.writeText(codeText).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-[#05080d]/90">
      <div className="w-full max-w-4xl max-h-[88vh] flex flex-col bg-[#0d121a] border border-slate-700/80 shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="px-5 py-4 border-b border-slate-800 flex items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              LilyGO T-Deck Plus ESP32-S3 Firmware & Menu
            </h2>
            <p className="mt-0.5 font-mono text-xs text-slate-400">
              PlatformIO · ESP32-S3 16MB + OPI PSRAM · ST7789 320×240 · MicroSD /memories/*.dat
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 text-slate-400 hover:text-white border border-slate-800 hover:border-slate-600 transition-colors"
            aria-label="Close modal"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Primary Export Actions */}
        <div className="px-5 py-3.5 bg-[#090d14] border-b border-slate-800 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={downloadTDeckFirmwareZip}
              className="flex items-center gap-2 px-4 py-2 text-xs font-semibold bg-cyan-400 text-slate-950 hover:bg-cyan-300 transition-colors"
            >
              <Download className="w-4 h-4" />
              Download Flashable Project (.zip)
            </button>
            {ai && (
              <button
                type="button"
                onClick={() => downloadMemoryFile(ai)}
                className="flex items-center gap-1.5 px-3 py-2 text-xs font-mono text-slate-200 bg-[#141c28] border border-slate-700 hover:border-cyan-500/60 transition-colors"
              >
                <Download className="w-3.5 h-3.5 text-cyan-400" />
                {ai.name}.dat ({ai.sdRecordCount * RECORD_BYTES}B)
              </button>
            )}
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                onResetWorld();
                onClose();
              }}
              className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-rose-300 bg-rose-950/35 border border-rose-800/60 hover:bg-rose-950/60 transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              Reset Continent
            </button>
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-2 text-xs font-medium text-slate-200 bg-[#141c28] border border-slate-700 hover:border-slate-500 transition-colors"
            >
              Resume
            </button>
          </div>
        </div>

        {/* File Tabs + Copy */}
        <div className="px-5 py-2 bg-[#0b0f17] border-b border-slate-800 flex items-center justify-between gap-2">
          <div className="flex items-center gap-1">
            {(['main.cpp', 'platformio.ini', 'README.md'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`px-3 py-1 font-mono text-xs border transition-colors ${
                  tab === t
                    ? 'bg-slate-800 text-cyan-300 border-cyan-500/60'
                    : 'bg-transparent text-slate-400 border-transparent hover:text-slate-200'
                }`}
              >
                {t}
              </button>
            ))}
          </div>

          <button
            type="button"
            onClick={handleCopy}
            className="flex items-center gap-1.5 px-2.5 py-1 font-mono text-xs text-slate-300 hover:text-white border border-slate-800 hover:border-slate-600 transition-colors"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
            {copied ? 'Copied' : 'Copy File'}
          </button>
        </div>

        {/* Firmware Source Viewer */}
        <div className="flex-1 overflow-auto bg-[#070a0f] p-4">
          <pre className="font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre">
            {codeText}
          </pre>
        </div>

        {/* Flash Command Strip */}
        <div className="px-5 py-2.5 bg-[#0b0f17] border-t border-slate-800 font-mono text-[11px] text-slate-400 flex flex-wrap items-center justify-between gap-2">
          <span>
            Build: <span className="text-cyan-300">unzip tdeck-world-esp32.zip &amp;&amp; cd tdeck-world-esp32 &amp;&amp; pio run</span>
          </span>
          <span>
            Shared SPI Guard: <span className="text-emerald-400">TFT_CS=12 · LORA_CS=9 · SD_CS=39</span>
          </span>
        </div>
      </div>
    </div>
  );
}

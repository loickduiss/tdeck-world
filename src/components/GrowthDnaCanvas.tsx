import React, { useEffect, useRef } from 'react';
import { WorldState } from '../sim/types';

interface GrowthDnaCanvasProps {
  worldRef: React.MutableRefObject<WorldState>;
  selectedAI: number;
  className?: string;
}

export function GrowthDnaCanvas({ worldRef, selectedAI, className = '' }: GrowthDnaCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let rafId = 0;

    const render = () => {
      const canvas = canvasRef.current;
      if (!canvas) {
        rafId = requestAnimationFrame(render);
        return;
      }
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(120, Math.floor(rect.width));
      const h = Math.max(90, Math.floor(rect.height));
      if (canvas.width !== Math.floor(w * dpr) || canvas.height !== Math.floor(h * dpr)) {
        canvas.width = Math.floor(w * dpr);
        canvas.height = Math.floor(h * dpr);
      }

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        rafId = requestAnimationFrame(render);
        return;
      }

      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#070b12';
      ctx.fillRect(0, 0, w, h);

      const state = worldRef.current;
      const a = state.ais[selectedAI];
      if (!a || !a.alive) {
        ctx.fillStyle = '#64748b';
        ctx.font = '12px "IBM Plex Mono", monospace';
        ctx.textAlign = 'center';
        ctx.fillText('No active neural core', w / 2, h / 2);
        ctx.restore();
        rafId = requestAnimationFrame(render);
        return;
      }

      const cx = w / 2;
      const cy = h / 2;
      const maxR = Math.min(w, h) * 0.42;

      const seed =
        (a.name.charCodeAt(0) || 65) * 73 +
        (a.name.charCodeAt(1) || 65) * 97 +
        (a.name.charCodeAt(2) || 65) * 131;
      const baseRot = ((seed & 0xff) / 256) * Math.PI * 2;
      const targetNodes = Math.max(2, Math.min(20, Math.floor(a.soul / 9) + 2));
      const t = performance.now() * 0.0014;

      // Subtle concentric reference rings
      ctx.strokeStyle = 'rgba(30, 41, 59, 0.55)';
      ctx.lineWidth = 1;
      for (let ring = 1; ring <= 3; ring++) {
        ctx.beginPath();
        ctx.arc(cx, cy, (maxR * ring) / 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Drifting ambient RAM sparks
      ctx.fillStyle = 'rgba(56, 189, 248, 0.45)';
      for (let i = 0; i < 8; i++) {
        const sp = baseRot + i * 1.37;
        const sx = cx + Math.cos(t * 0.6 + sp) * maxR * 0.92;
        const sy = cy + Math.sin(t * 0.5 + sp * 1.3) * maxR * 0.92;
        ctx.fillRect(sx, sy, 2, 2);
      }

      // Compute node coordinates
      const nodes: { x: number; y: number }[] = [];
      for (let i = 0; i < targetNodes; i++) {
        const ang = baseRot + (i * Math.PI * 2) / targetNodes;
        const r = maxR * (0.28 + 0.72 * ((i + 1) / targetNodes));
        const breath = Math.sin(t * 1.4 + i * 0.7) * 3.0;
        nodes.push({
          x: cx + Math.cos(ang) * (r + breath),
          y: cy + Math.sin(ang) * (r + breath),
        });
      }

      // Synaptic edges
      for (let i = 0; i < targetNodes; i++) {
        const j = (i * 3 + 1) % targetNodes;
        if (j === i) continue;
        const activeFlash = (state.tick + i * 7) % 60 < 8;
        ctx.strokeStyle = activeFlash ? 'rgba(34, 211, 238, 0.85)' : 'rgba(51, 65, 85, 0.65)';
        ctx.lineWidth = activeFlash ? 1.6 : 1;
        ctx.beginPath();
        ctx.moveTo(nodes[i].x, nodes[i].y);
        ctx.lineTo(nodes[j].x, nodes[j].y);
        ctx.stroke();

        // Also connect inner nodes to core
        if (i % 3 === 0) {
          ctx.strokeStyle = 'rgba(30, 58, 95, 0.55)';
          ctx.beginPath();
          ctx.moveTo(cx, cy);
          ctx.lineTo(nodes[i].x, nodes[i].y);
          ctx.stroke();
        }
      }

      // RAM cell nodes
      for (let i = 0; i < targetNodes; i++) {
        const flash = (state.tick + i * 11) % 90 < 6;
        const nr = flash ? 4.2 : 2.6;
        ctx.fillStyle = flash ? '#e0f2fe' : '#38bdf8';
        ctx.beginPath();
        ctx.arc(nodes[i].x, nodes[i].y, nr, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.5)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(nodes[i].x, nodes[i].y, nr + 2.5, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Breathing soul core
      const coreR = 4.5 + Math.sin(t * 2.2) * 1.5;
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#22d3ee';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(cx, cy, coreR + 4, 0, Math.PI * 2);
      ctx.stroke();

      ctx.restore();
      rafId = requestAnimationFrame(render);
    };

    rafId = requestAnimationFrame(render);
    return () => cancelAnimationFrame(rafId);
  }, [worldRef, selectedAI]);

  return (
    <canvas
      ref={canvasRef}
      className={`block w-full h-full bg-[#070b12] ${className}`}
    />
  );
}

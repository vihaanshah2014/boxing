"use client";

import React, { useEffect, useRef, useState } from "react";
import * as poseDetection from "@tensorflow-models/pose-detection";
import * as tf from "@tensorflow/tfjs-core";

type WristSide = "left" | "right";

type PunchStats = {
  total: number;
  lastSpeed: number; // normalized units / s
  lastPower: number; // arbitrary units
};

function distance(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

function getKeypoint(
  keypoints: poseDetection.Keypoint[] | undefined,
  name: string
) {
  if (!keypoints) return undefined;
  return keypoints.find((k) => k.name === name || k.part === name);
}

export default function CameraPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftStats, setLeftStats] = useState<PunchStats>({
    total: 0,
    lastSpeed: 0,
    lastPower: 0,
  });
  const [rightStats, setRightStats] = useState<PunchStats>({
    total: 0,
    lastSpeed: 0,
    lastPower: 0,
  });

  // previous frame cache
  const prevRef = useRef<{
    t: number;
    left?: { x: number; y: number };
    right?: { x: number; y: number };
    leftDistToShoulder?: number;
    rightDistToShoulder?: number;
    leftCooldownUntil?: number;
    rightCooldownUntil?: number;
  }>({ t: 0 });

  useEffect(() => {
    let detector: poseDetection.PoseDetector | null = null;
    let raf = 0;
    let cancelled = false;

    async function setup() {
      try {
        // Load and register the WebGL backend only once (avoids dev HMR warnings)
        const g = globalThis as any;
        if (!g.__TFJS_WEBGL_REGISTERED__) {
          await import("@tensorflow/tfjs-backend-webgl");
          g.__TFJS_WEBGL_REGISTERED__ = true;
        }

        await tf.setBackend("webgl");
        await tf.ready();

        // Get camera
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream as MediaStream;
        await videoRef.current.play();

        // Create detector (MoveNet)
        detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          {
            // Valid options: 'SinglePose.Lightning' | 'SinglePose.Thunder' | 'MultiPose.Lightning'
            modelType: "SinglePose.Lightning",
            enableSmoothing: true,
          } as poseDetection.MoveNetModelConfig
        );

        setReady(true);
        loop();
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
      }
    }

    async function loop() {
      if (cancelled) return;
      raf = requestAnimationFrame(loop);
      if (!detector || !videoRef.current || !canvasRef.current) return;

      const video = videoRef.current;
      const canvas = canvasRef.current;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Resize canvas to video
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      // Run pose detection
      const poses = await detector.estimatePoses(video, { flipHorizontal: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw video behind canvas for convenience
      ctx.save();
      ctx.globalAlpha = 1;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      ctx.restore();

      if (poses?.[0]) {
        drawOverlay(ctx, poses[0]);
        computePunches(poses[0]);
      }
    }

    function drawOverlay(ctx: CanvasRenderingContext2D, pose: poseDetection.Pose) {
      const kps = pose.keypoints?.filter((k) => (k.score ?? 0) > 0.3) || [];

      // draw keypoints
      for (const kp of kps) {
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#22c55e"; // green
        ctx.fill();
      }

      // draw simple connections (shoulders to wrists via elbows)
      const leftShoulder = getKeypoint(pose.keypoints, "left_shoulder");
      const rightShoulder = getKeypoint(pose.keypoints, "right_shoulder");
      const leftElbow = getKeypoint(pose.keypoints, "left_elbow");
      const rightElbow = getKeypoint(pose.keypoints, "right_elbow");
      const leftWrist = getKeypoint(pose.keypoints, "left_wrist");
      const rightWrist = getKeypoint(pose.keypoints, "right_wrist");

      ctx.strokeStyle = "#60a5fa"; // blue
      ctx.lineWidth = 3;
      function line(a?: poseDetection.Keypoint, b?: poseDetection.Keypoint) {
        if (!a || !b) return;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }
      line(leftShoulder!, leftElbow!);
      line(leftElbow!, leftWrist!);
      line(rightShoulder!, rightElbow!);
      line(rightElbow!, rightWrist!);
    }

    function computePunches(pose: poseDetection.Pose) {
      const now = performance.now();
      const kps = pose.keypoints || [];
      const ls = getKeypoint(kps, "left_shoulder");
      const rs = getKeypoint(kps, "right_shoulder");
      const lw = getKeypoint(kps, "left_wrist");
      const rw = getKeypoint(kps, "right_wrist");

      if (!ls || !rs || !lw || !rw) return;

      const shoulderSpan = distance(
        { x: ls.x, y: ls.y },
        { x: rs.x, y: rs.y }
      );
      const norm = Math.max(shoulderSpan, 1);

      const dt = Math.max((now - (prevRef.current.t || now)) / 1000, 1 / 120);
      const prev = prevRef.current;

      // compute for each side
      const sides: WristSide[] = ["left", "right"];
      for (const side of sides) {
        const wrist = side === "left" ? lw : rw;
        const shoulder = side === "left" ? ls : rs;
        const prevWrist = prev[side];
        const prevDist = side === "left" ? prev.leftDistToShoulder : prev.rightDistToShoulder;

        const cur = { x: wrist.x, y: wrist.y };
        const distToShoulder = distance(cur, { x: shoulder.x, y: shoulder.y });
        const distNorm = distToShoulder / norm;

        if (prevWrist) {
          const dpx = distance(cur, prevWrist);
          const speed = (dpx / norm) / dt; // normalized units/sec
          const extending = prevDist !== undefined ? distToShoulder > prevDist : false;

          // naive power: speed * extension factor
          const power = speed * Math.max(0.5, Math.min(1.5, distNorm));

          const cooldownUntil = side === "left" ? prev.leftCooldownUntil : prev.rightCooldownUntil;
          const inCooldown = (cooldownUntil || 0) > now;

          const threshold = 2.0; // tweakable
          const isPunchLike = speed > threshold && extending && !inCooldown;

          if (isPunchLike) {
            if (side === "left") {
              setLeftStats((s) => ({ total: s.total + 1, lastSpeed: speed, lastPower: power }));
              prev.leftCooldownUntil = now + 300; // ms
            } else {
              setRightStats((s) => ({ total: s.total + 1, lastSpeed: speed, lastPower: power }));
              prev.rightCooldownUntil = now + 300;
            }
          } else {
            if (side === "left") {
              setLeftStats((s) => ({ ...s, lastSpeed: speed, lastPower: power }));
            } else {
              setRightStats((s) => ({ ...s, lastSpeed: speed, lastPower: power }));
            }
          }
        }

        if (side === "left") {
          prev.left = cur;
          prev.leftDistToShoulder = distToShoulder;
        } else {
          prev.right = cur;
          prev.rightDistToShoulder = distToShoulder;
        }
      }

      prev.t = now;
    }

    setup();
    return () => {
      cancelled = true;
      if (raf) cancelAnimationFrame(raf);
      const stream = videoRef.current?.srcObject as MediaStream | undefined;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  return (
    <div className="min-h-screen p-6 flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">Boxing Camera: Punch Tracking</h1>

      {error && (
        <div className="text-red-600">Error: {error}</div>
      )}

      <div className="grid gap-4 grid-cols-1 md:grid-cols-3 items-start">
        <div className="md:col-span-2 relative w-full max-w-[1280px]">
          <video ref={videoRef} className="hidden" playsInline muted />
          <canvas ref={canvasRef} className="w-full rounded-lg shadow border" />
        </div>
        <div className="flex flex-col gap-3 p-4 border rounded-lg shadow bg-white/50 dark:bg-black/20">
          <h2 className="text-lg font-medium">Live Stats</h2>
          <div className="grid grid-cols-2 gap-3">
            <div className="p-3 rounded border">
              <div className="text-sm text-gray-500">Left punches</div>
              <div className="text-2xl font-bold">{leftStats.total}</div>
              <div className="text-xs mt-1">Speed: {leftStats.lastSpeed.toFixed(2)} u/s</div>
              <div className="text-xs">Power: {leftStats.lastPower.toFixed(2)}</div>
            </div>
            <div className="p-3 rounded border">
              <div className="text-sm text-gray-500">Right punches</div>
              <div className="text-2xl font-bold">{rightStats.total}</div>
              <div className="text-xs mt-1">Speed: {rightStats.lastSpeed.toFixed(2)} u/s</div>
              <div className="text-xs">Power: {rightStats.lastPower.toFixed(2)}</div>
            </div>
          </div>
          <div className="text-xs text-gray-500">
            Speed units are normalized by shoulder width; power is a rough heuristic.
          </div>
          <a className="text-blue-600 underline" href="/">← Back home</a>
        </div>
      </div>
      {!ready && !error && (
        <div className="text-gray-600">Initializing camera and model… Allow camera access.</div>
      )}
    </div>
  );
}

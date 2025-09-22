"use client";

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as poseDetection from "@tensorflow-models/pose-detection";
import * as tf from "@tensorflow/tfjs-core";

type WristSide = "left" | "right";

type PunchStats = {
  total: number;
  lastSpeed: number; // normalized units / s
  lastPower: number; // arbitrary units
  lastPercent: number; // 0-150 vs rolling baseline
};

type HandDebug = {
  completion: number;
  speed: number;
  speedThreshold: number;
  movingForward: boolean;
  movingBackward: boolean;
  rangeNorm: number;
  extensionNorm: number;
  triggerNorm: number;
  restNorm: number;
  reasons: string[];
  active: boolean;
};

const HISTORY_SIZE = 50; // punches retained per side
const PERCENTILE = 0.9; // rolling baseline percentile
const AVG_WINDOW = 10; // average window for fatigue

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
  return keypoints.find((k) => k.name === name || (k as any).part === name);
}

export default function CameraPunchTracker() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [leftStats, setLeftStats] = useState<PunchStats>({
    total: 0,
    lastSpeed: 0,
    lastPower: 0,
    lastPercent: 0,
  });
  const [rightStats, setRightStats] = useState<PunchStats>({
    total: 0,
    lastSpeed: 0,
    lastPower: 0,
    lastPercent: 0,
  });
  const [calibrationStatus, setCalibrationStatus] = useState<"waiting" | "collecting" | "complete">("waiting");
  const calibrationStatusRef = useRef<"waiting" | "collecting" | "complete">("waiting");
  const emptyDebug: HandDebug = {
    completion: 0,
    speed: 0,
    speedThreshold: 0,
    movingForward: false,
    movingBackward: false,
    rangeNorm: 0,
    extensionNorm: 0,
    triggerNorm: 0,
    restNorm: 0,
    reasons: ["waiting"],
    active: false,
  };
  const [leftDebug, setLeftDebug] = useState<HandDebug>(emptyDebug);
  const [rightDebug, setRightDebug] = useState<HandDebug>(emptyDebug);
  const setCalibrationStatusSafe = useCallback((next: "waiting" | "collecting" | "complete") => {
    if (calibrationStatusRef.current === next) return;
    calibrationStatusRef.current = next;
    setCalibrationStatus(next);
  }, [setCalibrationStatus]);

  // rolling history arrays (punch powers only when a punch is detected)
  const leftHistoryRef = useRef<number[]>([]);
  const rightHistoryRef = useRef<number[]>([]);

  // hydrate history from localStorage (expires after 30min)
  useEffect(() => {
    try {
      const raw = localStorage.getItem("punchHistoryV1");
      if (raw) {
        const parsed = JSON.parse(raw) as { t: number; left: number[]; right: number[] };
        if (Date.now() - parsed.t < 30 * 60 * 1000) {
          leftHistoryRef.current = (parsed.left || []).slice(-HISTORY_SIZE);
          rightHistoryRef.current = (parsed.right || []).slice(-HISTORY_SIZE);
        }
      }
    } catch {}
  }, []);

  function saveHistory() {
    try {
      localStorage.setItem(
        "punchHistoryV1",
        JSON.stringify({ t: Date.now(), left: leftHistoryRef.current, right: rightHistoryRef.current })
      );
    } catch {}
  }

  function pushHistory(side: WristSide, power: number) {
    const ref = side === "left" ? leftHistoryRef : rightHistoryRef;
    ref.current.push(power);
    if (ref.current.length > HISTORY_SIZE) ref.current.shift();
    saveHistory();
  }

  function percentile(arr: number[], p: number) {
    if (!arr.length) return 0;
    const a = [...arr].sort((x, y) => x - y);
    const i = Math.min(a.length - 1, Math.max(0, Math.floor(p * (a.length - 1))));
    return a[i];
  }

  function computePercent(power: number, hist: number[]) {
    const base = Math.max(0.001, percentile(hist, PERCENTILE) || Math.max(...hist, power));
    const pct = Math.round((power / base) * 100);
    return Math.max(0, Math.min(150, pct));
  }

  const prevRef = useRef<{
    t: number;
    left?: { x: number; y: number };
    right?: { x: number; y: number };
    leftDistToShoulder?: number;
    rightDistToShoulder?: number;
    leftPunchDetected?: boolean;
    rightPunchDetected?: boolean;
    leftMaxExtension?: number;
    rightMaxExtension?: number;
    leftSpeedHistory?: number[];
    rightSpeedHistory?: number[];
    calibrated?: boolean;
    leftRestExtension?: number;
    rightRestExtension?: number;
    leftRangeNorm?: number;
    rightRangeNorm?: number;
    leftFiltered?: { x: number; y: number };
    rightFiltered?: { x: number; y: number };
    leftNoiseSpeed?: number;
    rightNoiseSpeed?: number;
    leftCooldownUntil?: number;
    rightCooldownUntil?: number;
    prevLeftShoulder?: { x: number; y: number };
    prevRightShoulder?: { x: number; y: number };
  }>({ t: 0 });

  useEffect(() => {
    let detector: poseDetection.PoseDetector | null = null;
    let raf = 0;
    let cancelled = false;

    async function setup() {
      try {
        const g = globalThis as any;
        if (!g.__TFJS_WEBGL_REGISTERED__) {
          await import("@tensorflow/tfjs-backend-webgl");
          g.__TFJS_WEBGL_REGISTERED__ = true;
        }

        await tf.setBackend("webgl");
        await tf.ready();

        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
          audio: false,
        });
        if (!videoRef.current) return;
        videoRef.current.srcObject = stream as MediaStream;
        await videoRef.current.play();

        detector = await poseDetection.createDetector(
          poseDetection.SupportedModels.MoveNet,
          {
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

      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
      }

      const poses = await detector.estimatePoses(video, { flipHorizontal: true });
      ctx.clearRect(0, 0, canvas.width, canvas.height);
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
      for (const kp of kps) {
        ctx.beginPath();
        ctx.arc(kp.x, kp.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = "#22c55e";
        ctx.fill();
      }
      const leftShoulder = getKeypoint(pose.keypoints, "left_shoulder");
      const rightShoulder = getKeypoint(pose.keypoints, "right_shoulder");
      const leftElbow = getKeypoint(pose.keypoints, "left_elbow");
      const rightElbow = getKeypoint(pose.keypoints, "right_elbow");
      const leftWrist = getKeypoint(pose.keypoints, "left_wrist");
      const rightWrist = getKeypoint(pose.keypoints, "right_wrist");

      ctx.strokeStyle = "#60a5fa";
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
      const le = getKeypoint(kps, "left_elbow");
      const re = getKeypoint(kps, "right_elbow");

      if (!prevRef || !prevRef.current) return;
      const prev = prevRef.current;

      const minShoulderScore = 0.15;
      const minWristScore = 0.05;
      // Require shoulders to be present with minimal confidence
      if (!ls || !rs) {
        const dbg: HandDebug = {
          completion: 0,
          speed: 0,
          speedThreshold: 0,
          movingForward: false,
          movingBackward: false,
          rangeNorm: 0,
          extensionNorm: 0,
          triggerNorm: 0,
          restNorm: 0,
          reasons: ["shoulders missing"],
          active: false,
        };
        setLeftDebug(dbg);
        setRightDebug(dbg);
        prev.t = now;
        return;
      }
      if ((ls.score ?? 0) < minShoulderScore || (rs.score ?? 0) < minShoulderScore) {
        const dbg: HandDebug = {
          completion: 0,
          speed: 0,
          speedThreshold: 0,
          movingForward: false,
          movingBackward: false,
          rangeNorm: 0,
          extensionNorm: 0,
          triggerNorm: 0,
          restNorm: 0,
          reasons: ["low shoulder confidence"],
          active: false,
        };
        setLeftDebug(dbg);
        setRightDebug(dbg);
        prev.t = now;
        return;
      }

      const leftShoulderPt = { x: ls.x, y: ls.y };
      const rightShoulderPt = { x: rs.x, y: rs.y };
      const shoulderSpan = distance(leftShoulderPt, rightShoulderPt);
      const norm = Math.max(shoulderSpan, 1);
      // Basic torso/ camera stability check
      const prevLeftSh = prev.prevLeftShoulder ?? leftShoulderPt;
      const prevRightSh = prev.prevRightShoulder ?? rightShoulderPt;
      const shMove = (distance(leftShoulderPt, prevLeftSh) + distance(rightShoulderPt, prevRightSh)) / (2 * norm);
      const torsoStable = shMove < 0.08;
      prev.prevLeftShoulder = leftShoulderPt;
      prev.prevRightShoulder = rightShoulderPt;

      const dt = Math.max((now - (prev.t || now)) / 1000, 1 / 120);
      const sides: WristSide[] = ["left", "right"];
      const potentialPunches: Array<{ side: WristSide; speed: number; power: number }> = [];

      for (const side of sides) {
        // Prefer wrist; fall back to elbow when wrist is missing/low confidence
        const wrist = side === "left" ? lw : rw;
        const elbow = side === "left" ? le : re;
        // Prefer wrist; fall back to elbow; finally fall back to previous hand position
        let hand = (wrist && (wrist.score ?? 0) >= minWristScore) ? wrist : elbow;
        const shoulder = side === "left" ? ls : rs;
        const prevWrist = prev[side];
        const prevDist = side === "left" ? prev.leftDistToShoulder : prev.rightDistToShoulder;

        if (!hand) {
          // Fallback to previous frame hand position if available
          const prevHand = prevWrist;
          if (prevHand) {
            hand = { x: prevHand.x, y: prevHand.y, score: 0.0 } as any;
          }
        }

        if (!hand) {
          const dbg: HandDebug = {
            completion: 0,
            speed: 0,
            speedThreshold: 0,
            movingForward: false,
            movingBackward: false,
            rangeNorm: prev[rangeNormKey] ?? 0,
            extensionNorm: 0,
            triggerNorm: 0,
            restNorm: 0,
            reasons: ["hand keypoint missing"],
            active: prev[punchFlagKey] || false,
          };
          if (side === "left") setLeftDebug(dbg); else setRightDebug(dbg);
          // still update prev hand position using shoulder so dt progresses
          const proxy = { x: shoulder.x, y: shoulder.y };
          if (side === "left") { prev.left = proxy; prev.leftDistToShoulder = 0; } else { prev.right = proxy; prev.rightDistToShoulder = 0; }
          continue;
        }

        const curRaw = { x: hand.x, y: hand.y };
        const filteredKey = side === "left" ? "leftFiltered" : "rightFiltered";
        const prevFiltered = prev[filteredKey] ?? (prevWrist ? { x: prevWrist.x, y: prevWrist.y } : curRaw);
        const smAlpha = 0.6;
        const cur = {
          x: prevFiltered.x * smAlpha + curRaw.x * (1 - smAlpha),
          y: prevFiltered.y * smAlpha + curRaw.y * (1 - smAlpha),
        };
        prev[filteredKey] = cur;
        const distToShoulder = distance(cur, { x: shoulder.x, y: shoulder.y });

        const restKey = side === "left" ? "leftRestExtension" : "rightRestExtension";
        const maxKey = side === "left" ? "leftMaxExtension" : "rightMaxExtension";
        const speedHistoryKey = side === "left" ? "leftSpeedHistory" : "rightSpeedHistory";
        const punchFlagKey = side === "left" ? "leftPunchDetected" : "rightPunchDetected";
        const rangeNormKey = side === "left" ? "leftRangeNorm" : "rightRangeNorm";

        let rest = prev[restKey] ?? distToShoulder;
        let maxExt = prev[maxKey] ?? distToShoulder;
        if (!prev[speedHistoryKey]) prev[speedHistoryKey] = [];
        const speedHistory = prev[speedHistoryKey]!;

        // Compute speed using filtered positions and forward projection
        let speed = 0;
        let speedFwd = 0;
        {
          const prevPoint = prevFiltered;
          const travel = distance(cur, prevPoint);
          const outward = { x: cur.x - shoulder.x, y: cur.y - shoulder.y };
          const outwardLen = Math.hypot(outward.x, outward.y) || 1;
          const dirX = outward.x / outwardLen;
          const dirY = outward.y / outwardLen;
          const step = { x: cur.x - prevPoint.x, y: cur.y - prevPoint.y };
          const proj = step.x * dirX + step.y * dirY;
          speed = (travel / norm) / dt;
          speedFwd = (Math.max(0, proj) / norm) / dt;
        }
        speedHistory.push(speed);
        if (speedHistory.length > 5) speedHistory.shift();
        const peakSpeed = speedHistory.reduce((maxValue, value) => (value > maxValue ? value : maxValue), 0);

        const deltaDist = prevDist !== undefined ? distToShoulder - prevDist : 0;
        const forwardGate = Math.max(norm * 0.003, (maxExt - rest) * 0.03);
        const movingForward = speedFwd > (prev[rangeNormKey] ? 0.3 : 0.15) && deltaDist > forwardGate;
        const movingBackward = deltaDist < -forwardGate && speedFwd < 0.2;

        if (!torsoStable) {
          // Skip dynamic updates if the torso/camera is moving too much
          const dbg: HandDebug = {
            completion: 0,
            speed: speedFwd,
            speedThreshold: 0.6,
            movingForward: false,
            movingBackward: false,
            rangeNorm: prev[rangeNormKey] ?? 0,
            extensionNorm: distToShoulder / norm,
            triggerNorm: 0,
            restNorm: (rest / norm),
            reasons: ["torso moving — hold steady"],
            active: prev[punchFlagKey] || false,
          };
          if (side === "left") setLeftDebug(dbg); else setRightDebug(dbg);
          if (side === "left") { prev.left = cur; prev.leftDistToShoulder = distToShoulder; } else { prev.right = cur; prev.rightDistToShoulder = distToShoulder; }
          continue;
        }

        // Noise-aware rest update (prevents drift)
        const noiseKey = side === "left" ? "leftNoiseSpeed" : "rightNoiseSpeed";
        const noisePrev = prev[noiseKey] ?? 0.05;
        const noise = noisePrev * 0.9 + speed * 0.1;
        prev[noiseKey] = noise;

        if (!movingForward || speedFwd < Math.max(0.15, noise * 1.2) || distToShoulder < rest) {
          const alpha = distToShoulder < rest ? 0.6 : 0.03;
          rest += (distToShoulder - rest) * alpha;
        }
        prev[restKey] = rest;

        if (movingForward && distToShoulder > maxExt) {
          maxExt += (distToShoulder - maxExt) * 0.3;
        }
        if (!movingForward) {
          maxExt -= (maxExt - distToShoulder) * 0.02;
        }
        maxExt = Math.max(maxExt, rest + norm * 0.04);
        prev[maxKey] = maxExt;

        const extensionRangeRaw = Math.max(0, maxExt - rest);
        const extensionRange = Math.max(extensionRangeRaw, norm * 0.02);
        prev[rangeNormKey] = extensionRange / norm;

        const punchActive = prev[punchFlagKey] || false;
        const rangeEnough = extensionRange >= norm * 0.06;
        const speedThreshold = Math.max(0.6, 0.5 + (extensionRange / norm) * 1.2);
        // Make trigger easier initially; tighten as range builds
        const rangeNorm = extensionRange / norm;
        const triggerGain = rangeNorm < 0.06 ? 0.5 : rangeNorm < 0.1 ? 0.6 : 0.65;
        const triggerDist = rest + extensionRange * triggerGain;
        const resetDist = rest + extensionRange * 0.25;
        const currentPower = speedFwd * Math.max(0.4, Math.min(1.6, distToShoulder / norm));

        const cooldownKey = side === "left" ? "leftCooldownUntil" : "rightCooldownUntil";
        const inCooldown = (prev[cooldownKey] ?? 0) > now;
        if (!punchActive && !inCooldown && rangeEnough && movingForward && speedFwd >= speedThreshold && distToShoulder >= triggerDist) {
          potentialPunches.push({ side, speed: speedFwd, power: currentPower });
          prev[punchFlagKey] = true;
          prev[cooldownKey] = now + 250;
        }

        if (punchActive && (movingBackward || distToShoulder <= resetDist)) {
          prev[punchFlagKey] = false;
        }

        if (side === "left") {
          prev.left = cur;
          prev.leftDistToShoulder = distToShoulder;
          setLeftStats((s) => ({ ...s, lastSpeed: speedFwd, lastPower: currentPower }));
        } else {
          prev.right = cur;
          prev.rightDistToShoulder = distToShoulder;
          setRightStats((s) => ({ ...s, lastSpeed: speedFwd, lastPower: currentPower }));
        }

        const triggerDelta = triggerDist - rest;
        let completion = triggerDelta > 1e-4 ? Math.max(0, Math.min(1, (distToShoulder - rest) / triggerDelta)) : 0;
        if (!movingForward && speedFwd < 0.1) completion = 0;
        const reasons: string[] = [];
        if (punchActive) {
          reasons.push("Punch active – retract to reset");
        } else {
          if (!rangeEnough) reasons.push(`Range ${(extensionRange / norm * 100).toFixed(0)}% < ${(0.06*100).toFixed(0)}%`);
          if (!movingForward) reasons.push("Not moving forward");
          if (speedFwd < speedThreshold) reasons.push(`Speed ${speedFwd.toFixed(2)} < ${speedThreshold.toFixed(2)}`);
          if (distToShoulder < triggerDist) reasons.push("Need more reach");
        }
        if (!reasons.length) reasons.push("Ready to strike");

        const debug: HandDebug = {
          completion,
          speed: speedFwd,
          speedThreshold,
          movingForward,
          movingBackward,
          rangeNorm: extensionRange / norm,
          extensionNorm: distToShoulder / norm,
          triggerNorm: triggerDist / norm,
          restNorm: rest / norm,
          reasons,
          active: punchActive,
        };

        if (side === "left") setLeftDebug(debug);
        else setRightDebug(debug);
      }

      if (!prev.calibrated) {
        const leftRange = prev.leftRangeNorm ?? 0;
        const rightRange = prev.rightRangeNorm ?? 0;
        const collecting = leftRange > 0.08 || rightRange > 0.08;
        if (leftRange > 0.18 || rightRange > 0.18) {
          prev.calibrated = true;
          setCalibrationStatusSafe("complete");
        } else {
          setCalibrationStatusSafe(collecting ? "collecting" : "waiting");
        }
      }

      if (potentialPunches.length > 0) {
        const punches = potentialPunches.length === 1
          ? potentialPunches
          : [potentialPunches.reduce((best, current) => (current.power > best.power ? current : best))];

        for (const punch of punches) {
          const distToShoulder = punch.side === "left"
            ? distance({ x: lw.x, y: lw.y }, { x: ls.x, y: ls.y })
            : distance({ x: rw.x, y: rw.y }, { x: rs.x, y: rs.y });

          if (punch.side === "left") {
            pushHistory("left", punch.power);
            const pct = computePercent(punch.power, leftHistoryRef.current);
            setLeftStats((s) => ({ total: s.total + 1, lastSpeed: punch.speed, lastPower: punch.power, lastPercent: pct }));
            prev.leftMaxExtension = Math.max(prev.leftMaxExtension || 0, distToShoulder);
          } else {
            pushHistory("right", punch.power);
            const pct = computePercent(punch.power, rightHistoryRef.current);
            setRightStats((s) => ({ total: s.total + 1, lastSpeed: punch.speed, lastPower: punch.power, lastPercent: pct }));
            prev.rightMaxExtension = Math.max(prev.rightMaxExtension || 0, distToShoulder);
          }
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
  }, [setCalibrationStatusSafe]);

  // derived metrics and helpers
  const leftBaseline = useMemo(() => percentile(leftHistoryRef.current, PERCENTILE), [leftStats.total]);
  const rightBaseline = useMemo(() => percentile(rightHistoryRef.current, PERCENTILE), [rightStats.total]);
  const leftAvg = useMemo(() => {
    const h = leftHistoryRef.current.slice(-AVG_WINDOW);
    if (!h.length) return 0;
    return h.reduce((a, b) => a + b, 0) / h.length;
  }, [leftStats.total]);
  const rightAvg = useMemo(() => {
    const h = rightHistoryRef.current.slice(-AVG_WINDOW);
    if (!h.length) return 0;
    return h.reduce((a, b) => a + b, 0) / h.length;
  }, [rightStats.total]);

  function pctColor(pct: number) {
    if (pct >= 90) return "text-green-600";
    if (pct >= 60) return "text-yellow-600";
    return "text-red-600";
  }

  const leftAvgPct = leftBaseline ? Math.max(0, Math.min(150, Math.round((leftAvg / Math.max(0.001, leftBaseline)) * 100))) : 0;
  const rightAvgPct = rightBaseline ? Math.max(0, Math.min(150, Math.round((rightAvg / Math.max(0.001, rightBaseline)) * 100))) : 0;

  return (
    <div className="flex flex-col gap-3 p-4 border rounded-lg shadow bg-white/50 dark:bg-black/20">
      <h2 className="text-lg font-semibold">Camera: Punch Tracking</h2>
      {error && <div className="text-red-600">Error: {error}</div>}
      {ready && !error && calibrationStatus !== "complete" && (
        <div className="text-blue-600 text-sm">
          {calibrationStatus === "waiting"
            ? "Keep both hands visible so the tracker can learn your guard."
            : "Give a couple of full extensions to finish calibration."}
        </div>
      )}
      {ready && !error && calibrationStatus === "complete" && (
        <div className="text-green-600 text-sm">Ready — start throwing punches! (Auto-calibrated)</div>
      )}
      <div className="text-xs text-gray-500">
        Live range — Left: {(prevRef.current?.leftRangeNorm ?? 0).toFixed(2)} · Right: {(prevRef.current?.rightRangeNorm ?? 0).toFixed(2)}
      </div>
      <div className="relative w-full max-w-[1280px]">
        <video ref={videoRef} className="hidden" playsInline muted />
        <canvas ref={canvasRef} className="w-full rounded-lg shadow border" />
        {/* side-of-eye fatigue bars (avg % per side) */}
        <div className="pointer-events-none absolute right-2 top-2 bottom-2 flex flex-col gap-2 items-end">
          <div className="relative h-24 w-2 rounded overflow-hidden border border-black/10 shadow-sm">
            <div className="absolute inset-0 bg-gradient-to-t from-red-500 via-yellow-500 to-green-500 opacity-80" />
            <div className="absolute left-0 right-0 h-[2px] bg-black/90" style={{ top: `${100 - Math.max(0, Math.min(100, leftAvgPct))}%` }} />
          </div>
          <div className="relative h-24 w-2 rounded overflow-hidden border border-black/10 shadow-sm">
            <div className="absolute inset-0 bg-gradient-to-t from-red-500 via-yellow-500 to-green-500 opacity-80" />
            <div className="absolute left-0 right-0 h-[2px] bg-black/90" style={{ top: `${100 - Math.max(0, Math.min(100, rightAvgPct))}%` }} />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="p-3 rounded border">
          <div className="text-sm text-gray-500">Left punches</div>
          <div className="text-2xl font-bold">{leftStats.total}</div>
          <div className="text-xs mt-1">Speed: {leftStats.lastSpeed.toFixed(2)} u/s</div>
          <div className="text-xs">Power: {leftStats.lastPower.toFixed(2)}</div>
          <div className="mt-2">
            <div className="text-xs text-gray-500">Power % vs last {HISTORY_SIZE} (p{Math.round(PERCENTILE * 100)})</div>
            <div className={`text-sm font-semibold ${pctColor(leftStats.lastPercent)}`}>{leftStats.lastPercent}%</div>
            <div className="h-3 w-full rounded bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 relative mt-1">
              <div className="absolute top-0 bottom-0 w-[2px] bg-black/80" style={{ left: `${Math.max(0, Math.min(100, leftStats.lastPercent))}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 mt-1">Baseline: {leftBaseline ? leftBaseline.toFixed(2) : "–"} · Avg({AVG_WINDOW}): {leftAvg ? leftAvg.toFixed(2) : "–"}</div>
          </div>
          <div className="mt-2 space-y-1 text-xs text-gray-500">
            <div>Punch completion: {(leftDebug.completion * 100).toFixed(0)}%</div>
            <div>Speed: {leftDebug.speed.toFixed(2)} / {leftDebug.speedThreshold.toFixed(2)} u/s</div>
            <div>Reach: {(leftDebug.extensionNorm * 100).toFixed(0)}% · Trigger: {(leftDebug.triggerNorm * 100).toFixed(0)}%</div>
            <div>Status: {leftDebug.reasons.join(', ')}</div>
          </div>
        </div>
        <div className="p-3 rounded border">
          <div className="text-sm text-gray-500">Right punches</div>
          <div className="text-2xl font-bold">{rightStats.total}</div>
          <div className="text-xs mt-1">Speed: {rightStats.lastSpeed.toFixed(2)} u/s</div>
          <div className="text-xs">Power: {rightStats.lastPower.toFixed(2)}</div>
          <div className="mt-2">
            <div className="text-xs text-gray-500">Power % vs last {HISTORY_SIZE} (p{Math.round(PERCENTILE * 100)})</div>
            <div className={`text-sm font-semibold ${pctColor(rightStats.lastPercent)}`}>{rightStats.lastPercent}%</div>
            <div className="h-3 w-full rounded bg-gradient-to-r from-red-500 via-yellow-500 to-green-500 relative mt-1">
              <div className="absolute top-0 bottom-0 w-[2px] bg-black/80" style={{ left: `${Math.max(0, Math.min(100, rightStats.lastPercent))}%` }} />
            </div>
            <div className="text-[10px] text-gray-500 mt-1">Baseline: {rightBaseline ? rightBaseline.toFixed(2) : "–"} · Avg({AVG_WINDOW}): {rightAvg ? rightAvg.toFixed(2) : "–"}</div>
          </div>
          <div className="mt-2 space-y-1 text-xs text-gray-500">
            <div>Punch completion: {(rightDebug.completion * 100).toFixed(0)}%</div>
            <div>Speed: {rightDebug.speed.toFixed(2)} / {rightDebug.speedThreshold.toFixed(2)} u/s</div>
            <div>Reach: {(rightDebug.extensionNorm * 100).toFixed(0)}% · Trigger: {(rightDebug.triggerNorm * 100).toFixed(0)}%</div>
            <div>Status: {rightDebug.reasons.join(', ')}</div>
          </div>
        </div>
      </div>
      {!ready && !error && (
        <div className="text-gray-600">Initializing camera and model… Allow camera access.</div>
      )}
    </div>
  );
}

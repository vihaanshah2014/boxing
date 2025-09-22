"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";

type Round = {
  round: number;
  work: string;
  moderate: string;
  notes?: string;
};

type Workout = {
  title: string;
  duration_minutes: number;
  equipment: string[];
  workout_structure: {
    sets_per_round: number;
    work_interval_sec: number;
    moderate_interval_sec: number;
    rounds: Round[];
  };
  rest_between_rounds_sec: number;
  style_notes: string[];
  trainer: string;
  channel: string;
};

const WORKOUT_DATA: Workout = {
  title: "Most EFFECTIVE 30 Minute Boxing Heavy Bag HIIT Workout",
  duration_minutes: 30,
  equipment: ["Hand wraps", "Boxing gloves", "Heavy bag (or shadowboxing)"],
  workout_structure: {
    sets_per_round: 3,
    work_interval_sec: 60,
    moderate_interval_sec: 30,
    rounds: [
      {
        round: 1,
        work: "1-1-2 (Jab-Jab-Cross, repeat for 60s max effort)",
        moderate: "Cover 1, Cover 2 (defensive movement, 30s)",
        notes: "Focus on eyes on target and intensity; three sets",
      },
      {
        round: 2,
        work: "2-5-2 (Cross-Uppercut-Cross, repeat for 60s)",
        moderate: "Duck right, duck left (30s)",
        notes: "Aggressive, maintain wrist safety; three sets",
      },
      {
        round: 3,
        work: "3B-2-2B-3 (Lead hook to body-cross-cross to body-lead hook to head)",
        moderate: "Double jab while moving (30s)",
        notes: "Vary levels and remain aggressive; three sets",
      },
      {
        round: 4,
        work: "Freestyle inside (High-intensity work on the inside for 60s)",
        moderate: "Work the outside (longer punches/movement, 30s)",
        notes: "Dig to body/head, stay creative; three sets",
      },
      {
        round: 5,
        work: "4-6-3 (Rear hook-rear uppercut-lead hook, 60s)",
        moderate: "1-2-1-2 (Jab-cross-jab-cross, 30s)",
        notes: "Fast, low, keep hands moving; three sets",
      },
      {
        round: 6,
        work: "Split lunge bag push (with bag at arm’s length, 60s each leg, no gloves)",
        moderate: "Hold lunge (no bag movement, 30s each leg)",
        notes: "Gloves off, back knee 1cm from floor, strong exhale",
      },
    ],
  },
  rest_between_rounds_sec: 15,
  style_notes: [
    "1 minute intense, 30s moderate, repeat sequence 3 times per round",
    "Short rest, high intensity, focus on form and breathing",
    "If no bag, shadowbox with same combinations",
  ],
  trainer: "Nate Bower",
  channel: "NateBowerFitness",
};

type Phase = "prepare" | "work" | "moderate" | "rest" | "done";

type Segment = {
  roundIndex: number; // 0-based
  setIndex: number; // 0-based
  phase: Phase; // work | moderate | rest
  duration: number; // seconds
  label: string; // instruction text
};

function buildSegments(data: Workout): Segment[] {
  const segs: Segment[] = [];
  const sets = data.workout_structure.sets_per_round;
  const workDur = data.workout_structure.work_interval_sec;
  const modDur = data.workout_structure.moderate_interval_sec;
  const rest = data.rest_between_rounds_sec;
  // 20s prepare segment so you can put gloves on and preview what's next
  const first = data.workout_structure.rounds[0];
  segs.push({
    roundIndex: 0,
    setIndex: 0,
    phase: "prepare",
    duration: 20,
    label: `Get Ready — Next: Round 1 · Set 1 · GO: ${first.work}`,
  });
  data.workout_structure.rounds.forEach((r, rIdx) => {
    for (let s = 0; s < sets; s++) {
      segs.push({
        roundIndex: rIdx,
        setIndex: s,
        phase: "work",
        duration: workDur,
        label: r.work,
      });
      segs.push({
        roundIndex: rIdx,
        setIndex: s,
        phase: "moderate",
        duration: modDur,
        label: r.moderate,
      });
    }
    if (rIdx < data.workout_structure.rounds.length - 1) {
      segs.push({
        roundIndex: rIdx,
        setIndex: sets - 1,
        phase: "rest",
        duration: rest,
        label: `Rest ${rest}s — Next: Round ${rIdx + 2}`,
      });
    }
  });
  return segs;
}

function formatTime(s: number) {
  const mm = Math.floor(s / 60).toString().padStart(2, "0");
  const ss = Math.floor(s % 60).toString().padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function WorkoutTimer() {
  const data = WORKOUT_DATA;
  const segments = useMemo(() => buildSegments(data), [data]);
  const [idx, setIdx] = useState<number>(-1); // -1 = not started
  const [remaining, setRemaining] = useState<number>(0);
  const [running, setRunning] = useState<boolean>(false);
  const [typed, setTyped] = useState<string>("");

  const rafRef = useRef<number>(0);
  const lastTickRef = useRef<number>(0);
  const idxRef = useRef<number>(-1);

  const current = idx >= 0 ? segments[idx] : null;
  const totalSegments = segments.length;
  const overallProgress = ((idx + (current ? 1 - remaining / current.duration : 0)) / totalSegments) * 100;

  // typewriter effect
  useEffect(() => {
    if (!current) return;
    let i = 0;
    setTyped("");
    const text = current.label;
    let active = true;
    function step() {
      if (!active) return;
      i = Math.min(i + 2, text.length); // 2 chars per tick
      setTyped(text.slice(0, i));
      if (i < text.length) {
        setTimeout(step, 16 * 2);
      }
    }
    step();
    return () => {
      active = false;
    };
  }, [current?.label]);

  useEffect(() => {
    idxRef.current = idx;
  }, [idx]);

  function start() {
    if (segments.length === 0) return;
    if (idx === -1) {
      setIdx(0);
      setRemaining(segments[0].duration);
    }
    setRunning(true);
  }
  function pause() {
    setRunning(false);
  }
  function reset() {
    setRunning(false);
    setIdx(-1);
    setRemaining(0);
  }
  function skip() {
    if (idx < segments.length - 1) {
      const next = idx + 1;
      setIdx(next);
      setRemaining(segments[next].duration);
    } else {
      setRunning(false);
      setIdx(segments.length);
    }
  }

  useEffect(() => {
    if (!running) return;
    function tick(now: number) {
      if (!running) return;
      if (!lastTickRef.current) lastTickRef.current = now;
      const dt = Math.min(1, (now - lastTickRef.current) / 1000);
      lastTickRef.current = now;

      setRemaining((r) => {
        const nr = r - dt;
        if (nr > 0) return nr;
        // advance exactly one segment and set the next duration atomically
        const next = idxRef.current + 1;
        if (next < segments.length) {
          setIdx(next);
          return segments[next].duration;
        } else {
          setIdx(next);
          setRunning(false);
          return 0;
        }
      });

      rafRef.current = requestAnimationFrame(tick);
    }
    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [running, segments]);

  const phaseColor = current?.phase === "work"
    ? "bg-red-500"
    : current?.phase === "moderate"
    ? "bg-amber-500"
    : current?.phase === "rest"
    ? "bg-blue-500"
    : current?.phase === "prepare"
    ? "bg-purple-600"
    : "bg-emerald-600";
  const phaseText = current?.phase === "work"
    ? "GO"
    : current?.phase === "moderate"
    ? "REST"
    : current?.phase === "rest"
    ? "ROUND REST"
    : current?.phase === "prepare"
    ? "GET READY"
    : "DONE";

  const timeFillPct = current ? Math.max(0, Math.min(100, (remaining / current.duration) * 100)) : 0;
  const nextSegment = idx >= -1 && idx + 1 < segments.length ? segments[idx + 1] : null;
  const nextText = nextSegment
    ? nextSegment.phase === "prepare"
      ? nextSegment.label
      : nextSegment.phase === "work"
      ? `Up Next: GO — ${data.workout_structure.rounds[nextSegment.roundIndex].work}`
      : nextSegment.phase === "moderate"
      ? `Up Next: REST — ${data.workout_structure.rounds[nextSegment.roundIndex].moderate}`
      : nextSegment.phase === "rest"
      ? `Up Next: Round ${nextSegment.roundIndex + 2}`
      : ""
    : "";

  const roundNumber = current ? data.workout_structure.rounds[current.roundIndex].round : null;
  const setNumber = current ? current.setIndex + 1 : null;

  const isPrepare = current?.phase === "prepare";
  const instructionsText = current
    ? isPrepare && nextSegment
      ? nextSegment.phase === "work"
        ? `Next: GO — ${data.workout_structure.rounds[nextSegment.roundIndex].work}`
        : nextSegment.phase === "moderate"
        ? `Next: REST — ${data.workout_structure.rounds[nextSegment.roundIndex].moderate}`
        : nextSegment.phase === "rest"
        ? `Next: Round ${nextSegment.roundIndex + 2}`
        : current.label
      : (typed || current.label)
    : "Press Start to begin";

  return (
    <div className="flex flex-col gap-3 p-4 border rounded-lg shadow bg-white/50 dark:bg-black/20">
      <div className="flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold">{data.title}</h2>
        <div className="text-xs text-gray-500">Coach: {data.trainer} · {data.channel}</div>
      </div>

      <div className="text-xs text-gray-600">Equipment: {data.equipment.join(", ")}</div>

      <div className="relative overflow-hidden rounded-lg border">
        <div className={`h-2 ${phaseColor}`} style={{ width: `${Math.max(0, Math.min(100, overallProgress))}%`, transition: "width 0.25s linear" }} />
      </div>

      {/* MASSIVE Timer - full width of the column */}
      <div className="relative w-full rounded-lg border overflow-hidden flex items-center justify-center h-[42vh] md:h-[50vh] lg:h-[56vh]">
        {/* Fading background fill for time remaining */}
        <div className="absolute inset-0">
          <div className="absolute inset-0" style={{ background: "linear-gradient(to top, rgba(0,0,0,0.08), transparent)" }} />
          <div className={`absolute bottom-0 left-0 right-0 ${phaseColor} opacity-30`} style={{ height: `${timeFillPct}%`, transition: "height 0.2s linear" }} />
        </div>
        <div className="relative flex flex-col items-center gap-3 py-4">
          <div className="text-sm text-gray-600">{isPrepare ? "Starting In" : "Time"}</div>
          <div className="font-extrabold tabular-nums drop-shadow-sm text-[18vw] sm:text-[14vw] md:text-[10vw] lg:text-[8vw] xl:text-[7vw] leading-none">
            {current ? formatTime(remaining) : idx >= segments.length ? "00:00" : formatTime(segments[0].duration)}
          </div>
          {isPrepare && !!nextText && (
            <div className="text-xs text-gray-600">{nextText}</div>
          )}
        </div>
      </div>

      {/* Phase + Instructions - full width below */}
      <div className="flex flex-col gap-3">
        <div className="flex items-baseline gap-3">
          <div className={`text-5xl md:text-6xl font-extrabold tracking-wide ${current ? "" : "opacity-60"}`}>{phaseText}</div>
          {current && !isPrepare && (
            <div className="text-sm text-gray-500">Round {roundNumber} · Set {setNumber} / {data.workout_structure.sets_per_round}</div>
          )}
        </div>
        <div className="p-4 rounded-md border bg-black/5 dark:bg-white/5 min-h-[112px]">
          <div className="font-mono text-base md:text-lg whitespace-pre-wrap break-words">
            {instructionsText}
          </div>
        </div>
        {!!nextText && !isPrepare && (
          <div className="text-sm text-gray-500">{nextText}</div>
        )}
      </div>

      <div className="flex gap-2">
        {!running ? (
          <button onClick={start} className="px-4 py-2 rounded bg-emerald-600 text-white disabled:opacity-50" disabled={idx >= segments.length}>
            {idx === -1 ? "Start" : idx >= segments.length ? "Finished" : "Resume"}
          </button>
        ) : (
          <button onClick={pause} className="px-4 py-2 rounded bg-gray-800 text-white">Pause</button>
        )}
        <button onClick={reset} className="px-4 py-2 rounded border">Reset</button>
        <button onClick={skip} className="px-4 py-2 rounded border" disabled={!current}>Skip</button>
      </div>

      <div className="text-xs text-gray-500">
        Style: {data.style_notes.join(" · ")}
      </div>
    </div>
  );
}

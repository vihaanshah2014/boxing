"use client";

import WorkoutTimer from "../components/WorkoutTimer";
import CameraPunchTracker from "../components/CameraPunchTracker";

export default function Home() {
  return (
    <div className="min-h-screen p-6 sm:p-10">
      <header className="mb-6">
        <h1 className="text-3xl font-bold">Boxing: Camera + HIIT Workout</h1>
        <div className="text-sm text-gray-600 mt-1">Grant camera access, then start the timer.</div>
      </header>
      <main className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <CameraPunchTracker />
        <WorkoutTimer />
      </main>
    </div>
  );
}

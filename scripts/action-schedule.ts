#!/usr/bin/env bun
// Minimal source-checkout entrypoint: avoid loading the full VoltMind CLI graph.
import { runActionSchedule } from '../src/commands/action-schedule.ts';

try {
  await runActionSchedule(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}

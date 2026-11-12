#!/usr/bin/env node
import { RuntimeSafetyError, verifyRuntimeSafety } from "../src/runtime-safety.js";

try {
  console.log(JSON.stringify(verifyRuntimeSafety(), null, 2));
} catch (error) {
  console.error(JSON.stringify({
    safe: false,
    code: error instanceof RuntimeSafetyError ? error.code : "RUNTIME_CHECK_FAILED",
    error: error.message,
    details: error.details ?? {},
  }, null, 2));
  process.exitCode = 1;
}

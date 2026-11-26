import { resolve } from "node:path";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function absolutePath(value: unknown): unknown {
  // Leave malformed input to the protocol validator, including an empty path.
  return typeof value === "string" && value.length > 0 ? resolve(value) : value;
}

function anchorLaunch(launch: unknown, explicitCwd?: string): unknown {
  if (!isRecord(launch)) return launch;
  const cwd = explicitCwd ?? launch.cwd;
  return { ...launch, cwd: cwd === undefined ? process.cwd() : absolutePath(cwd) };
}

function anchorCompare(options: unknown): unknown {
  if (!isRecord(options)) return options;
  return { ...options, baseline: absolutePath(options.baseline) };
}

function anchorSpecification(value: unknown, method: "scenario" | "perf", explicitCwd?: string): unknown {
  if (!isRecord(value)) return value;
  const specification = { ...value, launch: anchorLaunch(value.launch, explicitCwd) };
  if (method !== "scenario" || !Array.isArray(value.steps)) return specification;
  const steps = value.steps.map((step: unknown) =>
    isRecord(step) && step.type === "compare" ? { ...step, options: anchorCompare(step.options) } : step
  );
  return { ...specification, steps };
}

/** Resolve client-side paths before crossing into the shared daemon's working directory. */
export function anchorRequestPaths(method: string, params: unknown, explicitCwd?: string): unknown {
  if (!isRecord(params)) return params;
  switch (method) {
    case "launch":
      return anchorLaunch(params, explicitCwd);
    case "replay":
      return { ...params, path: absolutePath(params.path) };
    case "compare":
      return { ...params, options: anchorCompare(params.options) };
    case "scenario":
      return { ...params, specification: anchorSpecification(params.specification, method, explicitCwd) };
    case "perf":
      return {
        ...params,
        specification: anchorSpecification(params.specification, method, explicitCwd),
        ...(params.baseline === undefined ? {} : { baseline: absolutePath(params.baseline) }),
        ...(params.writeBaseline === undefined ? {} : { writeBaseline: absolutePath(params.writeBaseline) }),
      };
    default:
      return params;
  }
}

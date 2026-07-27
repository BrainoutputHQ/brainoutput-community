// BrainOutput Community Edition — department templates with per-department capability defaults.
// Each department can default its capability slots to different models; agents (durable roles)
// reference the slots, and the user overrides the model assignments. On-demand execution only.
export const DEPARTMENT_TEMPLATES = {
  "executive":         { defaults: { planner: "reasoning-premium", reviewer: "high-trust-review" } },
  "technical":         { defaults: { planner: "reasoning-premium", worker: "coding-free", reviewer: "high-trust-review" } },
  "customer-service":  { defaults: { planner: "reasoning-free", worker: "multilingual", reviewer: "private-local" } },
  "sales":             { defaults: { planner: "reasoning-free", worker: "fast-cheap" } },
  "marketing":         { defaults: { planner: "reasoning-free", worker: "fast-cheap", vision: "vision" } },
  "finance":           { defaults: { planner: "private-local", worker: "fast-cheap", vision: "vision", reviewer: "high-trust-review" } },
  "human-resources":   { defaults: { planner: "reasoning-free", worker: "fast-cheap", reviewer: "private-local" } },
  "legal-compliance":  { defaults: { planner: "private-local", reviewer: "high-trust-review" } },
  "operations":        { defaults: { planner: "reasoning-free", worker: "fast-cheap" } },
  "data-research":     { defaults: { planner: "reasoning-free", worker: "long-context", embeddings: "embeddings" } },
};
// All departments deploy DORMANT-by-default. Execution context is created only when work exists.
export const ACTIVATION_DEFAULT = "dormant";

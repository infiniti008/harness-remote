import { createHash } from "node:crypto"

// Exact dist/index.js from the checksum-verified codex-acp 1.13.1 archive. A vendor update
// must be reviewed against its real native request path; an unmatched bundle fails closed.
export const CODEX_ADAPTER_SHA256 = "4c1f6c00e67c2ace5a96f0e0fe6e812502a48827a403014d4b68373464f55fce"

export function hardenCodexAdapter(source) {
  if (createHash("sha256").update(source).digest("hex") !== CODEX_ADAPTER_SHA256) {
    throw new Error("Unsupported Codex ACP bundle: native permission policy was not installed")
  }
  const replace = (before, after) => {
    if (source.split(before).length !== 2) throw new Error("Codex native policy patch does not match its pinned adapter")
    source = source.replace(before, after)
  }
  // Protect startup as well as per-thread and per-turn overrides. In particular the adapter's
  // normal Agent mode uses auto_review, which can approve native escalation without ACP asking.
  replace('spawn(codexPath, ["app-server"], { env: spawnEnv })',
    'spawn(codexPath, ["-c", \'approval_policy="never"\', "-c", \'approvals_reviewer="user"\', "-c", \'sandbox_mode="workspace-write"\', "app-server"], { env: spawnEnv })')
  const start = source.indexOf("  static ReadOnly = new _AgentMode(")
  const end = source.indexOf("  toSessionMode() {", start)
  if (start < 0 || end < start) throw new Error("Codex mode policy patch is missing")
  source = source.slice(0, start) + `  static ReadOnly = new _AgentMode(
    "read-only", "Workspace", "Workspace access; sandbox escalation is disabled",
    "standard", "never", "user",
    { type: "workspaceWrite", writableRoots: [], networkAccess: false,
      excludeTmpdirEnvVar: true, excludeSlashTmp: true }, "workspace-write"
  );
  static DEFAULT_AGENT_MODE = _AgentMode.ReadOnly;
` + source.slice(end)
  replace("return [_AgentMode.ReadOnly, _AgentMode.Agent, _AgentMode.AgentFullAccess];", "return [_AgentMode.ReadOnly];")

  replace("  async sendRequest(request) {\n    for (const callback of this.codexEventHandlers)", `  async sendRequest(request) {
    if (["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(request.method)) {
      const params = { ...request.params, approvalPolicy: "never", approvalsReviewer: "user" };
      if (request.method === "turn/start") {
        params.sandboxPolicy = { type: "workspaceWrite", writableRoots: [], networkAccess: false,
          excludeTmpdirEnvVar: true, excludeSlashTmp: true };
      } else {
        params.sandbox = "workspace-write";
        params.config = { ...params.config, approval_policy: "never", approvals_reviewer: "user",
          sandbox_mode: "workspace-write", sandbox_workspace_write: {
            writable_roots: [], network_access: false, exclude_tmpdir_env_var: true, exclude_slash_tmp: true
          } };
      }
      request = { ...request, params };
    }
    for (const callback of this.codexEventHandlers)`)
  // Defense in depth: never grant an unsolicited native permission request, even if an
  // implementation regression or a future native version emits one under approvalPolicy=never.
  for (const kind of ["CommandExecutionApprovalRequest", "FileChangeApprovalRequest"]) {
    replace(`this.connection.onRequest(${kind}, async (params) => {`,
      `this.connection.onRequest(${kind}, async (params) => { return { decision: "decline" };`)
  }
  replace("this.connection.onRequest(PermissionsApprovalRequest, async (params) => {",
    'this.connection.onRequest(PermissionsApprovalRequest, async (params) => { return { permissions: {}, scope: "turn", strictAutoReview: false };')
  // A native crash/OOM must release the ACP owner's process group, rather than leave a live
  // adapter with a dead connection and native/MCP descendants. Planned provider replacement
  // increments codexProcessGeneration before exiting, so it still follows the vendor path.
  replace('      void this.finishAllAsyncTasks("failed", "after the Codex process exited");',
    '      process.stderr.write("Native Codex app-server exited; closing its ACP process group\\n"); process.exit(1);')
  // Reuse the existing, authenticated app-server connection. No additional Codex process,
  // login, model call or session is needed to read account limits.
  replace('.connect(acpJsonStream);', `.onRequest("_account/rate_limits", emptyExtensionParamsParser, async () => {
    return await getAgent().codexAcpClient.appServerClient.accountRateLimitsRead();
  }).connect(acpJsonStream);`)
  return source
}
